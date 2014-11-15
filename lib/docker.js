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
var hijack = require('./hijack');
var fs = require('fs');
var path = require('path');
var restify = require('restify');
var verror = require('verror');



//---- globals

var VERSION = JSON.parse(fs.readFileSync(path.normalize(
    __dirname + '/../package.json'), 'utf8')).version;



//---- internal support stuff

function loadConfigSync(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var configPath = path.resolve(__dirname, '..', 'etc', 'config.json');
    opts.log.info('Loading config from "%s"', configPath);
    var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Validation. XXX backend-specific config validation should not be here.
    assert.number(config.port, 'config.port');
    assert.string(config.defaultPackage, 'config.defaultPackage');
    assert.string(config.logLevel, 'config.logLevel');
    assert.object(config.cnapi, 'config.cnapi');
    assert.string(config.cnapi.url, 'config.cnapi.url');
    assert.object(config.imgapi, 'config.imgapi');
    assert.string(config.imgapi.url, 'config.imgapi.url');
    assert.object(config.napi, 'config.napi');
    assert.string(config.napi.url, 'config.papi.url');
    assert.object(config.papi, 'config.napi');
    assert.string(config.papi.url, 'config.papi.url');
    assert.object(config.vmapi, 'config.vmapi');
    assert.string(config.vmapi.url, 'config.vmapi.url');

    return config;
}



//---- the App

function App(opts) {
    var self = this;
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.config, 'opts.config');

    self.version = VERSION;
    self.log = opts.log;
    self.config = opts.config;

    var Backend = require('./backends/' + self.config.backend);
    self.backend = new Backend({log: self.log, config: self.config});

    // Simple object to keep a list of commands that have been queued with
    // docker exec. Each command points to an address where a TCP socket is
    // listening. The socket dies after 5 seconds
    self.execCommands = {};

    var server = self.server = restify.createServer({
        log: opts.log,
        name: 'docker',
        version: self.version
    });

    server.on('connection', function (socket) {
        hijack.hijack({
            socket: socket,
            log: opts.log
        });
    });

    server.on('upgrade', function (oldreq, socket, body) {
        socket.unshift(body);
        console.log('Socket has been hijacked');
    });

    server.use(function (req, res, next) {
        // Headers we want for all responses.
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
        });

        req.app = self;
        req.backend = self.backend;

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

    server.on('uncaughtException', function (req, res, route, err) {
        res.send(new restify.InternalError(err, 'Internal error'));
        /**
         * We don't bother logging the `res` here because it always looks like
         * the following, no added info to the log.
         *
         *      HTTP/1.1 500 Internal Server Error
         *      Content-Type: application/json
         *      Content-Length: 51
         *      Date: Wed, 29 Oct 2014 17:33:02 GMT
         *      x-request-id: a1fb11c0-5f91-11e4-92c7-3755959764aa
         *      x-response-time: 9
         *      Connection: keep-alive
         *
         *      {"code":"InternalError","message":"Internal error"}
         */
        req.log.error({err: err, route: route && route.name,
            req: req}, 'Uncaught exception');
    });

    endpoints.register(server, opts.log, []);
}

App.prototype.listen = function listen(callback) {
    var self = this;
    self.server.listen(self.config.port, function _afterListen(err) {
        if (err) {
            self.log.error(err, 'Error starting server');
        } else {
            var addr = self.server.address();
            self.log.info('Started docker.js on <http://%s:%s>',
                addr.address, addr.port);
        }
    });
};

App.prototype.close = function close(callback) {
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

    var config = loadConfigSync({log: log});
    log.level(config.logLevel);

    var app = new App({log: log, config: config});
    app.listen();
}

main();
