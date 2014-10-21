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
    return next(new restify.InvalidVersionError('Not implemented'));
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
