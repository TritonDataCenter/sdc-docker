/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');
var RestError = restify.RestError;
var util = require('util');

function CommandTimeoutError(cause) {
    var message =
        'timed-out waiting for request response';
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(CommandTimeoutError, RestError);
CommandTimeoutError.prototype.name = 'CommandTimeoutError';
CommandTimeoutError.restCode = 'CommandTimeout';
CommandTimeoutError.statusCode = 500;
CommandTimeoutError.description =
    'Timed-out waiting for request response.';



function DockerError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        cause: cause
    });
}
util.inherits(DockerError, RestError);
DockerError.prototype.name = 'DockerError';
DockerError.restCode = 'DockerError';
DockerError.statusCode = 500;
DockerError.description =
    'Encountered an internal error while fulfilling request.';



function NotImplementedError(feature) {
    var message =
        feature + ' not implemented';
    RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message
    });
}
util.inherits(NotImplementedError, RestError);
NotImplementedError.prototype.name = 'NotImplementedError';
NotImplementedError.restCode = 'NotImplemented';
NotImplementedError.statusCode = 400;
NotImplementedError.description =
    'This feature is not yet implemented';


function vmapiErrorWrap(cause, message) {
    if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        /* VMAPI error codes */
        default:
            return new DockerError(cause, message);
    }
}



function cnapiErrorWrap(cause, message) {
    if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        case 'TaskTimeout':
            return new CommandTimeoutError(cause, message);

        /* Others */

        default:
            return new DockerError(cause, message);
    }
}



function papiErrorWrap(cause, message) {
    if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        /* Others */

        default:
            return new DockerError(cause, message);
    }
}


function imgapiErrorWrap(cause, message) {
    if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        /* Others */

        default:
            return new DockerError(cause, message);
    }
}


function napiErrorWrap(cause, message) {
    if (!cause.restCode) {
        return new DockerError(cause, message);
    }

    switch (cause.restCode) {
        /* Others */

        default:
            return new DockerError(cause, message);
    }
}


module.exports = {
    InternalError: restify.InternalError,
    ResourceNotFoundError: restify.ResourceNotFoundError,
    InvalidHeaderError: restify.InvalidHeaderError,
    ServiceUnavailableError: restify.ServiceUnavailableError,
    UnauthorizedError: restify.UnauthorizedError,
    BadRequestError: restify.BadRequestError,
    CommandTimeoutError: CommandTimeoutError,
    NotImplementedError: NotImplementedError,
    DockerError: DockerError,
    vmapiErrorWrap: vmapiErrorWrap,
    cnapiErrorWrap: cnapiErrorWrap,
    imgapiErrorWrap: imgapiErrorWrap,
    papiErrorWrap: papiErrorWrap
};
