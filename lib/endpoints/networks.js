/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var restify = require('restify');

var errors = require('../errors');



// ---- endpoint handlers

/**
 * GET /networks
 */
function networkList(req, res, next) {
    var log = req.log;
    var opts = {req: req};

    req.backend.listNetworks(opts, function (err, networks) {
        if (err) {
            if (!(err instanceof errors.DockerError)) {
                log.error({err: err}, 'Problem loading networks');
                err = new errors.DockerError(err, 'problem loading networks');
            }
            next(err);
            return;
        }

        res.send(networks);
        next();
    });
}


/**
 * POST /networks/create
 */
function networkCreate(req, res, next) {
    return next(new errors.NotImplementedError('network create'));
}


/**
 * DELETE /networks/:id
 */
function networkDelete(req, res, next) {
    return next(new errors.NotImplementedError('network rm'));
}


/**
 * GET /networks/:id
 */
function networkInspect(req, res, next) {
    return next(new errors.NotImplementedError('network inspect'));
}


/**
 * POST /networks/:id/connect
 */
function networkConnect(req, res, next) {
    return next(new errors.NotImplementedError('network connect'));
}


/**
 * POST /networks/:id/disconnect
 */
function networkDisconnect(req, res, next) {
    return next(new errors.NotImplementedError('network disconnect'));
}


/**
 * POST /networks/prune
 */
function networkPrune(req, res, next) {
    return next(new errors.NotImplementedError('network prune'));
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {

    function reqParamsId(req, res, next) {
        req.params.id = unescape(req.params[1]);
        next();
    }

    function getNetwork(req, res, next) {
        next();
    }

    var queryParserOpts = {
        mapParams: false,
        // See: https://smartos.org/bugview/ZAPI-744
        allowDots: false,
        plainObjects: false
    };
    var queryParser = restify.queryParser(queryParserOpts);

    // GET '/:apiversion/networks'
    http.get({ path: /^(\/v[^\/]+)?\/networks$/, name: 'NetworkList' },
        before, queryParser, networkList);

    // POST '/:apiversion/networks/create'
    http.post({ path: /^(\/v[^\/]+)?\/networks\/create$/,
        name: 'NetworkCreate' },
        before,
        restify.bodyParser(),
        queryParser,
        networkCreate);

    // DELETE '/:apiversion/networks/:id'
    http.del({ path: /^(\/v[^\/]+)?\/networks\/([^\/]+)$/,
        name: 'NetworkDelete' }, before, reqParamsId, getNetwork,
        networkDelete);

    // GET '/:apiversion/networks/:id'
    http.get({ path: /^(\/v[^\/]+)?\/networks\/([^\/]+)$/,
        name: 'NetworkInspect' }, before, reqParamsId, getNetwork,
        networkInspect);

    // POST '/:apiversion/networks/:id/connect'
    http.post({ path: /^(\/v[^\/]+)?\/networks\/([^\/]+)\/connect$/,
        name: 'NetworkConnect' }, before, reqParamsId, getNetwork,
        networkConnect);

    // POST '/:apiversion/networks/:id/disconnect'
    http.post({ path: /^(\/v[^\/]+)?\/networks\/([^\/]+)\/disconnect$/,
        name: 'NetworkDisconnect' }, before, reqParamsId, getNetwork,
        networkDisconnect);

    // POST '/:apiversion/networks/prune'
    http.post({ path: /^(\/v[^\/]+)?\/networks\/prune$/,
        name: 'NetworkPrune' }, before, networkPrune);
}

module.exports = {
    register: register
};
