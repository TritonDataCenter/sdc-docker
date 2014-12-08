/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Driver for Workflow API usage.
 */

var format = require('util').format;

var assert = require('assert-plus');
var WfClient = require('wf-client');
var async = require('async');


// Workflows

// Absolute path from the app
var WORKFLOW_PATH = './lib/workflows/';


/*
 * WFAPI Constructor
 */
function Wfapi(options, log) {
    this.log = log.child({ component: 'wfapi' }, true);
    options.path = WORKFLOW_PATH;
    options.log = this.log;

    this.tasks = options.workflows;
    this.client = new WfClient(options);
    this.connected = false;
}


/*
 * Wait until wfapi is online before proceeding to create workflows
 */
Wfapi.prototype.connect = function () {
    var self = this;
    self.log.debug('Loading the WFAPI workflows...');

    self.startAvailabilityWatcher();

    // Don't proceed with initializing workflows until we have connected.
    function init() {
        async.until(
            function () { return self.connected; },
            function (cb) {
                setTimeout(cb, 1000);
            },
            function () {
                self.client.initWorkflows(function (error) {
                    if (error) {
                        self.log.error(error, 'Error initializing workflows');
                        init();
                    }
                    self.log.info('All workflows have been loaded');
                });
            });
    }

    init();
};


/*
 * Ping until wfapi is online
 */
Wfapi.prototype.startAvailabilityWatcher = function () {
    var self = this;

    setInterval(function () {
        pingWorkflow();
    }, 10000);

    function pingWorkflow() {
        var client = self.client;

        // Try to get a fake workflow, check the error code if any.
        client.ping(function (error) {
            if (error) {
                if (self.connected) {
                    self.log.error('Workflow appears to be unavailable');
                }

                if (error.syscall === 'connect') {
                    self.connected = false;
                    self.log.error(
                        'Failed to connect to Workflow API (%s)', error.code);
                    return;
                }

                self.connected = false;
                self.log.error({ error: error }, 'Ping failed');

                return;
            }

            if (!self.connected) {
                client.getWorkflow(
                    'workflow-check',
                    function (err, val) {
                        if (err.statusCode !== 404)
                        {
                            self.log.warn(err,
                                'Workflow API Error: %d',
                                err.statusCode);
                            return;
                        }
                        if (!self.connected) {
                            self.connected = true;
                            self.log.info('Connected to Workflow API');
                        }
                    });
            }
        });
    }

    pingWorkflow();
};


/*
 * Pings WFAPI by getting the provision workflow
 */
Wfapi.prototype.ping = function (callback) {
    this.client.ping(function (err, pong) {
        return callback(err);
    });
};



/*
 * Takes care of figuring out if clients are passing request-id or x-request-id.
 */
function getRequestHeaders(req) {
    if (req.headers['x-request-id']) {
        return { 'x-request-id': req.headers['x-request-id'] };
    } else {
        return {};
    }
}



/*
 * Queues an 'create image from VM' job.
 *
 * @param options {Object} Required.
 *      - req {Object} Required.
 *      - vmUuid {String} Required.
 *      - manifest {Object} Required.
 *      - incremental {Boolean} Required.
 *      - prepareImageScript {String} Required.
 * @param cb {Function} `function (err, jobUuid)`
 */
Wfapi.prototype.createImageFromVmJob = function (options, cb) {
    var self = this;
    assert.object(options, 'options');
    assert.object(options.req, 'options.req');
    assert.string(options.vmUuid, 'options.vmUuid');
    assert.object(options.manifest, 'options.manifest');
    assert.bool(options.incremental, 'options.incremental');
    assert.string(options.prepareImageScript, 'options.prepareImageScript');
    assert.optionalNumber(options.maxOriginDepth, 'options.maxOriginDepth');

    var params = {
        image_uuid: options.manifest.uuid,
        vm_uuid: options.vmUuid,
        owner_uuid: options.manifest.owner,
        compression: 'gzip',   // Yah, we hardcode gzip here for now.
        incremental: options.incremental,
        prepare_image_script: options.prepareImageScript,
        max_origin_depth: options.maxOriginDepth,
        manifest: options.manifest,
        task: 'create-from-vm',
        target: format('/create-from-vm-%s', options.vmUuid)
    };
    var jobOpts = { headers: getRequestHeaders(options.req) };

    self.client.createJob(params.task, params, jobOpts, function (err, job) {
        if (err) {
            return cb(err);
        }
        params.job_uuid = job.uuid;
        self.log.debug(params, 'Create from VM job params');
        return cb(null, job.uuid);
    });
};



/*
 * Queues an 'import remote image' job.
 */
Wfapi.prototype.createImportRemoteImageJob = function (options, cb) {
    assert.object(options, 'options');
    assert.object(options.req, 'options.req');
    assert.string(options.uuid, 'options.uuid');
    assert.optionalArrayOfString(options.origins, 'options.origins');
    assert.string(options.source, 'options.source');
    assert.object(options.manifest, 'options.manifest');
    assert.bool(options.skipOwnerCheck, 'options.skipOwnerCheck');
    assert.func(cb, 'cb');

    var self = this;
    var params = {
        origins: options.origins,
        image_uuid: options.uuid,
        source: options.source,
        skip_owner_check: options.skipOwnerCheck,
        task: 'import-remote-image',
        target: format('/import-remote-%s', options.uuid)
    };
    var jobOpts = { headers: getRequestHeaders(options.req) };

    self.client.createJob(params.task, params, jobOpts, function (err, job) {
        if (err) {
            return cb(err);
        }

        params.job_uuid = job.uuid;
        self.log.debug({params: params}, 'Import remote image job params');
        return cb(null, job.uuid);
    });
};


/*
 * Retrieves a job from WFAPI.
 */
Wfapi.prototype.getJob = function (jobUuid, cb) {
    this.client.getJob(jobUuid, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        cb(null, job);
    });
};


module.exports = Wfapi;
