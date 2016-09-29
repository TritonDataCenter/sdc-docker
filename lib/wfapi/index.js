/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Driver for Workflow API usage.
 */

var format = require('util').format;

var assert = require('assert-plus');
var clone = require('clone');
var WfClient = require('wf-client');
var async = require('async');


// Workflows

var WORKFLOW_PATH = __dirname + '/workflows/';


/*
 * WFAPI Constructor
 */
function Wfapi(options, log) {
    this.log = log.child({ component: 'wfapi' }, true);
    options.path = WORKFLOW_PATH;
    options.log = this.log;

    this.tasks = options.workflows;
    // WFAPI CLIENT
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
 * Queues a pull-image job.
 *
 * @param options {Object} Required.
 * @param cb {Function} `function (err, jobUuid)`
 */
Wfapi.prototype.createPullImageJob = function (options, cb) {
    var self = this;
    assert.object(options, 'options');
    assert.object(options.account, 'opts.account');
    assert.object(options.rat, 'options.rat');
    assert.optionalString(options.regAuth, 'opts.regAuth');
    assert.optionalString(options.regConfig, 'opts.regConfig');
    assert.object(options.req, 'options.req');

    var params = {
        task: 'pull-image',
        target: format('/pull-image-%s', options.rat.canonicalName),
        rat: options.rat,
        // XXX REMOVE req_id when tracing passes this through
        req_id: options.req.getId(),
        account_uuid: options.account.uuid,
        regAuth: options.regAuth,
        regConfig: options.regConfig
    };
    var jobOpts = {};

    self.client.createJob(params.task, params, jobOpts, function (err, job) {
        if (err) {
            return cb(err);
        }
        params.job_uuid = job.uuid;
        self.log.debug(params, 'Pull image job params');
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


Wfapi.prototype.child = function child(req) {
    assert.object(req, 'req');

    var self = this;
    var _child;

    // Because self.client is a WfClient and that has its own .child, we'll end
    // up creating two levels of clone here.
    _child = clone(self, true, 1);
    _child.client = self.client.child(req);

    return (_child);
};

module.exports = Wfapi;
