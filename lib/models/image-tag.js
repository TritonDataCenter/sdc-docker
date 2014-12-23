/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * image tag model
 */

var assert = require('assert-plus');
var moray = require('../moray');
var util = require('util');
var vasync = require('vasync');


// --- Globals



var BUCKET = {
    desc: 'docker image tag',
    name: 'docker_image_tags',
    schema: {
        index: {
            docker_id: { type: 'string' },
            name: { type: 'string' },
            owner_uuid: { type: 'string' },
            tag: { type: 'string' }
        }
    }
};



// --- Helpers


// --- ImageTag object


/**
 * ImageTag model constructor
 */
function ImageTag(params) {
    assert.object(params, 'image tag params');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.name, 'params.name');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.repo, 'params.repo');
    assert.string(params.tag, 'params.tag');

    this.params = params;

    this.__defineGetter__('docker_id', function () {
        return this.params.docker_id;
    });
    this.__defineGetter__('name', function () {
        return this.params.name;
    });
    this.__defineGetter__('tag', function () {
        return this.params.tag;
    });
}


/**
 * Returns the raw form of the image tag suitable for storing in moray,
 * which is the same as the serialized form
 */
ImageTag.prototype.raw = ImageTag.prototype.serialize = function () {
    return {
        docker_id: this.params.docker_id,
        name: this.params.name,
        owner_uuid: this.params.owner_uuid,
        repo: this.params.repo,
        tag: this.params.tag
    };
};



// --- Exported functions



/**
 * Creates a image tag
 */
function createImageTag(app, log, params, callback) {
    log.debug({ params: params }, 'createImageTag: entry');

    var tag = new ImageTag(params);
    app.moray.putObject(BUCKET.name, tag.docker_id, tag.raw(),
        function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, tag);
    });
}


/**
 * Gets an image tag
 */
function getImageTag(app, log, params, callback) {
    log.debug(params, 'getImageTag: entry');

    moray.getObj(app.moray, BUCKET, params.docker_id,
        function (err, rec) {
        if (err) {
            return callback(err);
        }

        return callback(null, new ImageTag(rec.value));
    });
}


/**
 * Lists all image tags
 */
function listImageTags(app, log, params, callback) {
    log.debug(params, 'listImageTags: entry');

    if (!Object.keys(params).length) {
        params = '(docker_id=*)';
    }

    moray.listObjs({
        filter: params,
        log: log,
        bucket: BUCKET,
        model: ImageTag,
        moray: app.moray
    }, callback);
}


/**
 * Updates an image tag
 */
function updateImageTag(app, log, params, callback) {
    log.debug(params, 'updateImageTag: entry');

    var tag = new ImageTag(params);
    app.moray.putObject(BUCKET.name, tag.docker_id, tag.raw(),
        function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, tag);
    });
}


/**
 * Deletes an image tag
 */
function deleteImageTag(app, log, params, callback) {
    log.debug(params, 'deleteImageTag: entry');

    moray.delObj(app.moray, BUCKET, params.docker_id, function (err) {
        if (err) {
            return callback(err);
        }

        return callback();
    });
}

/**
 * Initializes the image tags bucket
 */
function initImageTagsBucket(app, callback) {
    moray.initBucket(app.moray, BUCKET, callback);
}


module.exports = {
    create: createImageTag,
    del: deleteImageTag,
    get: getImageTag,
    init: initImageTagsBucket,
    list: listImageTags,
    ImageTag: ImageTag,
    update: updateImageTag
};
