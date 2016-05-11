/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * A sdc-docker backend to expose an *entire SDC* as a single Docker Engine.
 */

var assert = require('assert-plus');
var verror = require('verror');

var CNAPI = require('sdc-clients').CNAPI;
var FWAPI = require('sdc-clients').FWAPI;
var IMGAPI = require('sdc-clients').IMGAPI;
var LRU = require('lru-cache');
var moray = require('moray');
var NAPI = require('sdc-clients').NAPI;
var PAPI = require('sdc-clients').PAPI;
var UFDS = require('ufds');
var VMAPI = require('sdc-clients').VMAPI;

var auth = require('./auth');
var build = require('./build');
var ConnectionStatusWatcher = require('./connwatcher');
var containers = require('./containers');
var Image = require('./models/image');
var images = require('./images');
var ImageTag = require('./models/image-tag');
var models = require('./models');
var sysinfo = require('./sysinfo');
var WFAPI = require('./wfapi'); // XXX can this go into sdc-clients?


function SdcBackend(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.log, 'opts.log');

    this.config = opts.config;
    this.log = opts.log.child({backend: 'sdc'}, true);
}


/*
 * Initialize clients that we'll need to handle the other requests.
 */
SdcBackend.prototype.init = function sdcBackendInit(app) {
    var opts = {};
    var sdcAPIs = {
        cnapi: CNAPI,
        fwapi: FWAPI,
        imgapi: IMGAPI,
        napi: NAPI,
        papi: PAPI,
        vmapi: VMAPI
    };

    app.connWatcher = new ConnectionStatusWatcher({
        app: app
    });

    // Set up our dependencies

    // first: standard SDC APIs we use
    Object.keys(sdcAPIs).forEach(function _registerAPI(api) {
        app.connWatcher.register({
            name: api,
            init: function (cb) {
                // works out to new CNAPI(app.config.cnapi)
                var apiHandle = new sdcAPIs[api](app.config[api]);
                cb(null, apiHandle);
            },
            pingIntervalSecs: 10,
            ping: function (apiHandle, cb) {
                assert.func(apiHandle.ping, 'apiHandle[' + api + '].ping');
                apiHandle.ping(function (err) {
                    if (err) {
                        cb(new verror.VError(err, 'could not ping '
                            + api.toUpperCase()));
                        return;
                    }
                    cb();
                });
            }
        });
    });

    // workflow is currently a snowflake
    app.connWatcher.register({
        name: 'wfapi',
        init: function (cb) {
            var wfclient = new WFAPI(app.config.wfapi, app.log);
            wfclient.connect(function () {
                app.log.info('wfapi is ready');
            });
            cb(null, wfclient);
        },
        isAvailable: function (wfclient) {
            return wfclient.connected;
        }
    });

    // moray uses its own thing
    app.connWatcher.register({
        name: 'moray',
        init: function (cb) {
            var morayClient = createMorayClient(app);
            cb(null, morayClient);
        },
        isAvailable: function () {
            return app.connWatcher.connections.moray
                && app.connWatcher.connections.moray.connection.connected;
        }
    });

    // ufds uses LDAP and its own client
    // TODO: do we need a watcher on ufds too?
    opts = app.config.ufds;
    opts.log = app.log;
    createUfdsClient(opts, function (err, ufds) {
        if (err) {
            app.log.error({ err: err }, 'ufds error');
            return;
        }
        app.ufds = ufds;
    });

    // configure the auth caching used by the auth module (adds itself to app)
    initAuthCache(app);

    // Add a list of clients we want traceHandle's added to which includes all
    // the clients registered to be watched with connWatcher, and ufds which is
    // not.
    app.clientHandles = Object.keys(app.connWatcher.connections).concat('ufds');
};


/**
 * Creates a UFDS client instance pointing to the UFDS server provided
 * in options. callback will be called either with Error - cb(err) - or
 * with the recently instantiated client object: cb(null, ufds_client)
 */
function createUfdsClient(options, callback) {
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
}


/*
 * Initializes authentication cache as a LRU cache
 */
function initAuthCache(app) {
    var cacheOptions = app.config.authCache || {};

    if (cacheOptions.max === undefined) {
        cacheOptions.max = 100;
    }
    if (cacheOptions.maxAge === undefined) {
        cacheOptions.maxAge = 2 * 60 * 1000;
    }

    app.authCache = LRU(cacheOptions);
}


