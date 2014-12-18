/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * image model
 */

var assert = require('assert-plus');
var moray = require('../moray');
var util = require('util');
var vasync = require('vasync');


// --- Globals



var BUCKET = {
    desc: 'docker image',
    name: 'docker_images',
    schema: {
        index: {
            docker_id: { type: 'string' },
            owner_uuid: { type: 'string' }
        }
    }
};



// --- Helpers


// --- Image object


/**
 * Image model constructor
 */
function Image(params) {
    assert.object(params, 'image params');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.tag, 'params.tag');

    this.params = params;

    this.__defineGetter__('docker_id', function () {
        return this.params.docker_id;
    });
    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
}


/**
 * Returns the raw form of the image suitable for storing in moray,
 * which is the same as the serialized form
 */
Image.prototype.raw = Image.prototype.serialize = function () {
    return {
        docker_id: this.params.docker_id,
        owner_uuid: this.params.owner_uuid
    };
};



// --- Exported functions



/**
 * Creates a image
 */
function createImage(app, log, params, callback) {
    log.debug({ params: params }, 'createImage: entry');

    var tag = new Image(params);
    app.moray.putObject(BUCKET.name, tag.docker_id, tag.raw(),
        function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, tag);
    });
}


/**
 * Gets an image
 */
function getImage(app, log, params, callback) {
    log.debug(params, 'getImage: entry');

    moray.getObj(app.moray, BUCKET, params.docker_id,
        function (err, rec) {
        if (err) {
            return callback(err);
        }

        return callback(null, new Image(rec.value));
    });
}


/**
 * Lists all images
 */
function listImages(app, log, params, callback) {
    log.debug(params, 'listImages: entry');

    if (!Object.keys(params).length) {
        params = '(docker_id=*)';
    }

    moray.listObjs({
        filter: params,
        log: log,
        bucket: BUCKET,
        model: Image,
        moray: app.moray,
        sort: {
            attribute: 'name',
            order: 'ASC'
        }
    }, callback);
}


/**
 * Updates an image
 */
function updateImage(app, log, params, callback) {
    log.debug(params, 'updateImage: entry');

    var tag = new Image(params);
    app.moray.putObject(BUCKET.name, tag.docker_id, tag.raw(),
        function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, tag);
    });
}


/**
 * Deletes an image
 */
function deleteImage(app, log, params, callback) {
    log.debug(params, 'deleteImage: entry');

    moray.delObj(app.moray, BUCKET, params.docker_id, function (err) {
        if (err) {
            return callback(err);
        }

        return callback();
    });
}

/**
 * Initializes the images bucket
 */
function initImagesBucket(app, callback) {
    moray.initBucket(app.moray, BUCKET, callback);
}


module.exports = {
    create: createImage,
    del: deleteImage,
    get: getImage,
    init: initImagesBucket,
    list: listImages,
    Image: Image,
    update: updateImage
};
