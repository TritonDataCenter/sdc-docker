/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var uv = process.binding('uv');

var HIJACK_ROUTES = {
    'POST': [
        new RegExp('\/v[0-9\.]+\/exec\/[a-z0-9]+\/start'),
        new RegExp('\/v[0-9\.]+\/containers\/[a-z0-9]+\/attach')
    ]
};

function canHijack(req) {
    var hijackRoutes = HIJACK_ROUTES[req.method];
    if (!hijackRoutes) {
        return false;
    }

    // Can't hijack new 1.17 requests since they are already handled by http.js
    if (req.upgrade === true) {
        req.hijacked = true;
        return true;
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


/*
 * Node doesn't really support half-close connections with tls, but
 * docker insists upon them. We override the onread implementations for
 * connections that have been hijacked
 */
function setHalfClose(log, req, socket) {
    var oldread = socket._handle.onread;
    socket._handle.onread = halfCloseRead;

    function halfCloseRead(nread, buf) {
        // cache the errno on the first pass and
        // use that cache value subsequently
        if (nread === uv.UV_EOF) {
            log.info('Entered half-close mode for %s', req.url);
        } else {
            oldread.apply(this, arguments);
        }
    }
}


module.exports = {
    canHijack: canHijack,
    setHalfClose: setHalfClose
};