/**
 * Creates a moray client, retrying as necessary
 */
function createMorayClient(app) {
    var conf = {
        connectTimeout: 1000,
        host: app.config.moray.host,
        noCache: true,
        port: app.config.moray.port,
        reconnect: true,
        retry: {
            retries: Infinity,
            maxTimeout: 6000,
            minTimeout: 100
        }
    };

    app.log.debug(conf, 'Creating moray client');
    conf.log = app.log.child({
        component: 'moray',
        level: app.config.moray.logLevel || 'info'
    });
    var client = moray.createClient(conf);

    function onMorayConnect() {
        client.removeListener('error', onMorayError);
        client.log.info('moray: connected');
        app.moray = client;
        initMoray(app);

        client.on('close', function () {
            client.log.error('moray: closed');
        });

        client.on('connect', function () {
            client.log.info('moray: reconnected');
        });

        client.on('error', function (err) {
            client.log.warn(err, 'moray: error (reconnecting)');
        });
    }

    function onMorayError(err) {
        client.removeListener('connect', onMorayConnect);
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
}


/**
 * Initializes moray buckets
 */
function initMoray(app) {
    var att = 1;
    var timeout = null;

    function modelInitRetry() {
        models.init(app, function (err) {
            if (timeout) {
                clearTimeout(timeout);
            }

            if (!err) {
                app.log.info('models initialized');
                return;
            }

            app.log.error(err, 'Error initializing models (attempt=%d)', att);
            att++;
            timeout = setTimeout(modelInitRetry, 10000);
        });
    }

    modelInitRetry();
}


// sysinfo.js
SdcBackend.prototype.getInfo = sysinfo.getInfo;

// containers.js
SdcBackend.prototype.attachContainer = containers.attachContainer;
SdcBackend.prototype.containerArchiveReadStream =
    containers.containerArchiveReadStream;
SdcBackend.prototype.containerArchiveStat =
    containers.containerArchiveStat;
SdcBackend.prototype.containerArchiveWriteStream =
    containers.containerArchiveWriteStream;
SdcBackend.prototype.containerLogs = containers.containerLogs;
SdcBackend.prototype.containerStats = containers.containerStats;
SdcBackend.prototype.copyContainer = containers.copyContainer;
SdcBackend.prototype.createContainer = containers.createContainer;
SdcBackend.prototype.deleteContainer = containers.deleteContainer;
SdcBackend.prototype.deleteLink = containers.deleteLink;
SdcBackend.prototype.execContainer = containers.execContainer;
SdcBackend.prototype.execResize = containers.execResize;
SdcBackend.prototype.execStart = containers.execStart;
SdcBackend.prototype.getContainerCount = containers.getContainerCount;
SdcBackend.prototype.getContainers = containers.getContainers;
SdcBackend.prototype.getVmById = containers.getVmById;
SdcBackend.prototype.inspectContainer = containers.inspectContainer;
SdcBackend.prototype.killContainer = containers.killContainer;
SdcBackend.prototype.psContainer = containers.psContainer;
SdcBackend.prototype.renameContainer = containers.renameContainer;
SdcBackend.prototype.resizeContainer = containers.resizeContainer;
SdcBackend.prototype.restartContainer = containers.restartContainer;
SdcBackend.prototype.startContainer = containers.startContainer;
SdcBackend.prototype.stopContainer = containers.stopContainer;
SdcBackend.prototype.waitContainer = containers.waitContainer;

// images.js
SdcBackend.prototype.addImageHeads = images.addImageHeads;
SdcBackend.prototype.createImage = images.createImage;
SdcBackend.prototype.deleteImage = images.deleteImage;
SdcBackend.prototype.getImageHistory = images.getImageHistory;
SdcBackend.prototype.getScratchImage = images.getScratchImage;
SdcBackend.prototype.imgFromName = images.imgFromName;
SdcBackend.prototype.inspectImage = images.inspectImage;
SdcBackend.prototype.listImages = images.listImages;
SdcBackend.prototype.pullImage = images.pullImage;
SdcBackend.prototype.tagImage = images.tagImage;

// build.js
SdcBackend.prototype.buildImage = build.buildImage;
SdcBackend.prototype.commitImage = build.commitImage;

// auth.js
SdcBackend.prototype.auth = auth.auth;

// models
SdcBackend.prototype.models = {
    Image: Image,
    ImageTag: ImageTag
};

module.exports = SdcBackend;
