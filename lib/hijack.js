/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');

var HIJACK_ROUTES = {
    'POST': [ new RegExp('\/v1.15\/exec\/[a-z0-9]+\/start') ]
};

function canHjiack(req) {
    var hijackRoutes = HIJACK_ROUTES[req.method];
    if (!hijackRoutes) {
        return false;
    }

    // Should match only one route
    var matches = hijackRoutes.filter(function (regex) {
        return regex.test(req.url);
    });

    if (!matches.length) {
        return false;
    }

    return true;
}

function hijack(opts) {
    assert.object(opts.socket, 'opts.socket');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var socket = opts.socket;
    var parser = socket.parser;

    // Stash our original parser functions
    var execute = parser.execute;

    // var close = socket._handle.close;
    // socket._handle.close = function() {
    //     log.error('Socket _handle close event with hijack');
    // }

    socket.on('close', function () {
        log.trace('Client connection closed');
    });

    parser.execute = function (d, start, end) {
        var ret = execute.call(this, d, start, end);

        if ((ret instanceof Error) && canHjiack(parser.incoming)) {
            // danger territory
            parser.incoming.upgrade = true;
            return ret.bytesParsed;
        } else {
            log.trace('Skipping hijack');
        }

        return ret;
    };
}

module.exports = {
    hijack: hijack,
    canHjiack: canHjiack
};
