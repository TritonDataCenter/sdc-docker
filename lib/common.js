/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var format = require('util').format;
var imgmanifest = require('imgmanifest');
var libuuid = require('libuuid');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var vasync = require('vasync');

var errors = require('./errors');
var auditLogger = require('./audit-logger');

var LABELTAG_PREFIX = 'docker:label:';
var SERVER_VERSION = '1.19';



/**
 * Given a duration in seconds, return a human-friendly string.
 */
function humanDuration(seconds) {
    var minutes = seconds / 60;
    var hours = minutes / 60;
    var days = hours / 24;
    var weeks = days / 7;
    var months = days / 30;
    var years = days / 365;

    if (seconds < 1) {
        return 'Less than a second';
    } else if (seconds < 60) {
        return sprintf('%d seconds', seconds);
    } else if (Math.floor(minutes) === 1) {
        return 'About a minute';
    } else if (minutes < 60) {
        return sprintf('%d minutes', minutes);
    } else if (Math.floor(hours) === 1) {
        return 'About an hour';
    } else if (hours < 48) {
        return sprintf('%d hours', hours);
    } else if (weeks < 2) {
        return sprintf('%d days', days);
    } else if (months < 3) {
        return sprintf('%d weeks', weeks);
    } else if (years < 2) {
        return sprintf('%d months', months);
    }

    return sprintf('%0.6f years', years);
}


/**
 * Adapted from <http://stackoverflow.com/a/18650828> but using
 * `docker run --memory MEMORY` suffixes.
 */
function humanSizeFromBytes(bytes) {
    assert.number(bytes, 'bytes');
    var sizes = ['b', 'k', 'm', 'g', 't'];
    if (bytes === 0) {
        return '0b';
    }
    var i = Number(Math.floor(Math.log(bytes) / Math.log(1024)));
    var s = String(bytes / Math.pow(1024, i));
    var precision0 = (s.indexOf('.') === -1
        ? s : s.slice(0, s.indexOf('.')));
    return sprintf('%s%s', precision0, sizes[i]);
}


/**
 * Parse a Docker Remote API boolean query param string into a boolean.
 *
 * The docs (http://docs.docker.com/reference/api/docker_remote_api_v1.17/)
 * typically say: "1/True/true or 0/False/false  ...". But the implementation,
 * of course differs:
 *
 * // JSSTYLED
 * https://github.com/docker/docker/blob/4b4bdb5be58943c24ca64fd8b0b69cd259515a23/engine/env.go#L57-L63
 *
 * @param param {String} The query param string to interpret. It can also be
 *      `undefined` (for a `false` response) to allow calling code to do:
 *             var follow = common.boolFromQueryParam(req.query.follow);
 * @returns {Boolean}
 */
var _falseValues = {
    '': true,
    '0': true,
    'no': true,
    'false': true,
    'none': true
};
function boolFromQueryParam(param) {
    if (param === undefined) {
        return false;
    }
    assert.string(param, 'param');

    var s = param.trim().toLowerCase();
    if (_falseValues[s] !== undefined) {
        return false;
    } else {
        return true;
    }
}


var STREAM_TYPES = {
    stdin: 0,
    stdout: 1,
    stderr: 2
};

/**
 * Write to docker-raw compatible streams
 */
function writeToDockerRawStream(type, stream, data) {
    var streamType = STREAM_TYPES[type];
    var messageSize = data.length;
    var message = new Buffer(8 + messageSize);

    message.writeUInt8(streamType, 0);
    message[1] = 0;
    message[2] = 0;
    message[3] = 0;
    message.writeUInt32BE(messageSize, 4);
    message.write(data.toString(), 8);
    stream.write(message);
}

/**
 * Generate a random docker Id. For now just use uuid()+uuid(). Need to verify
 * the rules docker use for generating these Ids
 */
function generateDockerId() {
    return (libuuid.create() + libuuid.create()).replace(/-/g, '');
}


/**
 * Helps formatting a JSON progress message that a docker client will understand
 * and properly format when running docker pull or docker import
 */
function formatProgress(args) {
    var progress = {};
    progress.id = (args.id && args.id.substr(0, 12)) || '';
    progress.status = args.status;
    progress.progressDetail = args.progressDetail;

    return progress;
}


/**
 * Writes a JSON progress object to an HTTP response object. Docker
 * expects a progressDetail object even if it's empty
 */
function writeProgress(res, progress) {
    if (!progress.progressDetail) {
        progress.progressDetail = {};
    }
    res.write(JSON.stringify(formatProgress(progress)));
}

/**
 * Writes a JSON status object to an HTTP response object
 */
function writeStatus(res, progress) {
    res.write(JSON.stringify(formatProgress(progress)));
}


/*
 * Wait for a job to complete. Callback with an error if the job fails
 * (execution of 'failed' or 'canceled'). The returned error attempts to
 * include an error message from the job.chain_results.
 */
