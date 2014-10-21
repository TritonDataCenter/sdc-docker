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
 * GET /containers/json
 */
function listContainers(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/create
 */
function createContainer(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/json
 */
function inspectContainer(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/top
 */
function topContainer(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/containers/json', name: 'ListContainers' },
        before, listContainers);
    http.post({ path: '/containers/create', name: 'CreateContainer' },
            before, createContainer);
    http.get({ path: '/containers/:id/json', name: 'InspectContainer' },
        before, inspectContainer);
    http.get({ path: '/containers/:id/top', name: 'topContainer' },
        before, topContainer);
}



module.exports = {
    register: register
};
