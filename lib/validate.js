/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var common = require('./common');
var errors = require('./errors');
var fmt = require('util').format;

var mod_volumes = require('./volumes');

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

var VALID_VOLUME_NAME_REGEXP = /^[a-zA-Z0-9][a-zA-Z0-9_\.\-]+$/;
var VALID_VOLUME_DRIVERS = ['tritonnfs'];

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


function assertArrayOfObject(arg, name) {
    var type = 'an array of objects';
    if (!Array.isArray(arg)) {
        throw typeErr(name, type);
    }

    for (var e in arg) {
        assertObject(e, type);
    }
}


function assertOptionalArrayOfObject(arg, name) {
    if (undef(arg)) {
        return;
    }

    assertArrayOfObject(arg, name);
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

/*
 * Docker docs: Supported standard values are:
 * bridge, host, none, and container:<name|id>,
 * Any other value is taken as a custom network's
 * name or id to which the provisioning container
 * should connect.
 *
 * We support: bridge, other.
 */
function assertNetworkMode(networkMode, name) {
    if (networkMode === 'bridge') {
        return;
    }

    if (networkMode === 'host' || networkMode === 'none') {
        throw new errors.NotImplementedError(
            fmt('NetworkMode %s is not supported', networkMode));
    }

    if (networkMode.match(/^container:/)) {
        throw new errors.NotImplementedError(
            'Container networking is not supported');
    }
}

function assertNetworkingParams(config) {
    if (!config.NetworkMode
        || config.NetworkMode === 'bridge'
        || config.NetworkMode === 'default') {
        return;
    }

    /* BEGIN JSSTYLED */
    /*
     * link behaviour with user-defined networking is not yet
     * supported, see:
     * https://docs.docker.com/v1.10/engine/userguide/networking/work-with-networks/#linking-containers-in-user-defined-networks
     * https://docs.docker.com/v1.10/engine/userguide/networking/default_network/dockerlinks/
     */
    /* END JSSTYLED */
    if (config.Links && config.Links.length > 0) {
        throw new errors.NotImplementedError('user-defined networking links');
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

    if (logconfig.Type && logconfig.Type.length > 0) {
        driver = logconfig.Type;
    } else {
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

function validateBinds(binds) {
    assert.optionalArrayOfString(binds, 'binds');

    var invalidBinds = [];
    binds.forEach(function validateBind(bind) {
        assert.string(bind, 'bind');
        // Each "bind" is expected to be of the form:
        // volumeName:/mount/point[:flags]
        var bindComponents = bind.split(':');
        var volumeName, mountPoint, flags;

        if (bindComponents.length != 2 && bindComponents.length != 3) {
            invalidBinds.push(bind + ': ' + bind + ' is not of the form: '
                + 'volumeName:/mount/point[:flags]');
            return;
        }

        volumeName = bindComponents[0];
        mountPoint = bindComponents[1];

        if (bindComponents.length === 3) {
            flags = bindComponents[2];
        }

        if (!isValidVolumeName(volumeName)) {
            invalidBinds.push(bind + ': ' + volumeName
                + ' is not a valid volume name');
        }

        if (mountPoint.length === 0) {
            invalidBinds.push(bind + ': ' + mountPoint
                + ' must be a non-empty string');
        }

        if (flags !== undefined && flags !== 'ro' && flags !== 'rw') {
            if (flags === '') {
                invalidBinds.push(bind + ': an empty flag is not a valid flag');
            } else {
                invalidBinds.push(bind + ': "' + flags + '" is not a valid '
                    + 'flag');
            }
        }
    });

    return invalidBinds;
}

function assertNetworkIPAMSubnet(network) {
    if (typeof (network) !== 'object'
        || typeof (network.IPAM) !== 'object'
        || !Array.isArray(network.IPAM.Config)
        || network.IPAM.Config.length === 0) {

        throw new errors.ValidationError('network subnet must be defined');
    }

    // There can be multiple subnets defined, but Triton only supports having
    // one subnet.
    if (network.IPAM.Config.length !== 1) {
        throw new errors.ValidationError(
            'only one network subnet is supported');
    }

    if (typeof (network.IPAM.Config[0]) !== 'object'
        || typeof (network.IPAM.Config[0].Subnet) !== 'string') {

        throw new errors.ValidationError('network subnet must be a string');
    }

    // Note that we don't validate the subnet, that is left to NAPI.
}


// --- Exports



function validateCreateContainer(req, res, next) {
    var binds;
    var config = req.app.config;
    var container = req.body;
    var invalidBinds;
    var volumeNames = [];

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

        assertOptionalArrayOfString(container.HostConfig.Links,
            'HostConfig.Links');
        assertOptionalArrayOfString(container.HostConfig.ExtraHosts,
            'HostConfig.Entrypoint');
        assertOptionalBool(container.HostConfig.PublishAllPorts,
            'HostConfig.PublishAllPorts');
        assertOptionalObject(container.HostConfig.PortBindings,
            'HostConfig.PortBindings');
        assertOptionalObject(container.HostConfig.LogConfig,
            'HostConfig.LogConfig');
        assertOptionalString(container.HostConfig.NetworkMode,
            'HostConfig.NetworkMode');

        if (container.HostConfig.NetworkMode) {
            assertNetworkMode(container.HostConfig.NetworkMode,
                'HostConfig.NetworkMode');
        }

        if (container.Volumes) {
            volumeNames = Object.keys(container.Volumes);

            // Per DOCKER-1023, require volumes to be absolute paths and have at
            // least one non-'/', non-'\0' character after the initial '/'
            volumeNames.forEach(function checkVolumeName(vol) {
                assert.ok(vol.length > 0 && vol[0] === '/',
                    'Invalid volume name "' + vol + '" must start with "/"');
                assert.ok(vol.indexOf('\0') === -1, 'Invalid volume name: '
                    + 'cannot contain \\0');
                assert.ok(vol.search(/[^\/]/) !== -1, 'Invalid volume name: '
                    + 'must contain at least one non-/ character');
            });
        }

        // ensures mutually-compatible networking params.
        assertNetworkingParams(container.HostConfig);

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

    binds = container.Binds
        || container.HostConfig && container.HostConfig.Binds;

    if (binds) {
        invalidBinds = validateBinds(binds);
    }

    if (invalidBinds && invalidBinds.length > 0) {
        return next(new errors.ValidationError('Invalid binds: '
            + invalidBinds.join()));
    }

    return next();
}


function validateCreateNetwork(req, res, next) {
    var network = req.body;

    try {
        // -- Required --

        assertString(network.Name, 'Name');
        assertNetworkIPAMSubnet(network);

        // -- Optional --

        assertOptionalString(network.Driver, 'Driver');
        assertOptionalBool(network.EnableIPv6, 'EnableIPv6');
        assertOptionalObject(network.Labels, 'Labels');
        assertOptionalObject(network.Options, 'Options');

    } catch (assertErr) {
        return next(assertErr);
    }

    return next();
}


function validateArchiveReadStream(req, res, next) {
    try {
        assertString(req.query.path, 'path');
    } catch (assertErr) {
        return next(assertErr);
    }

    next();
}



function validateArchiveWriteStream(req, res, next) {
    try {
        assertString(req.query.path, 'path');
    } catch (assertErr) {
        return next(assertErr);
    }

    next();
}

function isSupportedVolumeDriver(driver) {
    assert.string(driver, 'driver');

    if (driver !== 'tritonnfs') {
        return false;
    } else {
        return true;
    }
}

function isValidVolumeName(name) {
    assert.string(name, 'name');

    return VALID_VOLUME_NAME_REGEXP.test(name);
}

function validateCreateVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');
    assert.object(req.params, 'req.params');

    /*
     * The limit was chosen so that:
     *
     * 1. it's reasonably close to the limit that docker uses for named volumes
     *    (it seems like it uses the maximum file path length, which according
     *    to POSIX at
     *    http://pubs.opengroup.org/onlinepubs/009695399/basedefs/limits.h.html
     *    is 256)
     *
     * 2. it's long enough to allow volume names generated by tools such as
     *    docker-compose (which include a "project name" as a way to namespace
     *    resources) to work
     *
     * 3. It's short enough to constrain the amount of resources used when
     *    processing and storing volume names
     */
    var MAX_VOLUME_NAME_LENGTH = 256;
    var validVolumeSize = false;
    var volumeDriver = req.params.Driver;
    var volumeName = req.params.Name;
    var volumeSize;

    if (req.params.DriverOpts) {
        volumeSize = req.params.DriverOpts.size;
    }

    if (typeof (volumeDriver) !== 'string') {
        next(new errors.ValidationError('volume driver must be a string'));
        return;
    }

    if (volumeDriver !== 'local'
        && VALID_VOLUME_DRIVERS.indexOf(volumeDriver) === -1) {
        next(new errors.ValidationError(volumeDriver
            + ' is not a supported volume driver. Supported volume drivers '
            + 'are: ' + VALID_VOLUME_DRIVERS.join(', ')));
        return;
    }

    /*
     * Docker clients send the empty string as the volume name when users don't
     * specify a volume name on the command line. However, in order to simplify
     * the implementation and to make the distinction between the empty string
     * and the absence of name clearer for downstream services (like VOLAPI),
     * we'll consider that an empty string as a volume name is equivalent to the
     * absence of volume name.
     */
    if (volumeName === '') {
        volumeName = undefined;
    }

    if (volumeName !== undefined) {
        if (typeof (volumeName) !== 'string') {
            next(new errors.ValidationError('volume name must be a string'));
            return;
        }

        if (!isValidVolumeName(volumeName)) {
            next(new errors.ValidationError(volumeName
                + ' is not a valid volume name'));
            return;
        }

        if (volumeName.length > MAX_VOLUME_NAME_LENGTH) {
            next(new errors.ValidationError('volume name is too long'));
            return;
        }
    }

    if (volumeSize !== undefined) {
        if (typeof (volumeSize) === 'string') {
            try {
                mod_volumes.parseVolumeSize(volumeSize);
                validVolumeSize = true;
            } catch (parseVolumeSizeErr) {
            }
        }
    } else {
        validVolumeSize = true;
    }

    if (!validVolumeSize) {
        next(new errors.ValidationError('Volume size: "' + volumeSize + '" is '
            + 'not a valid volume size'));
    }

    next();
}

function validateDeleteVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');
    assert.object(req.params, 'req.params');

    var volumeName = req.params.name;

    if (!isValidVolumeName(volumeName)) {
        next(new errors.ValidationError(volumeName
            + ' is not a valid volume name'));
        return;
    }

    next();
}

function validateInspectVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');
    assert.object(req.params, 'req.params');

    var volumeName = req.params.name;

    if (!isValidVolumeName(volumeName)) {
        next(new errors.ValidationError(volumeName
            + ' is not a valid volume name'));
        return;
    }

    next();
}

module.exports = {
    assert: {
        portBindings: assertPortBindings
    },
    createContainer: validateCreateContainer,
    createNetwork: validateCreateNetwork,
    archiveReadStream: validateArchiveReadStream,
    archiveWriteStream: validateArchiveWriteStream,
    createVolume: validateCreateVolume,
    deleteVolume: validateDeleteVolume,
    inspectVolume: validateInspectVolume
};
