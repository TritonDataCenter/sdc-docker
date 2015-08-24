/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var common = require('./common');
var errors = require('./errors');
var fmt = require('util').format;

/*
 * This determines how large the Config object passed for a log driver can be
 * before we'll reject it as too large. The size is compared after running the
 * config through JSON.stringify(). The value here should be set to something
 * larger than we expect to need but to a value that we'd not mind having in
 * the internal_metadata for a VM. The stringified value will end up as:
 *
 *   docker:logconfig
 *
 */
var MAX_LOG_CONFIG_LEN = 1024;


// --- Internal


function typeErr(name, type) {
    return new errors.ValidationError(fmt('"%s" must be %s', name, type));
}


function undef(arg) {
    if (arg === null || arg === undefined) {
        return true;
    }

    return false;
}


function assertObject(arg, name) {
    if (typeof (arg) !== 'object' || Array.isArray(arg)) {
        throw typeErr(name, 'an object');
    }
}


function assertOptionalArrayOfString(arg, name) {
    if (undef(arg)) {
        return;
    }

    var type = 'an array of strings';
    if (!Array.isArray(arg)) {
        throw typeErr(name, type);
    }

    for (var e in arg) {
        if (typeof (arg[e]) !== 'string') {
            throw typeErr(name, type);
        }
    }
}


function assertOptionalBool(arg, name) {
    if (undef(arg)) {
        return;
    }

    if (typeof (arg) !== 'boolean') {
        throw typeErr(name, 'a boolean');
    }
}


function assertOptionalObject(arg, name) {
    if (undef(arg)) {
        return;
    }

    assertObject(arg, name);
}


function assertOptionalString(arg, name) {
    if (undef(arg)) {
        return;
    }

    assertString(arg, name);
}


/* Ensures <value> exists in <array> */
function assertArrayValue(array, value, name, help) {
    if (array.indexOf(value) === -1) {
        if (help) {
            throw typeErr(name, help);
        } else {
            throw typeErr(name, 'one of: [' + array.join(',') + ']');
        }
    }
}


function assertPositiveInteger(arg, name) {
    if (!arg.match(/^[0-9]+$/) || Number(arg) < 1) {
        throw typeErr(name, 'a positive integer');
    }
}


function assertPositiveIntegerSize(arg, name) {
    if (!arg.match(/^[0-9]+[kmg]$/) || Number(arg.slice(0, -1)) < 1) {
        throw typeErr(name, 'a positive integer size ([0-9+][k|m|g])');
    }
}


function validHost(arg) {
    /*
     * host must be [a-z0-9\-\.] and not:
     *
     *  * start with '-' or '.'
     *  * end with '-' or '.'
     *  * contain two of '-' or '.' in a row
     */
    if (!arg.match(/^[a-z0-9\-\.]+$/)
        || arg.match(/^[\.\-]/)
        || arg.match(/[.\-]$/)
        || arg.match(/[.\-][.\-]/)) {

        return false;
    }

    return true;
}


function assertSyslogAddress(arg, name) {
    var split = arg.split(':');

    function _throwInvalidSyslogAddress(extra) {
        throw typeErr(name, 'a syslog address "<udp|tcp>://<host>[:port]"'
            + (extra ? ' (' + extra + ')' : ''));
    }

    if (split.length < 2 || split.length > 3) {
        _throwInvalidSyslogAddress();
    }

    if (['udp', 'tcp'].indexOf(split[0]) === -1) {
        _throwInvalidSyslogAddress('invalid protocol');
    }

    if (split[1][0] !== '/' || split[1][1] !== '/') {
        _throwInvalidSyslogAddress();
    }

    if (!validHost(split[1].slice(2))) {
        _throwInvalidSyslogAddress('invalid host');
    }

    if (split.length === 3) {
        if (!split[2].match(/^[0-9]+$/)) {
            _throwInvalidSyslogAddress('invalid port');
        }
    }
}


function assertFluentdAddress(arg, name) {
    var split = arg.split(':');

    function throwInvalidFluentdAddress(extra) {
        throw typeErr(name, 'a fluentd address "<host>:<port>"'
            + (extra ? ' (' + extra + ')' : ''));
    }

    if (split.length !== 2) {
        throwInvalidFluentdAddress();
    }

    if (!validHost(split[0])) {
        throwInvalidFluentdAddress('invalid host');
    }

    if (!split[1].match(/^[0-9]+$/) || Number(split[1]) < 1) {
        throwInvalidFluentdAddress('invalid port');
    }
}


function assertGelfAddress(arg, name) {
    var split = arg.split(':');

    function _throwInvalidGelfAddress(extra) {
        throw typeErr(name, 'a gelf address "udp://<host>:<port>"'
            + (extra ? ' (' + extra + ')' : ''));
    }

    if (split.length !== 3) {
        _throwInvalidGelfAddress();
    }

    if (split[0] !== 'udp') {
        _throwInvalidGelfAddress('invalid protocol');
    }

    if (split[1][0] !== '/' || split[1][1] !== '/') {
        _throwInvalidGelfAddress();
    }

    if (!validHost(split[1].slice(2))) {
        _throwInvalidGelfAddress('invalid host');
    }

    if (!split[2].match(/^[0-9]+$/)) {
        _throwInvalidGelfAddress('invalid port');
    }
}


