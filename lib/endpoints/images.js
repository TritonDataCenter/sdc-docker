/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var drc = require('docker-registry-client');
var format = require('util').format;
var fs = require('fs');
var restify = require('restify');
var vasync = require('vasync');

var common = require('../common');
var writeProgress = common.writeProgress;
var writeStatus = common.writeStatus;
var errors = require('../errors');


// --- globals

var p = console.log; //XXX


// --- endpoint handlers

/**
 * GET /images/json
 */
function imageList(req, res, next) {
    var log = req.log;
    var options = {};

    options.log = req.log;
    options.req_id = req.getId();
    options.app = req.app;
    options.all = common.boolFromQueryParam(req.query.all);
    options.skip_smartos = true;
    options.account = req.account;

    req.backend.listImages(options, function (err, images) {
        if (err) {
            log.error({err: err}, 'Problem loading images');
            next(new errors.DockerError(err, 'problem loading images'));
            return;
        }

        res.send(images);
        next();
    });
}


/**
 * `POST /images/create`, i.e. `docker pull` or `docker import`
 *
 * TODO actual validation: check image data on moray
 * TODO error handling
 */
function imageCreate(req, res, next) {
    // `docker import` is not supported yet
    if (req.query.fromSrc !== undefined) {
        return next(new errors.NotImplementedError('image create'));
    }

    var log = req.log;

    /*
     * docker pull -a foo   ->  fromImage=foo
     * docker pull foo      ->  fromImage=foo:latest
     * docker pull ???      ->  fromImage=???&tag=???    When is 'tag' used?
     *
     * `parseRepoAndTag` will default tag="latest" if no tag is given, so
     * we unwind that to detect 'docker pull -a ...'.
     */
    try {
        var rat = drc.parseRepoAndTag(req.query.fromImage);
    } catch (e) {
        next(new errors.DockerError(e, e.toString()));
        return;
    }
    var all = (!req.query.tag
        && rat.tag && rat.tag === 'latest'
        && req.query.fromImage.slice(-':latest'.length) !== ':latest');
    if (all) {
        next(new errors.NotImplementedError('docker pull -a'));
        return;
    }
    if (req.query.tag) {
        rat.tag = req.query.tag;
    }


    res.status(200);
    res.header('Content-Type', 'application/json');

    req.backend.pullImage({
        app: req.app,
        log: log,
        rat: rat,
        req: req,
        req_id: req.getId(),
        res: res,
        wfapi: req.wfapi,
        account: req.account
    }, function () {
        // XXX NOTHING returned from this??? No 'err'?
        req.app.sockets.removeSocket('job', rat.canonicalName);
        res.end();
        next(false); // XXX need this early abort?
    });
}


/**
 * `GET /images/:name/json`, called eventually from `docker inspect ...`
 *
 * `:name` can be name[:tag] (tag defaults to "latest") or id.
 */
function imageInspect(req, res, next) {
    req.backend.inspectImage({
        app: req.app,
        account: req.account,
        name: req.params.name,
        log: req.log
    }, function (err, image) {
        if (err) {
            next(err);
            return;
        }
        res.send(image);
        next();
    });
}


/**
 * `GET /images/:name/history`, `docker history`
 *
 * `:name` can be name[:tag] (tag defaults to "latest") or id.
 */
function imageHistory(req, res, next) {
    req.backend.getImageHistory({
        app: req.app,
        account: req.account,
        name: req.params.name,
        log: req.log
    }, function (err, history) {
        if (err) {
            next(err);
            return;
        }
        res.send(history);
        next();
    });

}


/**
 * POST /images/:name/push
 */
function imagePush(req, res, next) {
    return next(new errors.NotImplementedError('image push'));
}


/**
 * GET /images/:name/changes
 */
function imageChanges(req, res, next) {
    return next(new errors.NotImplementedError('image changes'));
}


/**
 * GET /images/:name/tag
 */
function imageTag(req, res, next) {
    return next(new errors.NotImplementedError('image tag'));
}


