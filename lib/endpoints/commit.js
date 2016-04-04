/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var restify = require('restify');

var common = require('../common');
var errors = require('../errors');


/**
 * POST /commit
 *
 * Note: These fields are already populated:
 *   req.params.id (unescaped container id/name)
 *   req.vm (container vmObj)
 */
function commit(req, res, next) {
    var log = req.log;

    // Create name string in format 'repo:tag'
    var repoAndTag = req.query.repo || '';
    if (req.query.tag) {
        repoAndTag += ':' + req.query.tag;
    }

    // There can either be one single change (string) or multiple (array of
    // string) changes - convert to always be an array.
    var changes = req.query.changes || [];
    if (changes && typeof (changes) === 'string') {
        changes = [changes];
    }

    var commitOpts = {
        author: req.query.author,
        changes: changes,
        comment: req.query.comment,
        config: req.body,
        pause: common.boolFromQueryParam(req.query.pause),
        tag: repoAndTag
    };

    log.debug('commit: req.query: ', req.query);

    /*
     * Node's default HTTP timeout is two minutes, and the client context
     * request can take longer than that to complete.  Set this connection's
     * timeout to 10 minutes to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(10 * 60 * 1000);

    req.backend.commitImage(req, commitOpts, function (err, imageId) {
        if (err) {
            res.send(err);
        } else {
            log.debug('docker commit finished successfully');
            // Note: Docker returns sha256: {"Id":"sha256:93c3e0ca32...1453a"}
            res.status(201);  // Okay - image was committed.
            res.write(JSON.stringify({'Id': imageId}) + '\n');
        }

        res.end();
        next();
    });
}



/**
 * Register all endpoints with the restify server
 */
function register(config, http, before) {

    function reqParamsId(req, res, next) {
        req.params.id = req.query.container;
        next();
    }

    http.post({ path: /^(\/v[^\/]+)?\/commit$/, name: 'Commit' },
        before, restify.queryParser({mapParams: false}),
        reqParamsId, common.getVm, commit);

}



module.exports = {
    register: register
};
