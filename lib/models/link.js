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
            container_name: { type: 'string' },
            // The target container name the link is pointed at.
            target_uuid: { type: 'string' },
            target_name: { type: 'string' },
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
    assert.string(params.container_name, 'params.container_name');
    assert.string(params.container_uuid, 'params.container_uuid');
    assert.string(params.target_name, 'params.target_name');
    assert.string(params.target_uuid, 'params.target_uuid');
    assert.string(params.alias, 'params.alias');

    this.params = params;
}

Object.defineProperty(Link.prototype, 'owner_uuid', {
    get: function owner_uuid() {
        return this.params.owner_uuid;
    }
});

Object.defineProperty(Link.prototype, 'container_uuid', {
    get: function container_uuid() {
        return this.params.container_uuid;
    }
});

Object.defineProperty(Link.prototype, 'container_name', {
    get: function get_container_name() {
        return this.params.container_name;
    },
    set: function set_container_name(val) {
        this.params.container_name = val;
    }
});

Object.defineProperty(Link.prototype, 'target_uuid', {
    get: function target_uuid() {
        return this.params.target_uuid;
    }
});

Object.defineProperty(Link.prototype, 'target_name', {
    get: function get_target_name() {
        return this.params.target_name;
    },
    set: function set_target_name(val) {
        this.params.target_name = val;
    }
});

Object.defineProperty(Link.prototype, 'alias', {
    get: function alias() {
        return this.params.alias;
    }
});

Object.defineProperty(Link.prototype, 'key', {
    get: function key() {
        return this.owner_uuid + '-' + this.container_uuid + '-' + this.alias;
    }
});

Object.defineProperty(Link.prototype, 'host_config', {
    get: function host_config() {
        return this.target_name + ':' + this.alias;
    }
});

Object.defineProperty(Link.prototype, 'ps_config', {
    get: function ps_config() {
        return '/' + this.container_name + '/' + this.alias;
    }
});

Object.defineProperty(Link.prototype, 'inspect_config', {
    get: function inspect_config() {
        return '/' + this.target_name + ':/'
                + this.container_name + '/' + this.alias;
    }
});


/**
 * Returns the raw form of the link suitable for storing in moray,
 * which is the same as the serialized form
 */
Link.prototype.raw = Link.prototype.serialize = function () {
    return {
        owner_uuid: this.params.owner_uuid,
        container_uuid: this.params.container_uuid,
        container_name: this.params.container_name,
        target_uuid: this.params.target_uuid,
        target_name: this.params.target_name,
        alias: this.params.alias
    };
};

Link.prototype.save = function (app, callback) {
    app.moray.putObject(BUCKET.name, this.key, this.raw(), callback);
};



// --- Exported functions



/**
 * Creates one link.
 *
 * @param {Object} app App instance
 * @param {Object} log Bunyan log instance
 * @param {Object} params What to search upon.
 * @param {String} params.owner_uuid The link owner.
 * @param {String} params.container_uuid The container using the link.
 * @param {String} params.container_name The name of the container.
 * @param {String} params.target_uuid The container being linked to.
 * @param {String} params.target_name The name of the linked container.
 * @param {String} params.alias The name of the link.
 *
 * @param callback {Function} `function (err, Link)`
 */
function createLink(app, log, params, callback) {
    assert.object(app, 'app');
    assert.object(log, 'log');
    assert.object(params, 'link params');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.container_uuid, 'params.container_uuid');
    assert.string(params.container_name, 'params.container_name');
    assert.string(params.target_uuid, 'params.target_uuid');
    assert.string(params.target_name, 'params.target_name');
    assert.string(params.alias, 'params.alias');

    log.debug({ params: params }, 'createLink: entry');

    var link = new Link(params);
    app.moray.putObject(BUCKET.name, link.key, link.raw(), function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, link);
    });
}


/**
 * Find all links for given owner_uuid and optional (target_uuid,
 * container_uuid, alias) search criteria.
 *
 * @param {Object} app App instance
 * @param {Object} log Bunyan log instance
 * @param {Object} params What to search upon.
 * @param {String} params.owner_uuid The link owner.
 * @param {String} params.container_uuid Optional, the container using the link.
 * @param {String} params.target_uuid Optional, the container being linked to.
 * @param {String} params.alias Optional, the link alias name.
 *
 * @param callback {Function} `function (err, [Link])`
 */
function findLinks(app, log, params, callback) {
    assert.object(app, 'app');
    assert.object(log, 'log');
    assert.object(params, 'link params');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.optionalString(params.target_uuid, 'params.target_uuid');
    assert.optionalString(params.container_uuid, 'params.container_uuid');
    assert.optionalString(params.alias, 'params.alias');

    log.trace(params, 'findLinks: entry');

    moray.listObjs({
        filter: params,
        log: log,
        bucket: BUCKET,
        model: Link,
        moray: app.moray
    }, callback);
}


/**
 * Deletes one link.
 *
 * @param {Object} app App instance
 * @param {Object} log Bunyan log instance
 * @param {Object} params Criteria for the link.
 * @param {String} params.owner_uuid The link owner.
 * @param {String} params.container_uuid The container using the link.
 * @param {String} params.alias The name of the link.
 *
 * @param callback {Function} `function (err)`
 */
function deleteLink(app, log, params, callback) {
    assert.object(app, 'app');
    assert.object(log, 'log');
    assert.object(params, 'link params');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.string(params.container_uuid, 'params.container_uuid');
    assert.string(params.alias, 'params.alias');
    assert.func(callback, 'callback');

    log.debug(params, 'deleteLink: entry');

    var lkey = params.owner_uuid + '-' + params.container_uuid + '-'
                + params.alias;
    moray.delObj(app.moray, BUCKET, lkey, callback);
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
    init: initLinksBucket,
    find: findLinks,
    Link: Link
};