/**
 * DELETE /images/:name
 * DELETE /images/:namespace/:name
 */
function imageDelete(req, res, next) {
    var log = req.log;
    var options = {};
    var force = common.boolFromQueryParam(req.query.force);

    options.log = req.log;
    options.req_id = req.getId();
    options.app = req.app;
    options.account = req.account;
    options.force = force;

    var namespace = req.params.namespace || 'library';

    try {
        options.parsed = drc.parseRepoAndTag(
            namespace + '/' + req.params.name);
    } catch (err) {
        log.error({err: err}, 'imageHistory error');
        next(new errors.DockerError(err, 'imageHistory error'));
        return;
    }

    req.backend.deleteImage(options, function (err, history) {
        if (err) {
            log.error({err: err}, 'backend.imageDelete failed.');
            next(err);
            return;
        }

        res.send(history);
        next();
    });
}


/**
 * `GET /images/search?term=TERM`, `docker search`.
 *
 * Examples for TERM (optionally includes an registry):
 *      busybox
 *      quay.io/foo
 *      localhost:5000/blah/bling
 */
function imageSearch(req, res, next) {
    var log = req.log;
    var repo = drc.parseRepo(req.query.term);

    /*
     * Per docker.git:registry/config.go#RepositoryInfo.GetSearchTerm()
     * avoid the "library/" auto-prefixing done for the "official" index.
     * Basically using `parseRepo` for the search arg is a light
     * hack because the term isn't a "repo" string.
     */
    var term = repo.index.official ? repo.localName : repo.remoteName;

    var reg = drc.createClient({
        name: repo.canonicalName,
        agent: false,
        log: log
    });
    reg.search({term: term}, function (err, body) {
        log.info({repo: repo.canonicalName, term: term, err: err,
            num_results: body && body.num_results}, 'search results');
        if (err) {
            next(err);
            return;
        }
        res.send(body.results);
        next();
    });
}


/**
 * GET /images/:name/get
 */
function imageGet(req, res, next) {
    return next(new errors.NotImplementedError('image get'));
}


/**
 * POST /images/:name/load
 */
function imageLoad(req, res, next) {
    return next(new errors.NotImplementedError('image load'));
}



// --- exports

/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/:apiversion/images/json', name: 'ImageList' },
        before, imageList);
    http.post({ path: '/:apiversion/images/create', name: 'ImageCreate' },
            before, common.checkApprovedForProvisioning, imageCreate);
    http.get({ path: '/:apiversion/images/:name/json', name: 'ImageInspect' },
        before, imageInspect);
    http.get({ path: '/:apiversion/images/:repo/:name/json',
        name: 'ImageInspectWithRepo' }, before, imageInspect);
    http.get({ path: '/:apiversion/images/:name/history',
        name: 'ImageHistory' }, before, imageHistory);
    http.get({ path: '/:apiversion/images/:repo/:name/history',
        name: 'ImageHistoryWithRepo' }, before, imageHistory);
    http.post({ path: '/:apiversion/images/:name/push', name: 'ImagePush' },
        before, imagePush);
    http.post({ path: '/:apiversion/images/:name/tag', name: 'ImageTag' },
        before, imageTag);
    http.del({ path: '/:apiversion/images/:namespace/:name',
        name: 'ImageNamespaceDelete' }, before, imageDelete);
    http.del({ path: '/:apiversion/images/:name', name: 'ImageDelete' },
        before, imageDelete);
    http.get({ path: '/:apiversion/images/search', name: 'ImageSearch' },
        before, imageSearch);
    http.get({ path: '/:apiversion/images/:repo/:name/get',
        name: 'ImageGetWithRepo' }, before, imageGet);
    http.get({ path: '/:apiversion/images/:name/get', name: 'ImageGet' },
        before, imageGet);
    http.post({ path: '/:apiversion/images/:name/load', name: 'ImageLoad' },
        before, imageLoad);
    http.post({ path: '/:apiversion/images/:repo/:name/load',
        name: 'ImageLoadWithRepo' }, before, imageLoad);
}



module.exports = {
    register: register
};
