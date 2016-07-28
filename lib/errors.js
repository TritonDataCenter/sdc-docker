/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
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
 * One of the main sources of error information is the error responses from
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
 *        restify.ResourceNotFoundError
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
 *          # Error used by the `${api}ErrorWrap` methods
 *          ExposedSDCError      sdc-client req; expose body.errors, restCode
 *                               and statusCode; the restCode is that of the
 *                               cause error, e.g. 'ValidationFailedError' from
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
function formatErrOrText(req, res, body, cb) {
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

    // Cheating with internal attribute. THis guard allows us to use this
    // for formatting errors for stream responses.
    if (!res._headerSent) {
        res.setHeader('Content-Length', Buffer.byteLength(body));
    }

    return cb(null, body);
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



// ---- SDC Docker-specific error class hierarchy

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


function ValidationError(cause, message) {
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
util.inherits(ValidationError, _DockerBaseError);
ValidationError.prototype.name = 'ValidationError';
ValidationError.restCode = 'Validation';
ValidationError.statusCode = 422;
ValidationError.description = 'Invalid request payload';


function AmbiguousDockerImageIdError(imgId, registries) {
    assert.string(imgId, 'imgId');
    assert.arrayOfString(registries, 'registries');

    var message = fmt('image id "%s" does not unambiguously identify a '
        + 'single image because it has been pulled from multiple '
        + 'registries: %s; use "repo:tag" if possible', imgId,
        registries.join(', '));
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message
    });
}
util.inherits(AmbiguousDockerImageIdError, _DockerBaseError);
AmbiguousDockerImageIdError.prototype.name = 'AmbiguousDockerImageIdError';
AmbiguousDockerImageIdError.restCode = 'AmbiguousDockerImageId';
AmbiguousDockerImageIdError.statusCode = 422;
AmbiguousDockerImageIdError.description =
    'A Docker image id does not unique identify an image because the '
    + 'same Docker id is pulled from multiple registries';


/*
 * An error to return when a given Docker container ID prefix is required to
 * identify a single docker container uniquely, but instead matches more
 * than one. Optionally pass in the matching `ids` to have those included
 * in the error message.
 */
function AmbiguousDockerContainerIdPrefixError(idPrefix, ids) {
    assert.string(idPrefix, 'idPrefix');
    assert.optionalArrayOfString(ids, 'ids');

    var message = fmt('multiple container IDs match prefix "%s"', idPrefix);
    if (ids && ids.length > 0) {
        message += ': ' + ids.join(', ');
    }
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message
    });
}
util.inherits(AmbiguousDockerContainerIdPrefixError, _DockerBaseError);
AmbiguousDockerContainerIdPrefixError.prototype.name
    = 'AmbiguousDockerContainerIdPrefixError';
AmbiguousDockerContainerIdPrefixError.restCode
    = 'AmbiguousDockerContainerIdPrefix';
AmbiguousDockerContainerIdPrefixError.statusCode = 404;
AmbiguousDockerContainerIdPrefixError.description =
    'A Docker container id prefix matches more than one container.';

/*
 * An error indicating that a supplied query has matched more than one docker
 * network. We expect this to happen only when the user has specified a prefix
 * of an id that matches more than one of their provisionable networks.
 */
function AmbiguousDockerNetworkIdPrefixError(idPrefix, networks) {
    assert.string(idPrefix, 'idPrefix');
    assert.optionalArrayOfString(networks, 'networks');

    var message = fmt('multiple networks match prefix %s', idPrefix);
    if (networks && networks.length > 0) {
        message += ': ' + networks.map(function (net) {
            return fmt('%s/%s', net.name, net.uuid);
        }).join(', ');
    }
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message
    });
}
util.inherits(AmbiguousDockerNetworkIdPrefixError, _DockerBaseError);
AmbiguousDockerNetworkIdPrefixError.prototype.name
    = 'AmbiguousDockerNetworkIdPrefixError';
AmbiguousDockerNetworkIdPrefixError.restCode
    = 'AmbiguousDockerNetworkIdPrefix';
AmbiguousDockerNetworkIdPrefixError.statusCode = 404;
AmbiguousDockerNetworkIdPrefixError.description
    = 'A Docker network id prefix matches more than one network.';

/*
 * Network not found.
 */
function NetworkNotFoundError(network) {
    assert.string(network, 'network');

    var message = fmt('network %s not found', network);
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message
    });
}
util.inherits(NetworkNotFoundError, _DockerBaseError);
NetworkNotFoundError.prototype.name = 'NetworkNotFoundError';
NetworkNotFoundError.prototype.restCode = 'ResourceNotFound';
NetworkNotFoundError.statusCode = 404;
NetworkNotFoundError.description = 'Network not found';

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


/**
 * Error to indicate we are "at capacity" and no servers can accomodate the
 * container requirements.
 *
 * Usage:
 *      new DockerNoComputeResourcesError();
 *      new DockerNoComputeResourcesError(cause);
 */
