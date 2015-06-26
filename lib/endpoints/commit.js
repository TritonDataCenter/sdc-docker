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
 * POST /commit
 */
function commit(req, res, next) {
    return next(new errors.NotImplementedError('commit'));
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.post({ path: /^(\/v[^\/]+)?\/commit$/, name: 'Commit' },
        before, commit);
}



module.exports = {
    register: register
};
