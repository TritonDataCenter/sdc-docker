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
var drc = require('docker-registry-client');
var imgmanifest = require('imgmanifest');
var moray = require('../moray');
var util = require('util');
var vasync = require('vasync');

var ImageTag = require('./image-tag');

// --- Globals



var BUCKET = {
    desc: 'docker image',
    name: 'docker_images',
    schema: {
        index: {
            docker_id: { type: 'string' },
            head: { type: 'boolean' },
            image_uuid: { type: 'string' },
            index_name: { type: 'string' },
            owner_uuid: { type: 'string' },
            parent: { type: 'string' },
            heads: { type: '[string]' }
        }
    },
    version: 3
};



// --- Helpers


// --- Image object


/**
 * Image model constructor
 */
function Image(params) {
    assert.object(params, 'image params');
    assert.number(params.created, 'params.created');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.image_uuid, 'params.image_uuid');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.optionalArrayOfString(params.heads, 'params.heads');
    assert.number(params.size, 'params.size');
    assert.number(params.virtual_size, 'params.virtual_size');
    assert.optionalObject(params.config, 'params.config');
    assert.optionalObject(params.container_config, 'params.container_config');
    assert.optionalString(params.parent, 'params.parent');

    this.params = params;
    if (!this.params.heads)
        this.params.heads = [];

    this.__defineGetter__('container_config', function () {
        return this.params.container_config;
    });
    this.__defineGetter__('created', function () {
        return this.params.created;
    });
    this.__defineGetter__('docker_id', function () {
        return this.params.docker_id;
    });
    this.__defineGetter__('image_uuid', function () {
        return this.params.image_uuid;
    });
    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
    this.__defineGetter__('parent', function () {
        return this.params.parent;
    });
    this.__defineGetter__('refcount', function () {
        return this.params.heads.length;
    });
    this.__defineGetter__('size', function () {
        return this.params.size;
    });
}


/**
 * Returns the raw form of the image suitable for storing in moray,
 * which is the same as the serialized form
 */
Image.prototype.raw = Image.prototype.serialize = function () {
    return {
        created: this.params.created,
        config: this.params.config,
        container_config: this.params.container_config,
        docker_id: this.params.docker_id,
        head: this.params.head,
        image_uuid: this.params.image_uuid,
        owner_uuid: this.params.owner_uuid,
        parent: this.params.parent,
        heads: this.params.heads,
        size: this.params.size,
        virtual_size: this.params.virtual_size
    };
};



// --- Exported functions



/**
 * Creates a image
 */
function createImage(app, log, params, callback) {
    log.debug({ params: params }, 'createImage: entry');

    var image = new Image(params);
    var key = image.owner_uuid + '-' + image.docker_id;
    app.moray.putObject(BUCKET.name, key, image.raw(), function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, image);
    });
}


/**
 * Lists all images
 */
function listImages(app, log, params, callback) {
    log.trace(params, 'listImages: entry');

    if (!Object.keys(params).length) {
        params = '(docker_id=*)';
    }

    // XXX listObjs says 'filter' should be a string, but we pass an obj here
    moray.listObjs({
        filter: params,
        log: log,
        bucket: BUCKET,
        model: Image,
        moray: app.moray
    }, callback);
}


/**
 * Updates an image
 */
function updateImage(app, log, params, callback) {
    log.debug(params, 'updateImage: entry');
    assert.object(params, 'image params');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.owner_uuid, 'params.owner_uuid');

    var key = params.owner_uuid + '-' + params.docker_id;
    moray.updateObj({
        moray: app.moray,
        bucket: BUCKET,
        key: key,
        val: params
    }, function (err, rec) {
        if (err) {
            return callback(err);
        }

        return callback(null, new Image(rec.value));
    });
}


/**
 * Deletes an image
 */
function deleteImage(app, log, params, callback) {
    log.debug(params, 'deleteImage: entry');
    assert.object(params, 'image params');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.owner_uuid, 'params.owner_uuid');

    var key = params.owner_uuid + '-' + params.docker_id;
    moray.delObj(app.moray, BUCKET, key, function (err) {
        if (err) {
            return callback(err);
        }

        return callback();
    });
}


