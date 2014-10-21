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
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /images/create
 */
function imageCreate(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/:name/json
 */
function imageInspect(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
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
    return next(new restify.InvalidVersionError('Not implemented'));
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
    http.get({ path: '/images/json', name: 'ImageList' },
        before, imageList);
    http.post({ path: '/images/create', name: 'ImageCreate' },
            before, imageCreate);
    http.get({ path: '/images/:name/json', name: 'ImageInspect' },
        before, imageInspect);
    http.get({ path: '/images/:name/history', name: 'ImageHistory' },
        before, imageHistory);
    http.post({ path: '/images/:name/push', name: 'ImagePush' },
        before, imagePush);
    http.post({ path: '/images/:name/tag', name: 'ImageTag' },
        before, imageTag);
    http.del({ path: '/images/:name', name: 'ImageDelete' },
        before, imageDelete);
    http.get({ path: '/images/search', name: 'ImageSearch' },
        before, imageSearch);
    http.get({ path: '/images/:name/get', name: 'ImageGet' },
        before, imageGet);
    http.post({ path: '/images/:name/load', name: 'ImageLoad' },
        before, imageLoad);
}



module.exports = {
    register: register
};
