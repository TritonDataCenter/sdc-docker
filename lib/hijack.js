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
    'POST': [
        new RegExp('\/v[0-9\.]+\/exec\/[a-z0-9]+\/start'),
        new RegExp('\/v[0-9\.]+\/containers\/[a-z0-9]+\/attach')
    ]
};

function canHjiack(req) {
    var hijackRoutes = HIJACK_ROUTES[req.method];
    if (!hijackRoutes) {
        return false;
    }

    // Can't hijack new 1.17 requests since they are already handled by http.js
    if (req.upgrade === true) {
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

    socket.on('close', function () {
        log.trace('Client connection closed');
    });

    parser.execute = function (d, start, end) {
        var ret = execute.call(this, d, start, end);

        if (parser.incoming && canHjiack(parser.incoming)) {
            parser.incoming.upgrade = true;
            return (ret instanceof Error) ? ret.bytesParsed : ret;
        } else {
            return ret;
        }
    };
}

/*
 * Newer hijack employs a regular connection: upgrade handshake
 */
function isNewHijack(req) {
    var connection = req.header('connection');
    var upgrade = req.header('upgrade');

    return (connection && connection.toLowerCase() === 'upgrade'
        && upgrade && upgrade.toLowerCase() === 'tcp');
}


/*
 * Node doesn't really support half-close connections with tls, but
 * docker insists upon them. We override the onread implementations for
 * connections that have been hijacked
 */
function setHalfClose(log, req, socket) {
    var oldread = socket.socket._handle.onread;
    socket.socket._handle.onread = halfCloseRead;

    function halfCloseRead(buf, offset, len) {
        // cache the errno on the first pass and
        // use that cache value subsequently
        if (!buf && process._errno === 'EOF') {
            log.info('Entered half-close mode for %s', req.url);
        } else {
            oldread.apply(this, arguments);
        }
    }
}


module.exports = {
    hijack: hijack,
    canHjiack: canHjiack,
    isNewHijack: isNewHijack,
    setHalfClose: setHalfClose
};
