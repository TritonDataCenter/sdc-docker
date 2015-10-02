/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var drc = require('docker-registry-client');
var fmt = require('util').format;
var restify = require('restify');

var common = require('../common');
var errors = require('../errors');



/**
 * // JSSTYLED
 * http://docs.docker.com/reference/api/docker_remote_api_v1.18/#check-auth-configuration
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
 * Body:
 *  On successful status codes, a JSON body is parsed and any "Status" field
 *  string value will be printed.
 *
 * See: docker.git:registry/auth.go#Login
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
    if (req.body.email === undefined) {
        errs.push('missing "email"');
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
        email: req.body.email,
        password: req.body.password
    }, req), function (err, result) {
        if (err) {
            next(err);
        } else {
            res.send({Status: result.status});
            next();
        }
    });
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.post({ path: /^(\/v[^\/]+)?\/auth$/, name: 'Auth' },
        before, restify.bodyParser(), auth);
}



module.exports = {
    register: register
};
