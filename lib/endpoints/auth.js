/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var assert = require('assert-plus');
var drc = require('docker-registry-client');
var fmt = require('util').format;
var restify = require('restify');

var common = require('../common');
var errors = require('../errors');



/**
 * POST /auth
 *
 * However, those docs don't accurately describe fully how `docker login`
 * uses the endpoint.
 *
 * Status Codes:
 *  401     Results in `docker login` removing those creds from
 *          ~/.docker/config.json
 *  err     Any other error status code (<200, >=400) is returned.
 *  other   Any other status code (>=200, <400) is treated as success.
 *
 * See:
 * - docker.git:registry/auth.go#Login
 * // JSSTYLED
 * - https://github.com/docker/docker/blob/master/docs/reference/api/docker_remote_api_v1.24.md#check-auth-configuration
 */
function auth(req, res, next) {
    var log = req.log;

    // Validate inputs.
    var errs = [];
    if (req.body.serveraddress === undefined) {
        errs.push('missing "serveraddress"');
    }
    if (req.body.username === undefined) {
        errs.push('missing "username"');
    }
    if (req.body.password === undefined) {
        errs.push('missing "password"');
    }
    if (errs.length) {
        return next(new errors.ValidationError(errs.join(', ')));
    }

    drc.login(common.httpClientOpts({
        indexName: req.body.serveraddress,
        log: log,
        insecure: req.app.config.dockerRegistryInsecure,
        // auth info:
        username: req.body.username,
        password: req.body.password,
        // `email` is optional (required for *v1* Registry API)
        email: req.body.email
    }, req), function (err, result) {
        if (err) {
            next(err);
        } else {
            var body = {
                Status: result.status
            };
            res.send(body);
            next();
        }
    });
}



/**
 * Register all endpoints with the restify server
 */
function register(config, http, before) {
    http.post({ path: /^(\/v[^\/]+)?\/auth$/, name: 'Auth' },
        before, restify.bodyParser(), auth);
}



module.exports = {
    register: register
};
