/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');



/**
 * GET /_ping
 */
function ping(req, res, next) {
    var body = 'OK';
    res.writeHead(200, {
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'text/plain; charset=utf-8'
    });
    res.write(body);
    res.end();
    next();
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/_ping', name: 'Ping' },
        before, ping);
}



module.exports = {
    register: register
};