function assertPortBindings(bindings, name) {
    for (var b in bindings) {
        var portNum;
        var split = b.split('/');

        if (split.length !== 2) {
            throw new errors.ValidationError(fmt(
                '%s: port specification incorrect: must be "number/protocol"',
                name));
        }

        portNum = Number(split[0]);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
            throw new errors.ValidationError(fmt('%s: invalid port number',
                name));
        }

        if (split[1] !== 'tcp' && split[1] !== 'udp') {
            throw new errors.ValidationError(fmt(
                '%s: unknown protocol: must be tcp or udp', name));
        }
    }
}


function assertLogConfigOpt(driver, option, value) {
    var help;

    switch (common.LOG_DRIVERS[driver].opts[option]) {
        case 'string':
            assertString(value, fmt('log opt \'%s\'', option));
            break;
        case 'positiveinteger':
            assertPositiveInteger(value, fmt('log opt \'%s\'', option));
            break;
        case 'positiveintegersize':
            assertPositiveIntegerSize(value, fmt('log opt \'%s\'', option));
            break;
        case 'syslogAddress':
            assertSyslogAddress(value, fmt('log opt \'%s\'', option));
            break;
        case 'fluentdAddress':
            assertFluentdAddress(value, fmt('log opt \'%s\'', option));
            break;
        case 'gelfAddress':
            assertGelfAddress(value, fmt('log opt \'%s\'', option));
            break;
        default:
            if (Array.isArray(common.LOG_DRIVERS[driver].opts[option])) {
                if (common.LOG_DRIVERS[driver].opts_help
                    && common.LOG_DRIVERS[driver].opts_help[option]) {

                        help = common.LOG_DRIVERS[driver].opts_help[option];
                } else {
                    help = undefined;
                }
                assertArrayValue(common.LOG_DRIVERS[driver].opts[option], value,
                    fmt('log opt \'%s\'', option), help);
                break;
            }
            throw new errors.InternalError(fmt('unable to validate option '
                + '\'%s\' for %s driver', option, driver));
    }
}


function assertLogConfig(logconfig, name, config) {
    var config_len;
    var driver;
    var driver_config;

    if (!logconfig.hasOwnProperty('Type')) {
        throw new errors.ValidationError(fmt('%s: missing Type', name));
    }

    if (!logconfig.hasOwnProperty('Config')) {
        throw new errors.ValidationError(fmt('%s: missing Config', name));
    }

    driver = logconfig.Type;
    if (driver.length === 0) {
        driver = 'json-file';
    }
    if (logconfig.Config) {
        driver_config = logconfig.Config;
    } else {
        driver_config = {};
    }

    // Disallow entries that are going to be enormous when we stringify them to
    // write to metadata.
    config_len = JSON.stringify(driver_config);
    if (config_len > MAX_LOG_CONFIG_LEN) {
        throw new errors.ValidationError(fmt('value for log opts too long, '
            + 'must be < %d (was %d)', name, MAX_LOG_CONFIG_LEN, config_len));
    }

    if (!config.hasOwnProperty('enabledLogDrivers')
        || (config.enabledLogDrivers.indexOf(driver) === -1)) {

        throw new errors.ValidationError(fmt('unsupported log driver: %s',
            driver));
    }

    if (common.LOG_DRIVERS[driver].required_opts) {
        common.LOG_DRIVERS[driver].required_opts.forEach(function _reqOpt(opt) {
            if (!driver_config[opt]) {
                throw new errors.ValidationError(fmt('missing required log opt '
                    + '\'%s\' for log driver: %s', opt, driver));
            }
        });
    }

    if (common.LOG_DRIVERS[driver].opts) {
        // Ensure all options specified for this driver exist in the
        // LOG_DRIVERS[driver].opts
        Object.keys(driver_config).forEach(function _checkOpt(opt) {
            if (!common.LOG_DRIVERS[driver].opts.hasOwnProperty(opt)) {

                throw new errors.ValidationError(fmt('unknown log opt: \'%s\''
                    + ' for %s driver', opt, driver));
            } else {
                // This is a valid option, ensure it's got the correct value
                assertLogConfigOpt(driver, opt, driver_config[opt]);
            }
        });
    } else if (Object.keys(driver_config).length > 0) {
        throw new errors.ValidationError(fmt('log driver: %s does not support'
            + ' options', driver));
    }
}


function assertString(arg, name) {
    if (typeof (arg) !== 'string') {
        throw typeErr(name, 'a string');
    }
}



// --- Exports



function validateCreateContainer(req, res, next) {
    var config = req.app.config;
    var container = req.body;

    try {
        // -- Required --

        assertString(container.Image, 'Image');
        assertObject(container.HostConfig, 'HostConfig');

        // -- Optional --

        // Name is optional, since if it's not specified, we generate one:
        assertOptionalString(container.Name, 'Name');
        assertOptionalArrayOfString(container.Cmd, 'Cmd');
        assertOptionalArrayOfString(container.Env, 'Env');
        assertOptionalArrayOfString(container.Entrypoint, 'Entrypoint');

        assertOptionalBool(container.HostConfig.PublishAllPorts,
            'HostConfig.PublishAllPorts');
        assertOptionalObject(container.HostConfig.PortBindings,
            'HostConfig.PortBindings');
        assertOptionalObject(container.HostConfig.LogConfig,
            'HostConfig.LogConfig');

        if (container.HostConfig.PortBindings) {
            assertPortBindings(container.HostConfig.PortBindings,
                'HostConfig.PortBindings');
        }

        if (container.HostConfig.LogConfig) {
            assertLogConfig(container.HostConfig.LogConfig,
                'HostConfig.LogConfig', config);
        }

    } catch (assertErr) {
        return next(assertErr);
    }

    return next();
}



module.exports = {
    assert: {
        portBindings: assertPortBindings
    },
    createContainer: validateCreateContainer
};
