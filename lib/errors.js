/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * SDC Docker error responses.
 *
 * We have three main goals here:
 * 1. Respond with meaningful error responses that don't expose internal and
 *    implementation details.
 * 2. Log relevant error details for debugging and analysis.
 * 3. Have a reasonably elegant API for raising errors in the sdc-docker code.
 *
 * One of the main source of error information is the error responses from
 * internal SDC APIs (VMAPI, CNAPI, etc.). Goal #1 basically means whitelisting
 * details from internal errors.
 *
 *
 * Errors in Bunyan logs:
 *      ...
 *      "err": {
 *        "message": "problem creating contai...",
 *        "name": "WError",
 *        "stack": "SDCClientError: problem creating contai..."
 *        "code": "ValidationFailed",
 *        "errors": [
 *          {
 *            "field": "alias",
 *            "code": "Duplicate",
 *            "message": "Already exists for this owner_uuid"
 *          }
 *        ]
 *      },
 *      ...
 *
 *
 * Guidelines for sdc-docker errors:
 *
 * - Never return a raw internal SDC API error. Always wrap them with one of
 *   the `errors.${api}ErrorWrap` methods:
 *          callback(errors.vmapiErrorWrap(
 *              err, 'problem creating container'));
 *   or using one of the error classes in this module, e.g.:
 *          res.send(new errors.NotImplementedError('docker history'));
 *
 * - If using the generic `DockerError` class, pass in any "cause" err:
 *          callback(new errors.DockerError(err, 'blah blah blah'));
 *   That cause isn't exposed to the docker client, but *it is logged*.
 *
 * - If there is a useful class of errors, then create a custom error class
 *   for it. E.g. 'NotImplementedError'. A custom class has three effects:
 *      (a) its restCode is logged as `err.code`
 *      (b) its restCode is shown in the client-side error message, e.g.:
 *              FATA[0000] Error response from daemon: (ValidationFailed) pro...
 *                                                      ^^^^^^^^^^^^^^^^
 *      (c) it is easy to grep for that class of errors in sdc-docker code.
 *
 *
 * Error Hierarchy:
 *
 *  verror.WError
 *    restify.HttpError
 *      restify.RestError
 *
 *        # The subset of core restify errors that are used.
 *        restify.ForbiddenError
 *        ...
 *
 *        # Customized restify core errors.
 *        UnauthorizedError
 *
 *        # SDC Docker-specific hierarchy.
 *        _DockerBaseError
 *          DockerError          500; generic catch all
 *
 *          # Custom sdc-docker-defined errors.
 *          CommandTimeoutError     # 500, from cnapi.TaskTimeout
 *          NotImplementedError     # 400
 *          ...
 *
 *          # Errors used by the `${api}ErrorWrap` methods
 *          SDCError             500; error from sdc-clients req; details
 *                               *not* exposed; restCode is 'DockerError'
 *          ExposedSDCError      sdc-client req; expose body.errors, restCode
 *                               and statusCode; the restCode is that of the
 *                               cause error, e.g. 'ValidationError' from
 *                               VMAPI.
 */

var assert = require('assert-plus');
var restify = require('restify');
var util = require('util');



// ---- globals

var p = console.warn;
var fmt = util.format;
var RestError = restify.RestError;



// ---- exported functions

/**
 * Extend the default Restify 'text/plain' formatter to include the
 * `err.restCode` string in returned error messages.
 */
function formatErrOrText(req, res, body) {
    if (body instanceof Error) {
        res.statusCode = body.statusCode || 500;
        if (body.restCode && body.restCode !== 'DockerError') {
            body = fmt('(%s) %s', body.restCode, body.message);
        } else {
            body = body.message;
        }
        body += ' (' + req.getId() + ')';

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



// ---- specialized base restify error classes

/**
 * Specialized `restify.UnauthorizedError` to ensure we always (a) have a
 * response body (because the `docker` CLI prints that body) and (b) always
 * have that body be "Unauthorized" to not accidentally leak auth details.
 */
function UnauthorizedError(cause) {
    if (cause) {
        restify.UnauthorizedError.call(this, cause, 'Unauthorized');
    } else {
        restify.UnauthorizedError.call(this, 'Unauthorized');
    }
}
util.inherits(UnauthorizedError, restify.UnauthorizedError);



// ---- SDC Docker-specific error class hierarch

/**
 * Base class for all of our SDC Docker errors. This shouldn't be exported,
 * because all usages should be of one of the subclasses.
 *
 * This is a light wrapper around RestError to add some common `cause.body`
 * attributes for logging.
 */
function _DockerBaseError(opts) {
    assert.object(opts, 'opts');
    RestError.call(this, opts);
    if (opts.cause && opts.cause.body) {
        this.body.errors = opts.cause.body.errors;
    }
}
util.inherits(_DockerBaseError, RestError);


/**
 * The generic catch-all error to throw if there isn't a specific error class.
 *
 * Usage:
 *      new DockerError(message);
 *      new DockerError(cause, message);
 */
function DockerError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message, 'message');
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: (cause && cause.statusCode) || this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(DockerError, _DockerBaseError);
DockerError.prototype.name = 'DockerError';
DockerError.restCode = 'DockerError';
DockerError.statusCode = 500;
DockerError.description =
    'Encountered an internal error while fulfilling request.';


/**
 * TODO(trentm): call this just "TimeoutError"?
 */
function CommandTimeoutError(cause) {
    assert.object(cause, 'cause');
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: 'timed-out waiting for request response',
        cause: cause
    });
}
util.inherits(CommandTimeoutError, _DockerBaseError);
CommandTimeoutError.prototype.name = 'CommandTimeoutError';
CommandTimeoutError.restCode = 'CommandTimeout';
CommandTimeoutError.statusCode = 500;
CommandTimeoutError.description = 'Timed-out waiting for request response.';


