/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Links model for docker containers.
 */

var assert = require('assert-plus');
var moray = require('../moray');


// --- Globals



var BUCKET = {
    desc: 'docker links',
    name: 'docker_links',
    schema: {
        index: {
            // Owning user
            owner_uuid: { type: 'string' },
            // The container who will use the link.
            container_uuid: { type: 'string' },
            // The target container name the link is pointed at.
            target_name: { type: 'string' },
            // The target container the link is pointed at.
            target_uuid: { type: 'string' },
            // The alias name to use in the container.
            alias: { type: 'string' }
        }
    },
    version: 1
};



// --- Helpers


// --- Link object


/**
 * Link model constructor
 */
function Link(params) {
    assert.object(params, 'link params');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.container_uuid, 'params.container_uuid');
    assert.string(params.target_name, 'params.target_name');
    assert.string(params.target_uuid, 'params.target_uuid');
    assert.string(params.alias, 'params.alias');

    this.params = params;

    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
    this.__defineGetter__('container_uuid', function () {
        return this.params.container_uuid;
    });
    this.__defineGetter__('target_name', function () {
        return this.params.target_name;
    });
    this.__defineGetter__('target_uuid', function () {
        return this.params.target_uuid;
    });
    this.__defineGetter__('alias', function () {
        return this.params.alias;
    });
}


/**
 * Returns the raw form of the link suitable for storing in moray,
 * which is the same as the serialized form
 */
Link.prototype.raw = Link.prototype.serialize = function () {
    return {
        owner_uuid: this.params.owner_uuid,
        container_uuid: this.params.container_uuid,
        target_name: this.params.target_name,
        target_uuid: this.params.target_uuid,
        alias: this.params.alias
    };
};



// --- Exported functions



/**
 * Creates a link
 */
function createLink(app, log, params, callback) {
    log.debug({ params: params }, 'createLink: entry');

    var link = new Link(params);
    var key = link.owner_uuid + '-' + link.container_uuid + '-' + link.alias;
    app.moray.putObject(BUCKET.name, key, link.raw(), function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, link);
    });
}


/**
 * Gets a link
 */
function getLink(app, log, params, callback) {
    log.trace(params, 'getLink: entry');

    moray.getObj(app.moray, BUCKET, params.key, function (err, rec) {
        if (err) {
            return callback(err);
        }

        return callback(null, new Link(rec.value));
    });
}


/**
 * Find all links for given owner_uuid and optional (target_uuid,
 * container_uuid) search criteria.
 */
function findLinks(app, log, params, callback) {
    log.trace(params, 'findLinks: entry');
    assert.object(params, 'link params');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.optionalString(params.target_uuid, 'params.target_uuid');
    assert.optionalString(params.container_uuid, 'params.container_uuid');

    moray.listObjs({
        filter: params,
        log: log,
        bucket: BUCKET,
        model: Link,
        moray: app.moray
    }, callback);
}


/**
 * Deletes an link
 */
function deleteLink(app, log, params, callback) {
    log.debug(params, 'deleteLink: entry');
    assert.object(params, 'link params');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.container_uuid, 'params.container_uuid');
    assert.string(params.alias, 'params.alias');

    var key = params.owner_uuid + '-' + params.container_uuid + '-'
                + params.alias;
    moray.delObj(app.moray, BUCKET, key, function (err) {
        if (err) {
            return callback(err);
        }

        return callback();
    });
}


/**
 * Initializes the links bucket
 */
function initLinksBucket(app, callback) {
    moray.initBucket(app.moray, BUCKET, callback);
}


module.exports = {
    create: createLink,
    del: deleteLink,
    get: getLink,
    init: initLinksBucket,
    find: findLinks,
    Link: Link
};
