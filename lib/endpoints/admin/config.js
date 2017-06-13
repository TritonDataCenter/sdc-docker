/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');

//
// borrowed from bunyan safeCyclesSet, modified to not dump:
//
//  * buffer contents
//  * bunyan Loggers
//  * passwords
//
function safeCycles() {
    var seen = new Set();

    return function (key, val) {
        if (!val || typeof (val) !== 'object') {
            if (key.match(/password/i)) {
                return '[Password]';
            }
            return val;
        }

        if (seen.has(val)) {
            return '[Circular]';
        }

        if (Buffer.isBuffer(val)) {
            return '[Buffer]';
        }

        if (Array.isArray(val) && val.length > 10) {
            return '[Array ' + val.length + ']';
        }

        if (val.constructor.name === 'Logger') {
            return '[Logger]';
        }

        seen.add(val);
        return val;
    };
}


/**
 * GET /admin/config
 */
function adminGetConfig(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.app, 'req.app');
    assert.object(req.app.config, 'req.app.config');

    var safeConfig = JSON.parse(JSON.stringify(req.app.config, safeCycles()));

    res.send(200, safeConfig);
    next();
}


/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/admin/config', name: 'AdminGetConfig' },
        before, adminGetConfig);
}


module.exports = {
    register: register
};
