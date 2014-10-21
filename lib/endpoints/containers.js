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
function containerList(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/create
 */
function containerCreate(req, res, next) {
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
function containerTop(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/logs
 */
function containerLogs(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/changes
 */
function containerChanges(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/export
 */
function containerExport(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/resize
 */
function containerResize(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/start
 */
function containerStart(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/stop
 */
function containerStop(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/restart
 */
function containerRestart(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/kill
 */
function containerKill(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/pause
 */
function containerPause(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/unpause
 */
function containerUnPause(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/attach
 */
function containerAttach(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/wait
 */
function containerWait(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * DELETE /containers/:id
 */
function containerDelete(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/copy
 */
function containerCopy(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/containers/json', name: 'ContainerList' },
        before, containerList);
    http.post({ path: '/containers/create', name: 'ContainerCreate' },
            before, containerCreate);
    http.get({ path: '/containers/:id/json', name: 'InspectContainer' },
        before, inspectContainer);
    http.get({ path: '/containers/:id/top', name: 'ContainerTop' },
        before, containerTop);
    http.get({ path: '/containers/:id/logs', name: 'ContainerLogs' },
        before, containerLogs);
    http.get({ path: '/containers/:id/export', name: 'ContainerExport' },
        before, containerExport);
    http.get({ path: '/containers/:id/export', name: 'ContainerExport' },
        before, containerExport);
    http.get({ path: '/containers/:id/resize', name: 'ContainerResize' },
        before, containerResize);
    http.post({ path: '/containers/:id/start', name: 'ContainerStart' },
        before, containerStart);
    http.post({ path: '/containers/:id/stop', name: 'ContainerStop' },
        before, containerStop);
    http.post({ path: '/containers/:id/restart', name: 'ContainerRestart' },
        before, containerRestart);
    http.post({ path: '/containers/:id/kill', name: 'ContainerKill' },
        before, containerKill);
    http.post({ path: '/containers/:id/pause', name: 'ContainerPause' },
        before, containerPause);
    http.post({ path: '/containers/:id/unpause', name: 'ContainerUnPause' },
        before, containerUnPause);
    http.post({ path: '/containers/:id/attach', name: 'ContainerAttach' },
        before, containerAttach);
    http.post({ path: '/containers/:id/wait', name: 'ContainerWait' },
        before, containerWait);
    http.del({ path: '/containers/:id', name: 'ContainerDelete' },
        before, containerDelete);
    http.post({ path: '/containers/:id/copy', name: 'ContainerCopy' },
        before, containerCopy);
}



module.exports = {
    register: register
};
