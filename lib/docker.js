/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * docker.js
 */

var bunyan = require('bunyan');
var endpoints = require('./endpoints');
var fs = require('fs');
var path = require('path');
var restify = require('restify');



// 2376 for SSL
var PORT = 2375;
var VERSION = JSON.parse(fs.readFileSync(path.normalize(
    __dirname + '/../package.json'), 'utf8')).version;



var log = bunyan.createLogger({
    name: 'docker',
    level: 'debug',
    serializers: restify.bunyan.serializers
});

var server = this.server = restify.createServer({
    log: log,
    name: 'docker',
    version: VERSION
});

server.use(restify.requestLogger());

server.on('after', function _filteredAuditLog(req, res, route, err) {
    restify.auditLogger({
        log: req.log.child({
            component: 'audit',
            route: route && route.name
        }, true),
        // Successful GET res bodies are uninteresting and *big*.
        body: !((req.method === 'GET') &&
            Math.floor(res.statusCode/100) === 2)
    })(req, res, route, err);
});

endpoints.register(server, log, []);

server.listen(PORT, function _afterListen(err) {
    if (err) {
        log.error(err, 'Error starting server');
    } else {
        log.info('Started docker.js on port %d', PORT);
    }
});
