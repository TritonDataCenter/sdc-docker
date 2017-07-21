/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * The (old - v1) image model.
 *
 * Note that this model is deprecated, new images should use the
 * ImageV2 model in './image-v2.js'.
 */

var assert = require('assert-plus');
var format = require('util').format;
var once = require('once');

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
    assert.number(params.created, 'params.created');
    assert.string(params.docker_id, 'params.docker_id');
    assert.string(params.image_uuid, 'params.image_uuid');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.optionalArrayOfString(params.heads, 'params.heads');
    assert.number(params.size, 'params.size');
    assert.number(params.virtual_size, 'params.virtual_size');
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
    this.__defineGetter__('createdISOString', function () {
        return new Date(this.params.created * 1000).toISOString();
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
 * Returns the number of docker image layers owned by the given owner uuid.
 */
function imageCount(app, log, params, callback) {
    assert.object(params, 'image params');
    assert.string(params.owner_uuid, 'params.owner_uuid');

    var query = format(
        'select count(*) from %s where owner_uuid = \'%s\'',
        BUCKET.name, params.owner_uuid
    );

    var client = app.moray;
    var count = 0;
    var req = client.sql(query);
    var oncecb = once(callback);

    req.on('record', function (rec) {
        count = Number(rec.count);
    });

    req.on('error', function (err) {
        oncecb(err);
    });

    req.on('end', function () {
        log.debug({owner_uuid: params.owner_uuid, count: count}, 'imageCount');
        oncecb(null, count);
    });
}


/**
 * Every funtion should just take care of replacing the column with a new
 * value, or just return if it doesn't apply. When an updated object needs
 * to be written every function should push a new item to the batch array.
 */
var migrations = [];


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
    datacenterRefcount: datacenterRefcount,
    imageCount: imageCount
};
