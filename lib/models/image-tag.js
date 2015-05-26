/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Image tag model.
 *
 * This holds each tagged image for a given account (`owner_uuid`). IOW, this
 * mapping:
 *      (owner_uuid, repo, tag) => docker_id
 */

var assert = require('assert-plus');
var drc = require('docker-registry-client');
var fmt = require('util').format;
var vasync = require('vasync');

var moray = require('../moray');



// --- Globals

var BUCKET = {
    desc: 'docker image tag',
    name: 'docker_image_tags',
    schema: {
        index: {
            // The 64-char Docker image ID
            docker_id: { type: 'string' },
            owner_uuid: { type: 'string' },
            /*
             * The "localName" for the Docker repo. See
             * // JSSTYLED
             * <https://github.com/joyent/node-docker-registry-client/tree/master#names>
             */
            repo: { type: 'string' },
            tag: { type: 'string' },
            /*
             * Storing the index name (a.k.a. the registry host) is somewhat
             * redundant (the 'repo' effective has this information too), we
             * want it for indexed searches: Give an `Image` instance `img` we
             * search by `(img.owner_uuid, img.index_name, img.docker_id)`
             * to find all tags pointing to that image.
             */
            index_name: { type: 'string' }
        }
    },
    version: 5
};



// --- Helpers

function objectKey(params) {
    assert.string(params.owner_uuid, 'params.owner_uuid');
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
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.index_name, 'params.index_name');
    assert.string(params.repo, 'params.repo');
    assert.string(params.tag, 'params.tag');

    this.params = params;

    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
    this.__defineGetter__('index_name', function () {
        return this.params.index_name;
    });
    this.__defineGetter__('repo', function () {
        return this.params.repo;
    });
    this.__defineGetter__('tag', function () {
        return this.params.tag;
    });
    this.__defineGetter__('docker_id', function () {
        return this.params.docker_id;
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
        index_name: this.params.index_name,
        repo: this.params.repo,
        tag: this.params.tag,
        docker_id: this.params.docker_id
    };
};



// --- Exported functions

/**
 * Creates a image tag.
 */
function createImageTag(app, log, params, callback) {
    log.debug({params: params}, 'createImageTag: entry');

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
    log.trace({params: params}, 'listImageTags: entry');

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
 * Deletes an image tag
 */
function deleteImageTag(app, log, params, callback) {
    log.debug({params: params}, 'deleteImageTag: entry');
    var key = objectKey(params);
    moray.delObj(app.moray, BUCKET, key, callback);
}


/**
 * Every funtion should just take care of replacing the column with a new
 * value, or just return if it doesn't apply. When an updated object needs
 * to be written every function should push a new item to the batch array.
 */
var migrations = [
    {
        fn: _migrateTagStringToArray,
        version: 2
    },
    {
        fn: _migrateRepoToLocalName,
        version: 3
    },
    {
        fn: _migrateKeyToIncludeRepo,
        version: 4
    },
    {
        fn: _migrateAddIndexName,
        version: 5
    }
];


/*
 * This migration will update all object keys from
 *   owner_uuid-docker_id to owner_uuid-docker_id-tag
 *
 * Also, the 'name' field is dropped.
 *
 * TODO: Not sure if we should have a sep migration to drop the 'name' column.
 */
function _migrateTagStringToArray(opts) {
    assert.object(opts, 'opts');

    var batch = opts.batch;
    var key = opts.key;
    var value = opts.value;

    // Ignore every object that was already migrated.
    if (key.split('-').length > 6) {
        return;
    }

    var newKey = fmt('%s-%s-%s', value.owner_uuid, value.docker_id, value.tag);
    delete value['name']; // missed this in east3b

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


/*
 * This migration will update the `repo` column value to
 * be the localName value from parseRepo(). This migration
 * is idempotent because we will always be able to get the
 * localName from the repo column
 */
function _migrateRepoToLocalName(opts) {
    assert.object(opts, 'opts');

    var batch = opts.batch;
    var key = opts.key;
    var value = opts.value;
    var newRepo = drc.parseRepo(value.repo).localName;
    value.repo = newRepo;

    batch.push({
        bucket: BUCKET.name,
        key: key,
        value: value
    });
}


/*
 * This migration will update all object keys from:
 *
 *      $owner_uuid-$docker_id-$tag
 *
 * to:
 *
 *      $owner_uuid,$repo,$tag
 *
 * because in a multi-repo world where a given $docker_id can appear twice
 * (separate registries), the former is no longer unique.
 *
 * Also moving to comma (,) separator because '-' is valid in all the other
 * fields.
 */
function _migrateKeyToIncludeRepo(opts) {
    assert.object(opts, 'opts');
    var batch = opts.batch;
    var key = opts.key;
    var value = opts.value;

    /* JSSTYLED */
    var NEW_KEY_RE = /^^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12},[^,]+,[^,]+$/;
    if (NEW_KEY_RE.test(key)) {
        return;
    }

    var newKey = fmt('%s,%s,%s', value.owner_uuid, value.repo, value.tag);

    // Add new object and delete old one.
    assert.ok(newKey !== key);
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

/*
 * This migration adds the 'index_name' field. It can be fully generated from
 * the 'repo' field.
 */
function _migrateAddIndexName(opts) {
    var batch = opts.batch;
    var key = opts.key;
    var value = opts.value;

    value.index_name = drc.parseRepo(value.repo).index.name;
    batch.push({
        bucket: BUCKET.name,
        key: key,
        value: value
    });
}

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
