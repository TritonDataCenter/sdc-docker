/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tombstone image model
 */

var assert = require('assert-plus');
var moray = require('../moray');
var util = require('util');
var vasync = require('vasync');


// --- Globals



var BUCKET = {
    desc: 'docker_tombstone_image',
    name: 'docker_tombstone_images',
    schema: {
        index: {
            docker_id: { type: 'string' },
            image_uuid: { type: 'string' },
            expires_at: { type: 'number' }
        }
    },
    version: 1
};



// --- Helpers


// --- TombstoneImage object


/**
 * TombstoneImage model constructor
 */
function TombstoneImage(params) {
    assert.object(params, 'image params');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.image_uuid, 'params.image_uuid');
    assert.number(params.expires_at, 'params.expires_at');

    this.params = params;

    this.__defineGetter__('docker_id', function () {
        return this.params.docker_id;
    });
    this.__defineGetter__('image_uuid', function () {
        return this.params.image_uuid;
    });
}


/**
 * Returns the raw form of the image suitable for storing in moray,
 * which is the same as the serialized form
 */
TombstoneImage.prototype.raw =
TombstoneImage.prototype.serialize = function () {
    return {
        docker_id: this.params.docker_id,
        image_uuid: this.params.image_uuid,
        expires_at: this.params.expires_at
    };
};



// --- Exported functions



/**
 * Creates a image
 */
function createTombstoneImage(app, log, params, callback) {
    log.debug({ params: params }, 'createTombstoneImage: entry');

    if (!params.expires_at) {
        var lifespanDays = app.config.tombstoneImageLifespanDays || 7;
        var expires = new Date();
        expires.setDate(expires.getDate() + lifespanDays);
        params.expires_at = expires.getTime();
    }

    var image = new TombstoneImage(params);
    var key = image.docker_id;
    app.moray.putObject(BUCKET.name, key, image.raw(), function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, image);
    });
}


/**
 * Gets an image
 */
function getTombstoneImage(app, log, params, callback) {
    log.trace(params, 'getTombstoneImage: entry');

    moray.getObj(app.moray, BUCKET, params.docker_id, function (err, rec) {
        if (err) {
            return callback(err);
        }

        return callback(null, new TombstoneImage(rec.value));
    });
}


/**
 * Lists all images
 */
function listTombstoneImages(app, log, params, callback) {
    log.trace(params, 'listTombstoneImages: entry');

    if (!Object.keys(params).length) {
        params = '(docker_id=*)';
    }

    moray.listObjs({
        filter: params,
        log: log,
        bucket: BUCKET,
        model: TombstoneImage,
        moray: app.moray
    }, callback);
}


/**
 * Updates an image
 */
function updateTombstoneImage(app, log, params, callback) {
    log.debug(params, 'updateTombstoneImage: entry');

    var tag = new TombstoneImage(params);
    app.moray.putObject(BUCKET.name, params.docker_id, tag.raw(),
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
function deleteTombstoneImage(app, log, params, callback) {
    log.debug(params, 'deleteTombstoneImage: entry');

    moray.delObj(app.moray, BUCKET, params.docker_id, function (err) {
        if (err) {
            return callback(err);
        }

        return callback();
    });
}


/**
 * Unmarks an image from deletion. This is called when an image layer is
 * created/updated so we make sure to 'undo' having marked it as 'to delete'
 * from a previous pull operation
 */
function unmarkTombstoneImage(app, log, params, callback) {
    log.debug(params, 'unmarkTombstoneImage: entry');

    var key = params.docker_id;
    moray.getObj(app.moray, BUCKET, key, function (err, rec) {
        if (err && err.name !== 'ResourceNotFoundError') {
            callback(err);
            return;
        }

        if (!rec) {
            callback();
            return;
        }

        moray.delObj(app.moray, BUCKET, key, function (delErr) {
            if (delErr) {
                callback(delErr);
                return;
            }

            callback();
        });
    });
}


/**
 * Initializes the images bucket
 */
function initTombstoneImagesBucket(app, callback) {
    moray.initBucket(app.moray, BUCKET, callback);
}


module.exports = {
    create: createTombstoneImage,
    del: deleteTombstoneImage,
    get: getTombstoneImage,
    init: initTombstoneImagesBucket,
    list: listTombstoneImages,
    TombstoneImage: TombstoneImage,
    unmark: unmarkTombstoneImage,
    update: updateTombstoneImage
};