function waitForJob(wfClient, job_uuid, cb) {
    assert.string(job_uuid, 'job_uuid');
    assert.func(cb, 'cb');

    pollJob(wfClient, job_uuid, function (err, job) {
        if (err) {
            /*jsl:pass*/
        } else if (job.execution === 'failed') {
            var result = job.chain_results.pop();
            if (result && result.error) {
                err = new Error(result.error.message
                    || JSON.stringify(result.error));
            } else {
                err = new Error('job ' + job_uuid + ' failed');
            }
        } else if (job.execution === 'canceled') {
            err = new Error('job ' + job_uuid + ' was canceled');
        }
        cb(err, job);
    });
}


/*
 * Poll a job until it reaches a completed state:
 * - execution='succeeded':
 * - execution='failed':
 *
 * Note: if a job fails, it's the caller's responsibility to check for a failed
 * job.  The error object will be null even if the job fails.
 */
function pollJob(client, job_uuid, cb) {
    var attempts = 0;
    var errs = 0;

    var timeout = 1000;  // 1 second
    var limit = 720;     // 1 hour
    var completedStates = ['succeeded', 'failed', 'canceled'];

    var poll = function () {
        client.getJob(job_uuid, function (err, job) {
            attempts++;

            if (err) {
                errs++;
                if (errs >= 5) {
                    return cb(err);
                } else {
                    return setTimeout(poll, timeout);
                }
            }

            if (job && completedStates.indexOf(job.execution) !== -1) {
                return cb(null, job);
            } else if (attempts > limit) {
                return cb(new Error('polling for job timed out'), job);
            }

            return setTimeout(poll, timeout);
        });
    };

    poll();
}


/*
 * Returns a handler that will prevent logging successful GET requests
 * because their response bodies can be too big in many cases
 */
function filteredAuditLog(req, res, route, err) {
    var logResponseBody = true;

    // Successful GET res bodies are uninteresting and *big*.
    if ((req.method === 'GET') && Math.floor(res.statusCode/100) === 2)
        logResponseBody = false;

    auditLogger({
        log: req.log.child({
            component: 'audit',
            route: route && route.name
        }, true),

        responseBody: {
            log: logResponseBody
        }
    })(req, res, route, err);
}


/*
 * Returns a handler that will log uncaught exceptions properly
 */
function uncaughtHandler(req, res, route, err) {
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
}


/*
 * Handler for checking if the required servics are online before serving
 * any request
 */
function checkServices(req, res, next) {
    req.app.connWatcher.checkAvailability(function (err) {
        if (err) {
            return next(err);
        }
        next();
    });
}


function checkReadonlyMode(req, res, next) {
    if (!req.app.config.readOnly) {
        next();
        return;
    }

    // bail if we are not doing a read-only operation
    if (req.method !== 'GET') {
        return next(new restify.ServiceUnavailableError(
            'docker service is currently in read-only mode for maintenance'));
    }

    next();
}

/*
 * Handler to check the request API version (valid and a supported version)
 * and set `req.clientApiVersion` (a number).
 */
function reqClientApiVersion(req, res, next) {
    var apiversion = req.params[0];
    var log = req.log;

    if (!apiversion) {
        // It's okay if the api version is missing, we just default to using the
        // current server version in that case.
        apiversion = '/v' + SERVER_VERSION;
    }

    if (apiversion.match(/^\/v[0-9\.]+$/)) {
        apiversion = Number(apiversion.slice(2));
        if ((apiversion !== NaN) && (apiversion >= 1.15)) {
            log.trace({apiversion: apiversion}, 'request has ok API version');
            req.clientApiVersion = apiversion;
            return next();
        }
    }

    log.warn({apiversion: apiversion, req: req},
        'request has invalid API version');

    return next(new restify.InvalidVersionError(
        'client and server don\'t have same version '
        + '(client : ' + apiversion + ', server: ' + SERVER_VERSION + ')'));
}


/**
 * Checks that an account has the approved_for_provisioning flag set. If not,
 * it returns an HTTP unauthorized error to the callback.
 */
function checkApprovedForProvisioning(req, res, next) {
    var account = req.account;
    var approved = account.approved_for_provisioning;

    if (approved !== 'true' && approved !== true) {
        var errMsg = account.login + ' does not have permission to pull or '
            + 'provision';
        next(new restify.NotAuthorizedError(errMsg));
        return;
    }

    next();
}


/**
 * Returns true if the object has no keys
 */
function objEmpty(obj) {
    /*jsl:ignore*/
    for (var k in obj) {
        return false;
    }
    /*jsl:end*/

    return true;
}

/**
 * Copies over all keys in `from` to `to`, or
 * to a new object if `to` is not given.
 */
function objCopy(from, to) {
    if (to === undefined) {
        to = {};
    }
    for (var k in from) {
        to[k] = from[k];
    }
    return to;
}

