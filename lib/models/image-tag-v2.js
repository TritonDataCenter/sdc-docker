/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Image tag v2 model - to be used with ImageV2 objects.
 *
 * This holds each tagged image for a given account (`owner_uuid`). IOW, this
 * mapping:
 *      (owner_uuid, repo, tag) => ImageV2.config_digest
 */

var assert = require('assert-plus');
var drc = require('docker-registry-client');
var fmt = require('util').format;
var vasync = require('vasync');

var moray = require('../moray');



// --- Globals

var BUCKET = {
    desc: 'docker image tag v2',
    name: 'docker_image_tags_v2',
    schema: {
        index: {
            config_digest: { type: 'string' },
            owner_uuid: { type: 'string' },
            /*
             * The "localName" for the Docker repo. See
             * // JSSTYLED
             * <https://github.com/joyent/node-docker-registry-client/tree/master#overview>
             */
            repo: { type: 'string' },
            tag: { type: 'string' }
        }
    },
    version: 1
};



// --- Helpers

function objectKey(params) {
    assert.uuid(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.repo, 'params.repo');
    assert.string(params.tag, 'params.tag');

    return fmt('%s,%s,%s', params.owner_uuid, params.repo, params.tag);
}


// --- ImageTag object

/**
 * ImageTag model constructor
 */
function ImageTag(params) {
    assert.object(params, 'image tag params');
    assert.string(params.config_digest, 'params.config_digest');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.repo, 'params.repo');
    assert.string(params.tag, 'params.tag');

    this.params = params;

    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
    this.__defineGetter__('repo', function () {
        return this.params.repo;
    });
    this.__defineGetter__('tag', function () {
        return this.params.tag;
    });
    this.__defineGetter__('config_digest', function () {
        return this.params.config_digest;
    });
}


/**
 * Returns the raw form of the image tag suitable for storing in moray,
 * which is the same as the serialized form
 */
ImageTag.prototype.toJSON =
    ImageTag.prototype.raw =
    ImageTag.prototype.serialize =
    function ()
{
    return {
        owner_uuid: this.params.owner_uuid,
        repo: this.params.repo,
        tag: this.params.tag,
        config_digest: this.params.config_digest
    };
};



// --- Exported functions

/**
 * Creates a image tag.
 */
function createImageTag(app, log, params, callback) {
    log.debug({params: params}, 'createImageTagV2: entry');

    var imgTag = new ImageTag(params);
    var key = objectKey(params);
    app.moray.putObject(BUCKET.name, key, imgTag.raw(), function (err) {
        if (err) {
            return callback(err);
        }
        return callback(null, imgTag);
    });
}


/**
 * Lists all image tags
 */
function listImageTags(app, log, params, callback) {
    log.trace({params: params}, 'listImageTagsV2: entry');

    if (!Object.keys(params).length) {
        params = '(config_digest=*)';
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
 * Deletes an image tag
 */
function deleteImageTag(app, log, params, callback) {
    log.debug({params: params}, 'deleteImageTagV2: entry');
    var key = objectKey(params);
    moray.delObj(app.moray, BUCKET, key, callback);
}


/**
 * Every funtion should just take care of replacing the column with a new
 * value, or just return if it doesn't apply. When an updated object needs
 * to be written every function should push a new item to the batch array.
 */
var migrations = [
];


/**
 * Initializes the image tags bucket
 */
function initImageTagsBucket(app, callback) {
    moray.initBucket(app.moray, BUCKET, function (err, updated, fromBucket) {
        if (err) {
            callback(err);
            return;
        }

        // Run migrations when the bucket needed to be updated
        if (updated) {
            moray.migrateObjects({
                app: app,
                bucket: BUCKET,
                fromBucket: fromBucket,
                migrations: migrations
            }, callback);
        } else {
            callback();
        }
    });
}


module.exports = {
    create: createImageTag,
    del: deleteImageTag,
    init: initImageTagsBucket,
    list: listImageTags,
    ImageTag: ImageTag
};
