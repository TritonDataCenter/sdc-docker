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
            head: { type: 'boolean' },
            image_uuid: { type: 'string' },
            owner_uuid: { type: 'string' },
            parent: { type: 'string' },
            heads: { type: '[string]' }
        }
    },
    version: 1
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

    this.__defineGetter__('docker_id', function () {
        return this.params.docker_id;
    });
    this.__defineGetter__('image_uuid', function () {
        return this.params.image_uuid;
    });
    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
    this.__defineGetter__('refcount', function () {
        return this.params.heads.length;
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
 * Initializes the images bucket
 */
function initImagesBucket(app, callback) {
    moray.initBucket(app.moray, BUCKET, callback);
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
