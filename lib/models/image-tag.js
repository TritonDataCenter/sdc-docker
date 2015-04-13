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
var format = require('util').format;
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
            repo: { type: 'string' },
            tag: { type: 'string' }
        }
    },
    version: 2
};

var IMAGE_TAG_KEY_FMT = '%s-%s-%s';



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
    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
    this.__defineGetter__('repo', function () {
        return this.params.repo;
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
    var key = format(IMAGE_TAG_KEY_FMT, tag.owner_uuid, tag.docker_id, tag.tag);
    app.moray.putObject(BUCKET.name, key, tag.raw(), function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, tag);
    });
}


/**
 * Puts an image tag. This operation ensure that there is only one pair of
 * name/repo/tag for a docker image at any time. Image tags can change
 * so a single tag can be updated to point to another docker_id.
 */
function putImageTag(app, log, params, callback) {
    log.debug({ params: params }, 'putImageTag: entry');

    var deleteOld = true;
    var newTag = new ImageTag(params);
    var oldTag;

    vasync.pipeline({ funcs: [
        getTag,
        createTag,
        deleteTag
    ]}, function (err) {
        if (err) {
            log.error({err: err}, 'Error running putImageTag');
            callback(err);
            return;
        }

        callback(null, newTag);
    });

    function getTag(_, cb) {
        var getParams = {
            repo: params.repo,
            owner_uuid: params.owner_uuid,
            tag: params.tag
        };

        listImageTags(app, log, getParams, function (err, tags) {
            if (err) {
                cb(err);
                return;
            } else if (tags.length) {
                oldTag = tags[0];
            }

            cb();
        });
    }

    function createTag(_, cb) {
        if (oldTag && oldTag.docker_id === newTag.docker_id) {
            deleteOld = false;
            cb();
            return;
        }

        var key = format(IMAGE_TAG_KEY_FMT,
            newTag.owner_uuid, newTag.docker_id, newTag.tag);
        app.moray.putObject(BUCKET.name, key, newTag.raw(), cb);
    }

    function deleteTag(_, cb) {
        if (!oldTag || !deleteOld) {
            cb();
            return;
        }

        deleteImageTag(app, log, oldTag, cb);
    }
}


/**
 * Lists all image tags
 */
function listImageTags(app, log, params, callback) {
    log.trace(params, 'listImageTags: entry');

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
    app.moray.putObject(BUCKET.name, params.key, tag.raw(), function (err) {
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
    assert.object(params, 'image params');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.tag, 'params.tag');

    var key = format(IMAGE_TAG_KEY_FMT,
        params.owner_uuid, params.docker_id, params.tag);
    moray.delObj(app.moray, BUCKET, key, function (err) {
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
    moray.initBucket(app.moray, BUCKET, function (err, updated) {
        if (err) {
            callback(err);
            return;
        }

        // Run migrations when the bucket needed to be updated
        if (updated) {
            migrate(app, callback);
        } else {
            callback();
        }
    });
}


/**
 * Every funtion should just take care of replacing the column with a new
 * value, or just return if it doesn't apply. When an updated object needs
 * to be written every function should push a new item to the batch array.
 */
var migrations = [
    _tagStringToArray
];


/*
 * This migration will update all object keys from
 *   owner_uuid-docker_id to owner_uuid-docker_id-tag
 */
function _tagStringToArray(key, value, batch) {
    // Ignore every object that was already migrated.
    if (key.split('-').length > 6) {
        return;
    }

    var newKey = format(IMAGE_TAG_KEY_FMT, value.owner_uuid,
        value.docker_id, value.tag);

    // Add new object and delete old one
    batch.push({
        bucket: BUCKET.name,
        key: newKey,
        value: value
    }, {
        bucket: BUCKET.name,
        operation: 'delete',
        key: key
    });
}

function migrate(app, callback) {
    assert.object(app, 'app');
    assert.object(app.moray, 'app.moray');
    assert.object(app.log, 'app.log');
    assert.arrayOfFunc(migrations, 'migrations');

    var log = app.log;

    vasync.forEachPipeline({
        func: migrateVersion,
        inputs: migrations
    }, function (err) {
        if (err) {
            log.error(err, 'Could not migrate bucket %s', BUCKET.name);
            callback(err);
            return;
        }

        callback();
    });

    function migrateVersion(fn, cb) {
        var batch = [];
        var req = app.moray.sql('select * from ' + BUCKET.name);

        req.once('error', function (err) {
            cb(err);
        });

        req.on('record', function (obj) {
            var key = obj._key;
            var value = JSON.parse(obj._value);
            fn.call(null, key, value, batch);
        });

        req.on('end', function () {
            app.moray.batch(batch, function (bErr) {
                if (bErr) {
                    log.error(bErr, 'Migration function %s failed for '
                        + 'bucket %s', fn.name, BUCKET.name);
                    cb(bErr);
                    return;
                }

                log.info('Migration function %s succeeded for '
                        + 'bucket %s', fn.name, BUCKET.name);
                cb();
            });
        });
    }
}


module.exports = {
    create: createImageTag,
    del: deleteImageTag,
    init: initImageTagsBucket,
    list: listImageTags,
    ImageTag: ImageTag,
    put: putImageTag,
    update: updateImageTag
};
