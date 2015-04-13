/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var errors = require('./errors');
var fmt = require('util').format;



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


function assertString(arg, name) {
    if (typeof (arg) !== 'string') {
        throw typeErr(name, 'a string');
    }
}



// --- Exports



function validateCreateContainer(req, res, next) {
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

        if (container.HostConfig.PortBindings) {
            assertPortBindings(container.HostConfig.PortBindings,
                'HostConfig.PortBindings');
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
