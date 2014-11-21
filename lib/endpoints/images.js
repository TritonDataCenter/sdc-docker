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
 * GET /images/json
 */
function imageList(req, res, next) {
    var log = req.log;
    var options = {};

    options.log = req.log;
    options.req_id = req.getId();

    req.backend.listImages(options, function (err, images) {

        log.debug({query: req.query}, 'got query');

        if (err) {
            log.error({err: err}, 'Problem loading images');
            next(new restify.InternalError('Problem loading images'));
            return;
        }

        res.send(images);
        next();
    });
}


/**
 * POST /images/create
 */
function imageCreate(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/:name/json
 *
 * Images can be inspected by name[:tag] or id
 */
function imageInspect(req, res, next) {
    var name = req.params.name;
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.backend.inspectImage({
        name: name,
        app: req.app,
        log: log,
        req_id: req.getId()
    }, function (err, image) {

        if (err) {
            log.error({err: err}, 'backend.imageInspect failed.');
            next(err);
            return;
        }

        res.send(image);
        next();
    });
}


/**
 * GET /images/:name/history
 */
function imageHistory(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /images/:name/push
 */
function imagePush(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/:name/changes
 */
function imageChanges(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/:name/tag
 */
function imageTag(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * DELETE /images/:name
 */
function imageDelete(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/search
 */
function imageSearch(req, res, next) {
    var term = req.query.term;
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.registry.search(term, { log: log }, function (err, images) {
        if (err) {
            log.error({err: err}, 'registry.search failed.');
            next(err);
            return;
        }

        res.send(images.results);
        next();
    });
}


/**
 * GET /images/:name/get
 */
function imageGet(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /images/:name/load
 */
function imageLoad(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}




/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/v1.15/images/json', name: 'ImageList' },
        before, imageList);
    http.post({ path: '/images/create', name: 'ImageCreate' },
            before, imageCreate);
    http.get({ path: '/v1.15/images/:name/json', name: 'ImageInspect' },
        before, imageInspect);
    http.get({ path: '/images/:name/history', name: 'ImageHistory' },
        before, imageHistory);
    http.post({ path: '/images/:name/push', name: 'ImagePush' },
        before, imagePush);
    http.post({ path: '/images/:name/tag', name: 'ImageTag' },
        before, imageTag);
    http.del({ path: '/images/:name', name: 'ImageDelete' },
        before, imageDelete);
    http.get({ path: '/v1.15/images/search', name: 'ImageSearch' },
        before, imageSearch);
    http.get({ path: '/images/:name/get', name: 'ImageGet' },
        before, imageGet);
    http.post({ path: '/images/:name/load', name: 'ImageLoad' },
        before, imageLoad);
}



module.exports = {
    register: register
};
