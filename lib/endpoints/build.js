/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var path = require('path');
var util = require('util');

var restify = require('restify');
var drc = require('docker-registry-client');

var common = require('../common');
var errors = require('../errors');


/**
 * Format the error message - ensures the req_id is in the error string.
 */
function formatErrorMessage(msg, reqId) {
    var newMsg = 'Build failed: ' + msg;
    // Append a request id if none present.
    if (msg.indexOf('req_id:') === -1) {
        newMsg += ' (req_id: ' + reqId + ')';
    }
    return newMsg;
}

/**
 * POST /build
 */
function build(req, res, next) {
    var log = req.log;

    log.debug('req.query: ', req.query);

    var rat = null;
    // Validate the tag.
    if (req.query.t) {
        try {
            rat = drc.parseRepoAndRef(req.query.t);
            log.debug('rat: ', rat);
        } catch (e) {
            next(new errors.DockerError(e, e.toString()));
            return;
        }
    }

    var dockerOpts = {
        buildargs: req.query.buildargs,
        dockerfile: req.query.dockerfile,
        forcerm: common.boolFromQueryParam(req.query.forcerm),
        labels: req.query.labels,
        memory: parseInt(req.query.memory, 10),
        nocache: common.boolFromQueryParam(req.query.nocache),
        rm: common.boolFromQueryParam(req.query.rm),
        tag: req.query.t
    };

    /**
     * Ensure the dockerfile isn't a location outside of the build context.
     * It's done here for the docker/docker TestBuildApiDockerfilePath test
     * case. Note that this check will also happen in the cn-agent build
     * process too.
     */
    if (dockerOpts.dockerfile) {
        dockerOpts.dockerfile = path.normalize(dockerOpts.dockerfile);
        if (dockerOpts.dockerfile.substr(0, 2) === '..') {
            var msg = util.format('Forbidden path outside the build context: '
                + req.query.dockerfile);
            next(new errors.DockerError(msg));
            return;
        }
    }

    /*
     * Node's default HTTP timeout is two minutes, and the client context
     * request can take longer than that to complete.  Set this connection's
     * timeout to an hour to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    res.writeHead(200, { 'Content-Type': 'application/json' });

    req.backend.buildImage({
        dockerOpts: dockerOpts,
        log: log,
        rat: rat,
        req: req,
        req_id: req.getId(),
        res: res,
        wfapi: req.wfapi
    }, function (err) {
        if (err) {
            log.error('docker build error', err);
            var errorMessage = formatErrorMessage(err.message, req.getId());
            var event = {
                error: errorMessage,
                errorDetail: {
                    message: errorMessage
                }
            };
            res.write(JSON.stringify(event) + '\n');
        } else {
            log.debug('docker build finished successfully');
        }

        res.end();
        next(true);
    });
}


/**
 * Register all endpoints with the restify server
 */
function register(config, http, before) {
    http.post({ path: /^(\/v[^\/]+)?\/build$/, name: 'Build' },
        before, restify.queryParser({mapParams: false}), build);
}



module.exports = {
    register: register
};
