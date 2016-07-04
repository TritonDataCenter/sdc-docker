/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * docker.js
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var trace_event = require('trace-event');
var EffluentLogger = require('effluent-logger');
var fmt = require('util').format;
var fs = require('fs');
var http = require('http');
var sbs = require('sdc-bunyan-serializers');
var os = require('os');
var path = require('path');
var restify = require('restify');
var upgrade = require('restify/lib/upgrade');
var vasync = require('vasync');
var verror = require('verror');

var adminEndpoints = require('./endpoints/admin');
var common = require('./common');
var configLoader = require('./config-loader');
var constants = require('./constants');
var endpoints = require('./endpoints');
var errors = require('./errors');
var hijack = require('./hijack');
var SocketManager = require('./socket-manager');


//---- globals

var TLS_KEY = '/data/tls/key.pem';
var TLS_CERT = '/data/tls/cert.pem';

var VERSION = JSON.parse(fs.readFileSync(path.normalize(
    __dirname + '/../package.json'), 'utf8')).version;
var request_seq_id = 0;



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

    // Tell the backend to initialize itself, it may add additional things (e.g.
    // client connection handles) to the 'self' object we pass in here which
    // will be available in handlers as req.app.
    self.backend.init(self);

    self.sockets = new SocketManager({ log: self.log });

    if (self.config.readOnly) {
        self.log.warn(
            'starting in read-only mode');
    }

    var server = self.server = self.setupServer();

    server.on('upgrade', function (oldreq, socket, body) {
        self.log.info('Socket has been hijacked');

        // Unfortunately there's no way of detecting the docker client's
        // intentions at this point so we just have to override onread
        // on every upgrade (attach, exec) request. We make sure to do
        // this only on TLS requests
        if (oldreq.hijacked && self.config.useTls) {
            hijack.setHalfClose(self.log, oldreq, socket);
        }

        // New hijacks can make use of restify's handleUpgrades mechanism
        if (hijack.isNewHijack(oldreq)) {
            oldreq._upgradeRequest = true;

            var res = upgrade.createResponse(oldreq, socket, body);
            server._setupRequest(oldreq, res);
            server._handle(oldreq, res);
        } else {
            socket.unshift(body);
        }
    });

    /*
     * HACK: Monkey-patch restify's `http.ServerResponse.format` to default
     * to text/plain for errors without breaking the default of
     * application/json for successful responses. Restify doesn't currently
     * provide a hook to do this.
     *
     * Warning: Restify only overrides http.ServerResponse after `createServer`
     * is called because its "server.js" is lazily imported.
     */
    var Response = http.ServerResponse;
    Response.prototype._old_format = Response.prototype.format;
    Response.prototype.format = function _my_format(body, cb) {
        var type = this.contentType || this.getHeader('Content-Type');
        if (!type && body instanceof Error) {
            this.contentType = 'text/plain';
        }
        return this._old_format(body, cb);
    };


    server.use(function (req, res, next) {
        // Headers we want for all responses.
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);

            // DOCKER-617: Set a server version to be compatible with docker.
            // As the docker/docker tests require this header.
            res.header('Server', fmt('Triton/%s (linux)',
                                    constants.SERVER_VERSION));
        });

        req.app = self;
        req.backend = self.backend;

        next();
    });

    server.use(restify.requestLogger());
    server.use(function (req, res, next) {
        req.trace = trace_event.createBunyanTracer({
            log: req.log
        });
        if (req.route) {
            request_seq_id = (request_seq_id + 1) % 1000;
            req.trace.seq_id = (req.time() * 1000) + request_seq_id;
            req.trace.begin({name: req.route.name, req_seq: req.trace.seq_id});
        }
        next();
    });
    server.on('after', function (req, res, route, err) {
        if (route) {
            req.trace.end({name: route.name, req_seq: req.trace.seq_id});
        }
    });

    server.on('after', common.filteredAuditLog);
    server.on('uncaughtException', common.uncaughtHandler);
    endpoints.register(server, self.log, [
        common.checkReadonlyMode,
        common.checkServices,
        self.backend.auth(self.config, self.log),  /* sets `req.account` */
        common.reqClientApiVersion
    ]);

    self.setupAdminSever();
}

