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

var adminEndpoints = require('./endpoints/admin');
var assert = require('assert-plus');
var bunyan = require('bunyan');
var common = require('./common');
var endpoints = require('./endpoints');
var trace_event = require('trace-event');
var fmt = require('util').format;
var fs = require('fs');
var hijack = require('./hijack');
var http = require('http');
var models = require('./models');
var moray = require('moray');
var wfapi = require('./wfapi');
var registry = require('docker-registry-client');
var SocketManager = require('./socket-manager');
var os = require('os');
var path = require('path');
var restify = require('restify');
var UFDS = require('ufds');
var vasync = require('vasync');
var verror = require('verror');
var KeyAPI = require('keyapi');



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
    assert.number(config.defaultMemory, 'config.defaultMemory');
    assert.string(config.packagePrefix, 'config.packagePrefix');
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


/**
 * Extend the default Restify 'text/plain' formatter to include the
 * `err.restCode` string in returned error messages.
 */
function formatErrOrText(req, res, body) {
    if (body instanceof Error) {
        res.statusCode = body.statusCode || 500;
        if (body.restCode && body.restCode !== 'DockerError') {
            body = fmt('%s: %s', body.restCode, body.message);
        } else {
            body = body.message;
        }
        // Update `res._body` for the audit logger.
        res._body = body;
    } else if (typeof (body) === 'object') {
        body = JSON.stringify(body);
    } else {
        body = body.toString();
    }

    res.setHeader('Content-Length', Buffer.byteLength(body));
    return (body);
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

    self.indexClient = registry.createIndexClient({
        log: self.log.child({ registry: true }, true),
        url: self.config.registry.indexUrl
    });

    self.wfapi = new wfapi(self.config.wfapi, self.log);
    self.wfapi.connect(function () {
        self.log.info('wfapi is ready');
    });

    self.createMorayClient();
    self.sockets = new SocketManager({ log: self.log });

    // Where should the authentication cache live?
    self.authCache = {};
    self.createUfdsClient(self.config.ufds, function (err, ufds) {
        if (err) {
            throw (err);
        }
        self.ufds = ufds;
    });

    self.keyapi = new KeyAPI({log: self.log, ufds: self.config.ufds});
    
    var server = self.server = self.setupServer();

    server.on('upgrade', function (oldreq, socket, body) {
        socket.unshift(body);
        self.log.info('Socket has been hijacked');
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
        req.indexClient = self.indexClient;
        req.wfapi = self.wfapi;

        next();
    });

    server.use(restify.requestLogger());
    server.use(function (req, res, next) {
        req.trace = trace_event.createBunyanTracer({
            log: req.log
        });
        if (req.route) {
            req.trace.begin(req.route.name);
        }
        next();
    });
    server.on('after', function (req, res, route, err) {
        if (route) {
            req.trace.end(route.name);
        }
    });

    server.use(restify.queryParser({mapParams: false}));
    server.use(restify.bodyParser());
    server.on('after', common.filteredAuditLog);
    server.on('uncaughtException', common.uncaughtHandler);
    endpoints.register(server, opts.log, [
        common.getAccount,
        common.authorizeXToken,
        common.checkServices,
        common.checkApiVersion
    ]);

    self.setupAdminSever();
}

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
            'text/plain; q=0.3': formatErrOrText
        }
    };

    if (self.config.useTls && self.config.tls) {
        var tls = self.config.tls;
        assert.object(tls, 'config.tls');
        assert.string(tls.key, 'config.tls.key');
        assert.string(tls.cert, 'config.tls.cert');
        assert.optionalString(tls.ca, 'config.tls.ca');

        tls.key = fs.readFileSync(tls.key);
        tls.cert = fs.readFileSync(tls.cert);
        if (tls.ca) {
            tls.ca = fs.readFileSync(tls.ca);
        }

        serverOpts.httpsServerOptions = tls;
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
                self.admin.listen(self.config.adminPort, adminIp, next);
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
    var ifs = interfaces[this.config.adminInterface];

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
