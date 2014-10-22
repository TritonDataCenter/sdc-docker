/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var os = require('os');
var path = require('path');
var restify = require('restify');



var dockerArchFromArch = {
    'x64': 'amd64',
    'ia32': 'i386'
};

var dockerOsFromPlatform = {
    'darwin': 'darwin',
    'linux': 'linux',
    'sunos': 'solaris'
};

var buildInfo; // loaded lazily



/**
 * GET /$v/version
 *
 * Example response from a Go docker server:
 *      {"ApiVersion":"1.12","Arch":"amd64","GitCommit":"990021a",
 *      "GoVersion":"go1.2.1","KernelVersion":"3.13.0-36-generic",
 *      "Os":"linux","Version":"1.0.1"}
 */
function version(req, res, next) {
    var dockerArch = dockerArchFromArch[os.arch()];
    if (!dockerArch) {
        return next(new restify.InternalError('unknown arch:' + os.arch()));
    }
    var dockerOs = dockerOsFromPlatform[os.platform()];
    if (!dockerOs) {
        return next(new restify.InternalError(
            'unknown platform:' + os.platform()));
    }
    buildInfo = require(path.resolve(__dirname, '../../etc/build.json'));
    req.log.debug('req.app', req.app);
    req.log.debug('req.app.version', req.app.version);
    var v = {
        "ApiVersion": "1.12",
        "Arch": dockerArch,
        "GitCommit": buildInfo.commit,
        "GoVersion": "node" + process.version.slice(1),
        // XXX shell out to `uname` for this? Then *cache* that.
        //  "KernelVersion": "3.13.0-36-generic",
        "Os": dockerOs,
        "Version": req.app.version
    };
    res.send(v);
    next();
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/v1.15/version', name: 'Version' },
        before, version);
}



module.exports = {
    register: register
};
