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

var VERSION = JSON.parse(fs.readFileSync(path.normalize(
    __dirname + '/../package.json'), 'utf8')).version;



//---- internal support stuff

function loadConfigSync(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var configPath = path.resolve(__dirname, '..', 'etc', 'config.json');
    opts.log.info('Loading config from "%s"', configPath);
    var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Validation.
    assert.number(config.port, 'config.port');
    assert.string(config.logLevel, 'config.logLevel');
    assert.object(config.imgapi, 'config.imgapi');
    assert.string(config.imgapi.url, 'config.imgapi.url');
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

    //XXX
    //var Backend = require('./backends/' + self.config.backend);
    //self.backend = new Backend({log: self.log, config: self.config});

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

    var config = loadConfigSync({log: log});
    log.level(config.logLevel);

    // XXX(trentm): Hack export of envvars used in 'sdc' backend.
    process.env.IMGAPI_URL = config.imgapi.url;
    process.env.VMAPI_URL = config.vmapi.url;

    var app = new App({log: log, config: config});
    app.listen();
}

main();
