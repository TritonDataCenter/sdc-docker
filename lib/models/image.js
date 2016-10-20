/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * image model
 */

var assert = require('assert-plus');
var format = require('util').format;
var imgmanifest = require('imgmanifest');
var once = require('once');
var util = require('util');
var vasync = require('vasync');

var ImageTag = require('./image-tag');
var moray = require('../moray');



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
            // The array of head docker_ids whose history includes this id.
            heads: { type: '[string]' }
        }
    },
    version: 4
};



// --- Helpers

function objectKey(params) {
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.index_name, 'params.index_name');
    assert.string(params.docker_id, 'params.docker_id');

    return format('%s-%s-%s',
        params.owner_uuid,
        params.index_name,
        params.docker_id);
}


// --- Image object


/**
 * Image model constructor
 */
function Image(params) {
    assert.object(params, 'image params');
    assert.finite(params.created, 'params.created');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.image_uuid, 'params.image_uuid');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.optionalArrayOfString(params.heads, 'params.heads');
    assert.finite(params.size, 'params.size');
    assert.finite(params.virtual_size, 'params.virtual_size');
    assert.optionalString(params.architecture, 'params.architecture');
    assert.optionalString(params.comment, 'params.comment');
    assert.optionalObject(params.config, 'params.config');
    assert.optionalObject(params.container_config, 'params.container_config');
    assert.optionalString(params.parent, 'params.parent');
    assert.optionalBool(params.private, 'params.private');
    assert.optionalString(params.author, 'params.author');

    this.params = params;
    if (!this.params.heads)
        this.params.heads = [];
    if (this.params.architecture === undefined) {
        this.params.architecture = '';
    }
    if (this.params.comment === undefined) {
        this.params.comment = '';
    }
    if (this.params.private === undefined) {
        this.params.private = false;
    }
    if (this.params.author === undefined) {
        this.params.author = '';
    }

    // Accessor for computing the moray object key
    this.__defineGetter__('key', function () {
        return objectKey(this.params);
    });

    this.__defineGetter__('author', function () {
        return this.params.author;
    });
    this.__defineGetter__('architecture', function () {
        return this.params.architecture;
    });
    this.__defineGetter__('comment', function () {
        return this.params.comment;
    });
    this.__defineGetter__('config', function () {
        // Warning: `config` can be null on base Docker images.
        return this.params.config;
    });
    this.__defineGetter__('container_config', function () {
        return this.params.container_config;
    });
    this.__defineGetter__('created', function () {
        return this.params.created;
    });
    this.__defineGetter__('docker_id', function () {
        return this.params.docker_id;
    });
    this.__defineGetter__('head', function () {
        return this.params.head;
    });
    this.__defineGetter__('heads', function () {
        return this.params.heads;
    });
    this.__defineGetter__('image_uuid', function () {
        return this.params.image_uuid;
    });
    this.__defineGetter__('index_name', function () {
        return this.params.index_name;
    });
    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
    this.__defineGetter__('parent', function () {
        return this.params.parent;
    });
    this.__defineGetter__('private', function () {
        return this.params.private;
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
Image.prototype.toJSON =
    Image.prototype.raw =
    Image.prototype.serialize =
    function ()
{
    return {
        author: this.params.author,
        architecture: this.params.architecture,
        comment: this.params.comment,
        created: this.params.created,
        config: this.params.config,
        container_config: this.params.container_config,
        docker_id: this.params.docker_id,
        head: this.params.head,
        image_uuid: this.params.image_uuid,
        index_name: this.params.index_name,
        owner_uuid: this.params.owner_uuid,
        parent: this.params.parent,
        private: this.params.private,
        heads: this.params.heads,
        size: this.params.size,
        virtual_size: this.params.virtual_size
    };
};


Image.prototype.toHistoryItem = function toHistoryItem() {
    var createdBy = '';
    if (this.container_config && this.container_config.Cmd) {
        createdBy = this.container_config.Cmd.join(' ');
    }
    var created = Math.floor((new Date(this.created)).getTime() / 1000);
    return {
        Id: this.docker_id,
        Created: created,
        CreatedBy: createdBy,
        Size: this.size
    };
};



// --- Exported functions

/**
 * Creates a image
 */
function createImage(app, log, params, callback) {
    log.debug({ params: params }, 'createImage: entry');

    var image = new Image(params);
    app.moray.putObject(BUCKET.name, image.key, image.raw(), function (err) {
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
    log.trace({params: params}, 'listImages: entry');

    if (!Object.keys(params).length) {
        params = '(docker_id=*)';
    }

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
    log.debug({params: params}, 'updateImage: entry');
    var key = objectKey(params);
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
    log.debug({params: params}, 'deleteImage: entry');
    var key = objectKey(params);
    moray.delObj(app.moray, BUCKET, key, callback);
}


/**
 * Gets the datacenter refcount for each layer in the ancestry of the given
 * docker_id and index_name. When the refcount is 1, it means "we" are
 * the only use of that docker image and hence it can be deleted on
 * 'docker rmi'.
 *
 * With `params.limit=1`, as this is typically called, it only bothers to
 * return those with a refcount of 0 or 1. IOW, it only returns those that
 * are safe to delete.
 *
 * For example:
 * Before deleting docker_id=868be653dea3 we want to ensure none of its
 * children is being used more than once (i.e. by any image other than
 * the one we're attempting to delete):
 *
 *      select docker_id, count(docker_id) from docker_images
 *          where docker_id in (
 *              select docker_id from docker_images
 *                  where '$docker_id'=any(heads)
 *                  and index_name='$index_name'
 *          )
 *          and index_name='$index_name'
 *          group by docker_id
 *      [   having count(docker_id) <= $limit  ]
 *
 * might return:
 *
 *      docker_id      | count
 *      ---------------+------
 *      868be653dea... |     2
 *      511136ea3c5... |     2
 *
 */
function datacenterRefcount(app, log, params, callback) {
    assert.object(params, 'image params');
    assert.string(params.index_name, 'params.index_name');
    assert.string(params.docker_id, 'params.docker_id');
    assert.optionalNumber(params.limit, 'params.limit');
    var client = app.moray;

    var query = format(
        'select docker_id, count(docker_id) from %s '
            + 'where docker_id in ('
                + 'select docker_id from %s '
                + 'where \'%s\'=any(heads) '
                + 'and index_name=\'%s\''
            + ') '
            + 'and index_name=\'%s\' '
            + 'group by docker_id',
        BUCKET.name, BUCKET.name, params.docker_id, params.index_name,
        params.index_name
    );
    if (params.limit) {
        query += ' having count (docker_id) <= ' + params.limit;
    }

    var count = {};
    var req = client.sql(query);
    var oncecb = once(callback);

    req.on('record', function (rec) {
        count[rec.docker_id] = Number(rec.count);
    });

    req.on('error', function (err) {
        oncecb(err);
    });

    req.on('end', function () {
        log.debug({docker_id: params.docker_id, index_name: params.index_name,
            limit: params.limit, count: count}, 'datacenterRefcount');
        oncecb(null, count);
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
        version: 2
    },
    {
        fn: _updateImageUuids,
        version: 3
    },
    {
        fn: _updateKeysPrivateRegistries,
        version: 4
    }
];


/*
 * This migration will populate the index_name column values. We cheat here
 * knowing that before this migration the only index_name from which
 * pulls were supported was 'docker.io' -- so use that value.
 */
function _addIndexName(opts) {
    assert.object(opts, 'opts');

    var batch = opts.batch;
    var key = opts.key;
    var value = opts.value;

    if (value.index_name !== undefined) {
        return;
    }

    value.index_name = 'docker.io';
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


/*
 * This migration will update all object keys from
 *   owner_uuid-docker_id to owner_uuid-index_name-docker_id
 */
function _updateKeysPrivateRegistries(opts) {
    assert.object(opts, 'opts');

    var batch = opts.batch;
    var key = opts.key;
    var value = opts.value;

    // Ignore every object that was already migrated.
    if (key.split('-').length > 6) {
        return;
    }

    // TODO Image.prototype.key
    var newKey = format('%s-%s-%s', value.owner_uuid,
        value.index_name, value.docker_id);

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