function DockerNoComputeResourcesError(cause) {
    var message = 'No compute resources available.';
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: (cause && cause.statusCode) || this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(DockerNoComputeResourcesError, _DockerBaseError);
DockerNoComputeResourcesError.prototype.name = 'DockerNoComputeResourcesError';
DockerNoComputeResourcesError.restCode = 'DockerNoComputeResourcesError';
DockerNoComputeResourcesError.statusCode = 409;
DockerNoComputeResourcesError.description = 'No compute resources available.';



/**
 * Error to indicate the server hosting the container we wish to "volumes-from"
 * into our container is unable to meet the resource requirements specified by
 * the provision request.
 *
 * Usage:
 *      new VolumeServerNoResourcesError();
 *      new VolumeServerNoResourcesError(cause);
 */
function VolumeServerNoResourcesError(cause) {
    var message =
        'No compute resources available on the '
        + 'host containing the mounted volume.';
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: (cause && cause.statusCode) || this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(VolumeServerNoResourcesError, _DockerBaseError);
VolumeServerNoResourcesError.prototype.name = 'VolumeServerNoResourcesError';
VolumeServerNoResourcesError.restCode = 'VolumeServerNoResourcesError';
VolumeServerNoResourcesError.statusCode = 409;
VolumeServerNoResourcesError.description =
    'No compute resources available on the host containing the mounted volume';


/**
 * Error to indicate an upstream service dependency is presently unreachable,
 * preventing the sdc-docker service from being able to to confidently execute
 * requests.
 *
 * Usage:
 *      new ServiceDegradedError();
 *      new ServiceDegradedError(cause);
 */
function ServiceDegradedError(cause) {
    var message =
        'service is currently unavailable';
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: (cause && cause.statusCode) || this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(ServiceDegradedError, _DockerBaseError);
ServiceDegradedError.prototype.name =
    'ServiceDegradedError';
ServiceDegradedError.restCode = 'ServiceUnavailableError';
ServiceDegradedError.statusCode = 503;
ServiceDegradedError.description =
    'An upstream service or dependency is currently unreachable';


function DockerContainerNotRunningError(cause, message) {
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: (cause && cause.statusCode) || this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(DockerContainerNotRunningError, _DockerBaseError);
DockerContainerNotRunningError.prototype.name
    = 'DockerContainerNotRunningError';
DockerContainerNotRunningError.restCode = 'DockerContainerNotRunning';
DockerContainerNotRunningError.statusCode = 409;
DockerContainerNotRunningError.description
    = 'Operation attempted on container which is not running';


function FileNotFoundError(cause) {
    var message =
        'no such file or directory';
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: (cause && cause.statusCode) || this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(FileNotFoundError, _DockerBaseError);
FileNotFoundError.prototype.name = 'FileNotFoundError';
FileNotFoundError.restCode = 'FileNotFound';
FileNotFoundError.statusCode = 404;
FileNotFoundError.description = 'no such file or directory';


function PathNotDirectoryError(cause) {
    var message =
        'path was not to a directory';
    _DockerBaseError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: (cause && cause.statusCode) || this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(PathNotDirectoryError, _DockerBaseError);
PathNotDirectoryError.prototype.name = 'PathNotDirectoryError';
PathNotDirectoryError.restCode = 'PathNotDirectory';
PathNotDirectoryError.statusCode = 404;
PathNotDirectoryError.description = 'path was not to a directory';


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

        case 'NoAllocatableServersError':
            return new DockerNoComputeResourcesError();

        case 'VolumeServerNoResourcesError':
            return new VolumeServerNoResourcesError();

        /* By default don't expose internal error message details. */
        default:
            return new DockerError(cause, message);
    }
}


function cnapiErrorWrap(cause, message, extra) {
    assert.optionalObject(extra, 'extra');

    if (!cause) {
        return cause;
    } else if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        case 'TaskTimeout':
            return new CommandTimeoutError(cause);

        case 'FileNotFound':
            return new FileNotFoundError();

        case 'PathNotDirectory':
            return new PathNotDirectoryError();

        case 'VmNotRunning':
            if (extra && extra.id) {
                message = 'Container ' + extra.id + ' is not running';
            } else {
                message = 'Container is not running';
            }
            return new DockerContainerNotRunningError(cause, message);

        /* Others */

        default:
            return new DockerError(cause, message);
    }
}


function fwapiErrorWrap(cause, message) {
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
        case 'VOLUME_ALREADY_EXISTS':
            return new ExposedSDCError(cause, message);

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


function ufdsErrorWrap(cause, message) {
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

function volapiErrorWrap(cause, message) {
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
    ValidationError: ValidationError,
    ServiceDegradedError: ServiceDegradedError,
    DockerContainerNotRunningError: DockerContainerNotRunningError,
    AmbiguousDockerImageIdError: AmbiguousDockerImageIdError,
    AmbiguousDockerContainerIdPrefixError:
        AmbiguousDockerContainerIdPrefixError,
    AmbiguousDockerNetworkIdPrefixError: AmbiguousDockerNetworkIdPrefixError,
    FileNotFoundError: FileNotFoundError,
    NetworkNotFoundError: NetworkNotFoundError,
    PathNotDirectoryError: PathNotDirectoryError,

    cnapiErrorWrap: cnapiErrorWrap,
    fwapiErrorWrap: fwapiErrorWrap,
    imgapiErrorWrap: imgapiErrorWrap,
    napiErrorWrap: napiErrorWrap,
    papiErrorWrap: papiErrorWrap,
    ufdsErrorWrap: ufdsErrorWrap,
    vmapiErrorWrap: vmapiErrorWrap,
    volapiErrorWrap: volapiErrorWrap
};
