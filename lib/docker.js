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

var assert = require('assert-plus');
var bunyan = require('bunyan');
var endpoints = require('./endpoints');
var fs = require('fs');
var path = require('path');
var restify = require('restify');



//---- globals

// 2376 for SSL
var PORT = 2375;
var VERSION = JSON.parse(fs.readFileSync(path.normalize(
    __dirname + '/../package.json'), 'utf8')).version;



//---- the App

function App(opts) {
    var self = this;
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.number(opts.port, 'opts.port');

    self.version = VERSION;
    self.log = opts.log;
    self.port = opts.port;

    var server = self.server = restify.createServer({
        log: opts.log,
        name: 'docker',
        version: self.version
    });

    server.use(function (req, res, next) {
        // Headers we want for all IMGAPI responses.
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
        });

        req.app = self;

        next();
    });

    server.use(restify.requestLogger());
    server.use(restify.queryParser({mapParams: false}));
    server.use(restify.bodyParser());

    server.on('after', function _filteredAuditLog(req, res, route, err) {
        restify.auditLogger({
            log: req.log.child({
                component: 'audit',
                route: route && route.name
            }, true),
            // Successful GET res bodies are uninteresting and *big*.
            body: !((req.method === 'GET')
                && Math.floor(res.statusCode/100) === 2)
        })(req, res, route, err);
    });

    endpoints.register(server, opts.log, []);
}

App.prototype.listen = function (callback) {
    var self = this;
    self.server.listen(self.port, function _afterListen(err) {
        if (err) {
            self.log.error(err, 'Error starting server');
        } else {
            var addr = self.server.address();
            self.log.info('Started docker.js on <http://%s:%s>',
                addr.address, addr.port);
        }
    });
};

App.prototype.close = function (callback) {
    this.server.on('close', function () {
        callback();
    });
    this.server.close();
};



//---- mainline

function main() {
    var log = bunyan.createLogger({
        name: 'docker',
        level: 'debug',
        serializers: restify.bunyan.serializers
    });

    var app = new App({log: log, port: PORT});
    app.listen();
}

main();