/**
 * When there isn't an available package that is big enough for the
 * requested container constraints (memory, cpu-shares).
 *
 * @param constraints {Object} key/value of requesting container limits, e.g.:
 *      `{memory: '65g'}`.
 */
function NoSufficientPackageError(constraints) {
    assert.object(constraints, 'constraints');

    var msg = 'no package supports the given container constraints: '
        + Object.keys(constraints).map(
            function (c) { return fmt('%s=%s', c, constraints[c]); })
            .join(', ');
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: msg
    });
}
util.inherits(NoSufficientPackageError, _DockerBaseError);
NoSufficientPackageError.prototype.name = 'NoSufficientPackageError';
NoSufficientPackageError.restCode = 'NoSufficientPackage';
NoSufficientPackageError.statusCode = 422;
NoSufficientPackageError.description =
    'No package in the DC supports the requested container constraints.';


function NotImplementedError(feature) {
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: feature + ' is not implemented'
    });
}
util.inherits(NotImplementedError, _DockerBaseError);
NotImplementedError.prototype.name = 'NotImplementedError';
NotImplementedError.restCode = 'NotImplemented';
NotImplementedError.statusCode = 400;
NotImplementedError.description =
    'Attempt to use a feature that is not yet implemented';


/**
 * An error used to expose the error from a node-sdc-clients API request.
 *
 * This *prefers* they are following:
 *      https://github.com/joyent/eng/blob/master/docs/index.md#error-handling
 * but we have enough exceptions, even in APIs like IMGAPI that try hard
 * to be defensive.
 */
function ExposedSDCError(cause, message) {
    assert.object(cause, 'cause');
    assert.string(message, 'message');
    assert.string(cause.restCode, 'cause.restCode');
    assert.optionalObject(cause.body, 'cause.body');
    var body = cause.body || {};
    assert.optionalString(body.message, 'cause.body.message');

    var fullMsg = fmt('%s: %s', message,
        body.message || cause.message || cause.toString());
    if (body.errors) {
        var errMsgs = [];
        body.errors.forEach(function (e) {
            if (e.message) {
                errMsgs.push(fmt('"%s" (%s) %s', e.field, e.code, e.message));
            } else {
                errMsgs.push(fmt('"%s" (%s)', e.field, e.code));
            }
        });
        fullMsg += ': ' + errMsgs.join(', ');
    }

    _DockerBaseError.call(this, {
        cause: cause,
        message: fullMsg,
        restCode: cause.restCode,
        statusCode: cause.statusCode
    });
    if (body.errors) {
        this.body.errors = body.errors;
    }
}
util.inherits(ExposedSDCError, _DockerBaseError);



// ---- wrappers for API responses

function vmapiErrorWrap(cause, message) {
    if (!cause) {
        return cause;
    } else if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        case 'ValidationFailed':
            return new ExposedSDCError(cause, message);

        /* By default don't expose internal error message details. */
        default:
            return new DockerError(cause, message);
    }
}


function cnapiErrorWrap(cause, message) {
    if (!cause) {
        return cause;
    } else if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        case 'TaskTimeout':
            // TODO(orlando): Throw away this 'message' here?
            return new CommandTimeoutError(cause, message);

        /* Others */

        default:
            return new DockerError(cause, message);
    }
}


function papiErrorWrap(cause, message) {
    if (!cause) {
        return cause;
    } else if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        /* Others */

        default:
            return new DockerError(cause, message);
    }
}


function imgapiErrorWrap(cause, message) {
    if (!cause) {
        return cause;
    } else if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        /* Others */

        default:
            return new DockerError(cause, message);
    }
}


function napiErrorWrap(cause, message) {
    if (!cause) {
        return cause;
    } else if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        /* Others */

        default:
            return new DockerError(cause, message);
    }
}



// ---- exports

module.exports = {
    formatErrOrText: formatErrOrText,

    InternalError: restify.InternalError,
    ResourceNotFoundError: restify.ResourceNotFoundError,
    InvalidHeaderError: restify.InvalidHeaderError,
    ServiceUnavailableError: restify.ServiceUnavailableError,
    ForbiddenError: restify.ForbiddenError,
    BadRequestError: restify.BadRequestError,

    UnauthorizedError: UnauthorizedError,

    DockerError: DockerError,
    CommandTimeoutError: CommandTimeoutError,
    NoSufficientPackageError: NoSufficientPackageError,
    NotImplementedError: NotImplementedError,

    cnapiErrorWrap: cnapiErrorWrap,
    imgapiErrorWrap: imgapiErrorWrap,
    napiErrorWrap: napiErrorWrap,
    papiErrorWrap: papiErrorWrap,
    vmapiErrorWrap: vmapiErrorWrap
};
