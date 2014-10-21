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
 * GET /containers/json
 */
function getContainersJson(req, res, next) {
    return next(new restify.RestError('Not implemented'));
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/containers/json', name: 'GetContainersJson' },
        before, getContainersJson);
}



module.exports = {
    register: register
};
