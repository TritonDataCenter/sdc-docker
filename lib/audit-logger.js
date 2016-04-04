/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');

var HttpError = require('restify').HttpError;


// Default maximum length for requests/responses body that are logged
// is 10 KBs. This can be overriden with the option object passed
// to auditLogger.
var DEFAULT_MAX_LOG_BODY_LENGTH = 10 * 1024;

function getBodyToLog(body, options) {
    options = options || {};
    assert.object(options, 'options');
    var maxLength = options.maxLength || DEFAULT_MAX_LOG_BODY_LENGTH;

    var loggedBody;
    if (body && options.log !== false
        && (!Buffer.isBuffer(body) || options.logBuffers === true))
    {
        loggedBody = body;
        if (loggedBody.length > maxLength)
            loggedBody = loggedBody.slice(0, maxLength) + '...';
    }

    return loggedBody;
}

function getResponseBodyToLog(res, responseOptions) {
    var body;

    if (res._body instanceof HttpError) {
        body = res._body.body;
    } else {
        body = res._body;
    }

    return getBodyToLog(body, responseOptions);
}


///--- API

/**
 * This function was copied verbatim from restify's audit logger and changed
 * slightly so that it could be more flexible, and have more sensible defaults:
 *
 * - The options object now accepts "responseBody" and "requestBody" subobjects
 * so that options can be set separately for the response body or request body
 * respectively.
 *
 * - Each of these options sub-objects support the following properties:
 *
 *  * log: if true, the request or the response's body will be logged.
 *  * buffers: if true, requests/responses' bodies that are buffers will
 *    be logged. False by default.
 *  * maxLength: allows to specify the maximum size of body's data that
 *    will be logged. DEFAULT_MAX_LOG_BODY_LENGTH (currently 10KBs) by default.
 *
 * Returns a Bunyan audit logger suitable to be used in a server.on('after')
 * event.  I.e.:
 *
 * server.on('after', restify.auditLogger({ log: myAuditStream }));
 *
 * This logs at the INFO level.
 *
 * @param {Object} options at least a bunyan logger (log).
 * @return {Function} to be used in server.after.
 */
function auditLogger(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    var errSerializer = bunyan.stdSerializers.err;

    if (options.log.serializers && options.log.serializers.err) {
        errSerializer = options.log.serializers.err;
    }

    var log = options.log.child({
        audit: true,
        serializers: {
            err: errSerializer,
            req: function auditRequestSerializer(req) {
                if (!req)
                    return (false);

                var timers = {};
                (req.timers || []).forEach(function (time) {
                    var t = time.time;
                    var _t = Math.floor((1000000 * t[0])
                        + (t[1] / 1000));
                    timers[time.name] = _t;
                });
                return ({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    httpVersion: req.httpVersion,
                    trailers: req.trailers,
                    version: req.version(),
                    body: getBodyToLog(req.body, options.requestBody),
                    timers: timers
                });
            },
            res: function auditResponseSerializer(res) {
                if (!res)
                    return (false);

                return ({
                    statusCode: res.statusCode,
                    headers: res._headers,
                    trailer: res._trailer || false,
                    body: getResponseBodyToLog(res, options.responseBody)
                });
            }
        }
    });

    function audit(req, res, route, err) {
        var latency = res.get('Response-Time');
        if (typeof (latency) !== 'number')
            latency = Date.now() - req._time;

        // Censor passwords as best we can for audit logs.
        if (req.headers['x-registry-auth'] !== undefined) {
            req.headers['x-registry-auth'] = '(censored)';
        }
        if (req.headers['x-registry-config'] !== undefined) {
            req.headers['x-registry-config'] = '(censored)';
        }
        if (route && route.name === 'auth') {
            if (req && req.body && req.body.password) {
                req.body.password = '(censored)';
            }
        }

        var obj = {
            remoteAddress: req.connection.remoteAddress,
            remotePort: req.connection.remotePort,
            req_id: req.getId(),
            req: req,
            res: res,
            err: err,
            latency: latency,
            secure: req.secure,
            _audit: true
        };

        log.info(obj, 'handled: %d', res.statusCode);

        return (true);
    }

    return (audit);
}


///-- Exports

module.exports = auditLogger;
