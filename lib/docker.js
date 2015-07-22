/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
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
var LRU = require('lru-cache');
var moray = require('moray');
var registry = require('docker-registry-client');
var sbs = require('sdc-bunyan-serializers');
var os = require('os');
var path = require('path');
var restify = require('restify');
var UFDS = require('ufds');
var vasync = require('vasync');
var verror = require('verror');
var CNAPI = require('sdc-clients').CNAPI;
var IMGAPI = require('sdc-clients').IMGAPI;
var VMAPI = require('sdc-clients').VMAPI;

var adminEndpoints = require('./endpoints/admin');
var auth = require('./auth');
var ConnectionStatusWatcher = require('./connwatcher');
var common = require('./common');
var endpoints = require('./endpoints');
var errors = require('./errors');
var hijack = require('./hijack');
var models = require('./models');
var SocketManager = require('./socket-manager');
var upgrade = require('./upgrade');
var wfapi = require('./wfapi');
var configLoader = require('./config-loader');


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

    self.setupConnections();

    // TODO make the other clients accessible via req.app

    self.sockets = new SocketManager({ log: self.log });
    self.initAuthCache();

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
        });

        req.app = self;
        req.backend = self.backend;
        req.wfapi = self.wfapi;

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
        auth.auth(self.config, self.log),  /* sets `req.account` */
        common.reqClientApiVersion
    ]);

    self.setupAdminSever();
}

App.prototype.setupConnections = function setupConnections() {
    var self = this;

    self.connWatcher = new ConnectionStatusWatcher({
        app: self
    });

    // Set up our dependencies
    self.connWatcher.register({
        name: 'cnapi',
        init: function (cb) {
            var cnapi = new CNAPI(self.config.cnapi);
            cb(null, cnapi);
        },
        pingIntervalSecs: 10,
        ping: function (cnapi, cb) {
            cnapi.ping(function (err) {
                if (err) {
                    cb(new verror.VError(err, 'could not ping CNAPI'));
                    return;
                }
                cb();
            });
        }
    });

    self.connWatcher.register({
        name: 'vmapi',
        init: function (cb) {
            var vmapi = new VMAPI(self.config.vmapi);
            cb(null, vmapi);
        },
        pingIntervalSecs: 10,
        ping: function (vmapi, cb) {
            vmapi.ping(function (err) {
                if (err) {
                    cb(new verror.VError(err, 'could not ping VMAPI'));
                    return;
                }
                cb();
            });
        }
    });

    self.connWatcher.register({
        name: 'imgapi',
        init: function (cb) {
            var imgapi = new IMGAPI(self.config.imgapi);
            cb(null, imgapi);
        },
        pingIntervalSecs: 10,
        ping: function (imgapi, cb) {
            imgapi.ping(function (err) {
                if (err) {
                    cb(new verror.VError(err, 'could not ping IMGAPI'));
                    return;
                }
                cb();
            });
        }
    });

    self.connWatcher.register({
        name: 'wfapi',
        init: function (cb) {
            var wfclient = new wfapi(self.config.wfapi, self.log);
            wfclient.connect(function () {
                self.log.info('wfapi is ready');
            });
            cb(null, wfclient);
        },
        isAvailable: function (wfclient) {
            return wfclient.connected;
        }
    });

    self.connWatcher.register({
        name: 'moray',
        init: function (cb) {
            var morayClient = self.createMorayClient();
            cb(null, morayClient);
        },
        isAvailable: function () {
            return self.morayConnected;
        }
    });

    self.createUfdsClient(self.config.ufds, function (err, ufds) {
        if (err) {
            self.log.error({ err: err }, 'ufds error');
            return;
        }
        self.ufds = ufds;
    });
};


App.prototype.setupServer = function () {
    var self = this;

    var serverOpts = {
        log: self.log,
        name: 'docker',
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

/**
 * Creates a moray client, retrying as necessary
 */
App.prototype.createMorayClient = function createMorayClient() {
    var self = this;
    var conf = {
        connectTimeout: 1000,
        host: self.config.moray.host,
        noCache: true,
        port: self.config.moray.port,
        reconnect: true,
        retry: {
            retries: Infinity,
            maxTimeout: 6000,
            minTimeout: 100
        }
    };

    self.log.debug(conf, 'Creating moray client');
    conf.log = self.log.child({
        component: 'moray',
        level: self.config.moray.logLevel || 'info'
    });
    var client = moray.createClient(conf);

    function onMorayConnect() {
        client.removeListener('error', onMorayError);
        client.log.info('moray: connected');
        self.morayConnected = true;
        self.moray = client;
        self.initMoray();

        client.on('close', function () {
            client.log.error('moray: closed');
            self.morayConnected = false;
        });

        client.on('connect', function () {
            client.log.info('moray: reconnected');
            self.morayConnected = true;
        });

        client.on('error', function (err) {
            client.log.warn(err, 'moray: error (reconnecting)');
            self.morayConnected = false;
        });
    }

    function onMorayError(err) {
        client.removeListener('connect', onMorayConnect);
        self.morayConnected = false;
        client.log.error(err, 'moray: connection failed');
    }

    function onMorayConnectAttempt(number, delay) {
        var level;
        if (number === 0) {
            level = 'info';
        } else if (number < 5) {
            level = 'warn';
        } else {
            level = 'error';
        }
        client.log[level]({
                attempt: number,
                delay: delay
        }, 'moray: connection attempted');
    }

    client.once('connect', onMorayConnect);
    client.once('error', onMorayError);
    client.on('connectAttempt', onMorayConnectAttempt); // this we always use

    return client;
};

/**
 * Creates a UFDS client instance pointing to the UFDS server provided
 * in options. callback will be called either with Error - cb(err) - or
 * with the recently instantiated client object: cb(null, ufds_client)
 */
App.prototype.createUfdsClient = function (options, callback) {
    options.log = this.log;
    var ufds = new UFDS(options);

    ufds.once('connect', function () {
        ufds.removeAllListeners('error');
        ufds.on('error', function (err) {
            options.log.error(err, 'UFDS disconnected');
        });
        ufds.on('connect', function () {
            options.log.info('UFDS reconnected');
        });
        callback(null, ufds);
    });

    ufds.once('error', function (err) {
        // You are screwed. It's likely that the bind credentials were bad.
        // Treat this as fatal and move on:
        options.log.error({err: err}, 'UFDS connection error');
        callback(err);
    });
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


/**
 * Initializes moray buckets
 */
App.prototype.initMoray = function () {
    var self = this;
    var att = 1;
    var timeout = null;

    function modelInitRetry() {
        models.init(self, function (err) {
            if (timeout) {
                clearTimeout(timeout);
            }

            if (!err) {
                self.log.info('models initialized');
                return;
            }

            self.log.error(err, 'Error initializing models (attempt=%d)', att);
            att++;
            timeout = setTimeout(modelInitRetry, 10000);
        });
    }

    modelInitRetry();
};


/*
 * Initializes authentication cache as a LRU cache
 */
App.prototype.initAuthCache = function () {
    var cacheOptions = this.config.authCache || {};

    if (cacheOptions.max === undefined) {
        cacheOptions.max = 100;
    }
    if (cacheOptions.maxAge === undefined) {
        cacheOptions.maxAge = 2 * 60 * 1000;
    }

    this.authCache = LRU(cacheOptions);
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