/**
 * Gets the datacenter refcount for the ancestry of an image layer.
 * This query allows us to know which image layers are no longer being
 * used by other users. When refcount is 1, it means that we can move
 * the image layer to the tombstones table. Example:
 *
 * Before deleting docker_id=868be653dea3 we want to check which of its
 * children is being used at least 2 times by other users:
 *
 * select docker_id, count(docker_id)
 *  from docker_images
 *  where docker_id in
 *    (select docker_id
 *      from docker_images
 *      where '868be653dea3...'=any(heads)
 *    )
 *  group by docker_id
 *  having count(docker_id) > 1;
 *
 * docker_id      | count
 * ---------------+------
 * 511136ea3c5... |     2
 */
function datacenterRefcount(app, log, params, callback) {
    assert.object(params, 'image params');
    assert.string(params.docker_id, 'params.docker_id');
    assert.optionalNumber(params.limit, 'params.limit');
    var client = app.moray;

    var query = [
        'select docker_id, count(docker_id) from',
        BUCKET.name,
        'where docker_id in (select docker_id from',
        BUCKET.name,
        'where \'' + params.docker_id + '\'=any(heads))',
        'group by docker_id'
    ];

    if (params.limit) {
        query.push('having count(docker_id) <= ' + params.limit);
    }

    var count = {};
    query = query.join(' ');
    var req = client.sql(query);

    req.on('record', function (rec) {
        count[rec.docker_id] = Number(rec.count);
    });

    req.on('error', function (err) {
        callback(err);
    });

    req.on('end', function () {
        callback(null, count);
    });
}


/**
 * Every funtion should just take care of replacing the column with a new
 * value, or just return if it doesn't apply. When an updated object needs
 * to be written every function should push a new item to the batch array.
 */
var migrations = [
    {
        fn: _addIndexName,
        pre: _getRepos,
        version: 2
    },
    {
        fn: _updateImageUuids,
        pre: _getRepos,
        version: 3
    }
];


function _getRepos(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.migration, 'opts.migration');

    var app = opts.app;
    var log = app.log;
    var repos = {};

    log.info('[_getRepos] Running pre function for migration %s',
        opts.migration.fn.name);

    ImageTag.list(app, log, {}, function (err, imageTags) {
        if (err) {
            cb(err);
            return;
        }

        imageTags.forEach(function (imageTag) {
            repos[imageTag.docker_id] = imageTag.repo;
        });

        cb(null, { repos: repos });
    });
}


/*
 * This migration will populate the index_name column values
 *   with the index.name value from parseRepo(). This migration
 *   will be run to support private registries, so the initial
 *   state will be public registries only, which means docker_ids
 *   are unique.
 *
 *  opts.context comes from _getRepos
 */
function _addIndexName(opts) {
    assert.object(opts, 'opts');

    var batch = opts.batch;
    var key = opts.key;
    var value = opts.value;
    var log = opts.log;

    if (value.index_name !== undefined) {
        return;
    }

    var repos = opts.context.repos;
    var head = value.heads[0];

    if (repos[head] === undefined) {
        log.warn('[_addIndexName] ImageTag repo was not found for docker_id'
            + ': %s (head docker_id: %s)', value.docker_id, head);
    }

    var indexName = drc.parseRepo(repos[head]).index.name;
    value.index_name = indexName;

    batch.push({
        bucket: BUCKET.name,
        key: key,
        value: value
    });
}


/*
 * This migration will update the image_uuid values on every docker_image
 *   with a new UUID computed from docker_id and index_name
 */
function _updateImageUuids(opts) {
    assert.object(opts, 'opts');

    var batch = opts.batch;
    var key = opts.key;
    var value = opts.value;

    var uuid = imgmanifest.imgUuidFromDockerInfo({
        id: value.docker_id,
        indexName: value.index_name
    });
    value.image_uuid = uuid;

    batch.push({
        bucket: BUCKET.name,
        key: key,
        value: value
    });
}


/**
 * Initializes the images bucket
 */
function initImagesBucket(app, callback) {
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
    create: createImage,
    del: deleteImage,
    init: initImagesBucket,
    list: listImages,
    Image: Image,
    update: updateImage,
    datacenterRefcount: datacenterRefcount
};
