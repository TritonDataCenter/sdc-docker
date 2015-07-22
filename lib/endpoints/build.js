/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');
var errors = require('../errors');



/**
 * POST /build
 */
function build(req, res, next) {
    return next(new errors.NotImplementedError('build'));
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.post({ path: /^(\/v[^\/]+)?\/build$/, name: 'Build' }, build);
}



module.exports = {
    register: register
};