function isUUID(str) {
    var re = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (str && str.length === 36 && str.match(re)) {
        return true;
    } else {
        return false;
    }
}

// XXX(trent) Rename to vmUuidFromDockerId to clarify not for images.
function dockerIdToUuid(dockerId) {
    var out;

    out = dockerId.substr(0, 8) + '-'
        + dockerId.substr(8, 4) + '-'
        + dockerId.substr(12, 4) + '-'
        + dockerId.substr(16, 4) + '-'
        + dockerId.substr(20, 12);

    return (out);
}


/**
 * Takes care of parsing a container id parameter and return the container/vm
 * pair so it is available for any container actions
 */
function getVm(req, res, next) {
    var opts = {
        account: req.account,
        app: req.app,
        id: req.params.id,
        log: req.log,
        req_id: req.getId(),
        vmapi: req.app.vmapi
    };

    req.backend.getVmById(req.params.id, opts, function (err, vmobj) {
        if (err) {
            next(new errors.DockerError(err, 'problem retrieving container'));
            return;
        }

        req.vm = vmobj;
        next();
    });
}


/**
 * Handler for loading all account images in the request object
 */
function getImages(req, res, next) {
    var opts = {
        account: req.account,
        app: req.app,
        log: req.log,
        req_id: req.getId()
    };

    req.backend.listImages(opts, function (err, imgs) {
        if (err) {
            next(new errors.DockerError(err, 'problem retrieving images'));
            return;
        }

        req.images = imgs;
        next();
    });
}


/*
 * Restify handler to set `req.image` to the docker image named by
 * `req.body.Image`. `req.image` is a instance of the `Image` model.
 */
function reqImage(req, res, next) {
    var opts = {
        app: req.app,
        log: req.log,
        account: req.account,
        name: req.body.Image
    };
    req.backend.imgFromName(opts, function (err, img) {
        if (err) {
            next(err);
        } else if (!img) {
            next(new errors.ResourceNotFoundError(
                // Note: Error message must match the docker remote api, of
                // 'No such image...', see DOCKER-409.
                'No such image: ' + req.body.Image));
        } else {
            req.image = img;
            next();
        }
        next();
    });
}

/*
 * Restify handler to set `req.image` to the docker image named by
 * `req.body.Image`. `req.image` is:
 *
 * - a instance of the `Image` model; or,
 * - if the "name" is a the UUID for a SmartOS image in IMGAPI, then it is
 *   an object that implements enough of the `Image` model interface for
 *   `createContainer` to be happy.
 *
 * TODO(trent) only used for endpoints/containers.js, should move there.
 */
function reqImageIncludeSmartos(req, res, next) {
    var opts = {
        app: req.app,
        log: req.log,
        account: req.account,
        name: req.body.Image,
        includeSmartos: true
    };
    req.backend.imgFromName(opts, function (err, img) {
        if (err) {
            next(err);
        } else if (!img) {
            next(new errors.ResourceNotFoundError(
                // Note: Error message must match the docker remote api, of
                // 'No such image...', see DOCKER-409.
                'No such image: ' + req.body.Image));
        } else {
            req.image = img;
            next();
        }
    });
}


/*
 * Restify handler to set `req.regAuth` from the x-registry-auth request
 * header, if any.
 */
function reqRegAuth(req, res, next) {
    req.regAuth = null;
    if (req.headers['x-registry-auth']) {
        try {
            req.regAuth = JSON.parse(new Buffer(
                req.headers['x-registry-auth'], 'base64').toString('utf8'));
        } catch (e) {
            req.log.info(e,
                format('invalid x-registry-auth header: %j (ignoring)',
                    req.header['x-registry-auth']));
        }
    }
    next();
}


module.exports = {
    reqClientApiVersion: reqClientApiVersion,
    checkApprovedForProvisioning: checkApprovedForProvisioning,
    checkReadonlyMode: checkReadonlyMode,
    checkServices: checkServices,
    dockerIdToUuid: dockerIdToUuid,
    filteredAuditLog: filteredAuditLog,
    reqImage: reqImage,
    reqImageIncludeSmartos: reqImageIncludeSmartos,
    reqRegAuth: reqRegAuth,
    getImages: getImages,
    getVm: getVm,
    humanDuration: humanDuration,
    humanSizeFromBytes: humanSizeFromBytes,
    isUUID: isUUID,
    boolFromQueryParam: boolFromQueryParam,
    objEmpty: objEmpty,
    objCopy: objCopy,
    writeToDockerRawStream: writeToDockerRawStream,
    generateDockerId: generateDockerId,
    formatProgress: formatProgress,
    uncaughtHandler: uncaughtHandler,
    waitForJob: waitForJob,
    writeProgress: writeProgress,
    writeStatus: writeStatus,
    LABELTAG_PREFIX: LABELTAG_PREFIX,
    SERVER_VERSION: SERVER_VERSION
};
