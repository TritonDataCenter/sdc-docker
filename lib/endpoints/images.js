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
    options.clientApiVersion = req.clientApiVersion;
    options.filters = req.query.filters;
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
     * docker pull -a foo     ->  fromImage=foo
     * docker pull foo        ->  fromImage=foo:latest
     * docker pull foo@DIGEST ->  fromImage=foo@DIGEST
     * docker pull ???        ->  fromImage=???&tag=???  # When is 'tag' used?
     *
     * `parseRepoAndRef` will default tag="latest" if no tag is given, so
     * we unwind that to detect 'docker pull -a ...'.
     */
    try {
        var rat = drc.parseRepoAndRef(req.query.fromImage);
    } catch (e) {
        next(new errors.DockerError(e, e.toString()));
        return;
    }
    if (rat.digest) {
        next(new errors.NotImplementedError('"docker pull" by @DIGEST'));
        return;
    }
    // TODO(DOCKER-587): is this `all = ...` accurate with digest in play?
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
 * Note: req.image is already populated by the reqImage() handler.
 */
function imageHistory(req, res, next) {
    req.backend.getImageHistory({
        app: req.app,
        account: req.account,
        img: req.image,
        log: req.log
    }, function (histErr, history) {
        if (histErr) {
            next(histErr);
            return;
        }
        var historyItems = history.map(
            function (i) { return i.toHistoryItem(); });
        res.send(historyItems);
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
 *
 * Note: req.image is already populated by the reqImage() handler.
 */
function imageTag(req, res, next) {
    // Create name string in format 'repo:tag'
    var repoAndTag = req.query.repo || '';
    if (req.query.tag) {
        repoAndTag += ':' + req.query.tag;
    }

    try {
        var rat = drc.parseRepoAndTag(repoAndTag);
    } catch (e) {
        next(new errors.DockerError(e, e.message));
        return;
    }

    // DOCKER-748: Ensure the tag and the image are in the same repository.
    if (req.image.index_name !== rat.index.name) {
        next(new errors.DockerError(format(
            'Cannot create tag reference between different registries (%s, %s)',
            req.image.index_name, rat.index.name)));
        return;
    }

    req.backend.tagImage({
        docker_id: req.image.docker_id,
        name: repoAndTag,
        req: req
    }, function (err, history) {
        if (err) {
            req.log.error({err: err}, 'backend.imageTag failed');
            next(err);
            return;
        }
        res.status(201);  // Okay - tag was created.
        res.end();
        next();
    });
}


/**
 * DELETE /images/:name
 */
function imageDelete(req, res, next) {
    req.backend.deleteImage({
        app: req.app,
        log: req.log,
        req_id: req.getId(),
        account: req.account,
        name: req.params.name,
        force: common.boolFromQueryParam(req.query.force)
    }, function (err, history) {
        if (err) {
            req.log.error({err: err}, 'backend.imageDelete failed');
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
 * Examples for TERM (optionally includes a registry):
 *      busybox
 *      quay.io/foo
 *      localhost:5000/blah/bling
 */
function imageSearch(req, res, next) {
    var log = req.log;

    try {
        var repo = drc.parseRepo(req.query.term);
    } catch (parseErr) {
        return next(new errors.ValidationError(parseErr, parseErr.message));
    }

    /*
     * Per docker.git:registry/config.go#RepositoryInfo.GetSearchTerm()
     * avoid the "library/" auto-prefixing done for the "official" index.
     * Basically using `parseRepo` for the search arg is a light
     * hack because the term isn't a "repo" string.
     */
    var term = repo.index.official ? repo.localName : repo.remoteName;

    var regClient = drc.createClientV1(common.httpClientOpts({
        name: repo.canonicalName,
        log: log,
        insecure: req.app.config.dockerRegistryInsecure,
        username: req.regAuth && req.regAuth.username,
        password: req.regAuth && req.regAuth.password
    }, req));
    regClient.search({term: term}, function (err, body) {
        regClient.close();
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
function register(config, http, before) {

    function reqParamsName(req, res, next) {
        req.params.name = unescape(req.params[1]);
        next();
    }

    function reqImage(req, res, next) {
        req.backend.imgFromName({
            app: req.app,
            account: req.account,
            log: req.log,
            name: req.params.name
        }, function (err, img) {
            if (err) {
                next(err);
                return;
            }
            if (!img) {
                next(new errors.ResourceNotFoundError(
                    'No such image: ' + req.params.name));
                return;
            }
            req.image = img;
            next();
        });
    }

    http.get({ path: /^(\/v[^\/]+)?\/images\/json$/, name: 'ImageList' },
        before, restify.queryParser({mapParams: false}), imageList);

    http.post({ path: /^(\/v[^\/]+)?\/images\/create$/, name: 'ImageCreate' },
            before, common.checkApprovedForProvisioning,
            restify.queryParser({mapParams: false}), imageCreate);

    /*
     * Match '/:apiversion/images/:name/json' where ':name' can have one
     * or more '/'. IIUC, Docker registry V2 allows multiple '/'s in a
     * repo name.
     */
    http.get(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/json$/, name: 'ImageInspect' },
        reqParamsName, before, imageInspect);

    // Match '/:apiversion/images/:name/history' where ':name' can include '/'.
    http.get(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/history$/,
            name: 'ImageHistory' },
        reqParamsName, before, reqImage, imageHistory);

    // Match '/:apiversion/images/:name/push' where ':name' can include '/'.
    http.post(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/push$/, name: 'ImagePush' },
        reqParamsName, before, imagePush);

    // Match '/:apiversion/images/:name/tag' where ':name' can include '/'.
    http.post(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/tag$/, name: 'ImageTag' },
        reqParamsName, before, reqImage,
        restify.queryParser({mapParams: false}), imageTag);

    // Match '/:apiversion/images/:name' where ':name' can include '/'.
    http.del(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)$/, name: 'ImageDelete' },
        reqParamsName, before,
        restify.queryParser({mapParams: false}), imageDelete);

    http.get({ path: /^(\/v[^\/]+)?\/images\/search$/, name: 'ImageSearch' },
        before, restify.queryParser({mapParams: false}),
        common.reqRegAuth, imageSearch);

    // Match '/:apiversion/images/:name/get' where ':name' can include '/'.
    http.get(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/get$/, name: 'ImageGet' },
        reqParamsName, before, imageGet);

    // Match '/:apiversion/images/:name/load' where ':name' can include '/'.
    http.post(
        { path: /^(\/v[^\/]+)?\/images\/(.*?)\/load$/, name: 'ImageLoad' },
        reqParamsName, before, imageLoad);
}



module.exports = {
    register: register
};