App.prototype.setupServer = function () {
    var self = this;

    var serverOpts = {
        log: self.log,
        name: 'sdc-docker',
        version: self.version,
        formatters: {
            /*
             * `q=0.3` is the same q-value in restify's default formatters.
             * I.e. we want to change this formatter, not change preferred
             * ordering.
             */
            'text/plain; q=0.3': errors.formatErrOrText
        }
    };

    if (self.config.useTls) {
        // Additional TLS options can be specified at config.tls
        var tlsOpts = self.config.tls || {};

        tlsOpts.key = fs.readFileSync(TLS_KEY);
        tlsOpts.cert = fs.readFileSync(TLS_CERT);

        serverOpts.httpsServerOptions = tlsOpts;
    }

    var server = restify.createServer(serverOpts);

    if (!self.config.useTls) {
        server.on('connection', function (socket) {
            hijack.hijack({
                socket: socket,
                log: self.log
            });
        });

        return server;
    }

    /*
     * TLS setup
     */

    server.on('secureConnection', function (cleartextStream) {
        hijack.hijack({
            socket: cleartextStream,
            log: self.log
        });
    });

    return server;
};

App.prototype.setupAdminSever = function listen(callback) {
    var self = this;
    var admin = self.admin = restify.createServer({
        log: self.log,
        name: 'docker-admin',
        version: self.version
    });

    admin.use(function (req, res, next) {
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

    admin.use(restify.requestLogger());
    admin.use(restify.queryParser({mapParams: false}));
    admin.use(restify.bodyParser());
    admin.on('after', common.filteredAuditLog);
    admin.on('uncaughtException', common.uncaughtHandler);
    adminEndpoints.register(admin, self.log, [ common.checkServices ]);
};

App.prototype.listen = function (callback) {
    var self = this;
    var adminIp = self.getAdminIp();
    var useTls = self.config.useTls;
    var serverPort = useTls ? self.config.port + 1 : self.config.port;
    var serverType = useTls ? 'https' : 'http';

    vasync.pipeline({
        funcs: [
            function startPublicServer(_, next) {
                self.server.listen(serverPort, next);
            },
            function startAdminServer(_, next) {
                self.admin.listen(80, adminIp, next);
            }
        ]
    }, function (err, results) {
        if (err) {
            self.log.error(err, 'Error starting server');
        } else {
            var addr = self.server.address();
            var adminAddr = self.admin.address();
            self.log.info('Started %s docker.js server on <%s://%s:%s>',
                serverType.toUpperCase(), serverType, addr.address, addr.port);
            self.log.info('Started admin server on <http://%s:%s>',
                adminAddr.address, adminAddr.port);
        }
    });
};

App.prototype.close = function close(callback) {
    this.server.on('close', function () {
        callback();
    });
    this.server.close();
};

/*
 * Gets the admin IP address for the sdc-docker server
 */
App.prototype.getAdminIp = function () {
    var interfaces = os.networkInterfaces();
    var ip;
    var ifs = interfaces['net0'];

    assert.object(ifs, 'admin interface');

    for (var i = 0; i < ifs.length; i++) {
        if (ifs[i].family === 'IPv4') {
            ip = ifs[i].address;
            break;
        }
    }

    return ip;
};


function addFluentdHost(log, host) {
    var evtLogger = new EffluentLogger({
        filter: function _evtFilter(obj) { return (!!obj.evt); },
        host: host,
        log: log,
        port: 24224,
        tag: 'debug'
    });
    log.addStream({
        stream: evtLogger,
        type: 'raw'
    });
}


//---- mainline

function main() {
    var log = bunyan.createLogger({
        name: 'docker',
        level: 'debug',
        serializers: sbs.serializers
    });

    var config = configLoader.loadConfigSync({log: log});
    log.level(config.logLevel);

    // EXPERIMENTAL
    if (config.fluentd_host) {
        addFluentdHost(log, config.fluentd_host);
    }

    var app = new App({log: log, config: config});
    app.listen();
}

main();
