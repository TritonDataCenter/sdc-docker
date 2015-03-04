/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');
var imageTag = require('../../models/image-tag');

var UNSET_OWNER_UUID = '00000000-0000-0000-0000-000000000000';


/**
 * GET /admin/image_tags
 */
function listImageTags(req, res, next) {
    var params = {};
    if (req.query.owner_uuid) {
        params.owner_uuid = req.query.owner_uuid;
    }
    if (req.query.docker_id) {
        params.docker_id = req.query.docker_id;
    }
    if (req.query.tag) {
        params.tag = req.query.tag;
    }

    imageTag.list(req.app, req.log, params, function (err, tags) {
        if (err) {
            next(err);
            return;
        }

        var serialized = [];
        for (var i in tags) {
            serialized.push(tags[i].serialize());
        }

        res.send(200, serialized);
        return next();
    });
}


/**
 * POST /admin/image_tags
 */
function createImageTag(req, res, next) {
    var params = req.body;
    if (!params.owner_uuid || params.owner_uuid === UNSET_OWNER_UUID) {
        params.owner_uuid = req.app.config.adminUuid;
    }

    imageTag.put(req.app, req.log, params, function (err, tag) {
        if (err) {
            next(err);
            return;
        }

        res.send(200, tag.serialize());
        return next();
    });
}


/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/admin/image_tags', name: 'ListImageTags' },
        before, listImageTags);
    http.post({ path: '/admin/image_tags', name: 'CreateImageTag' },
        before, createImageTag);
}



module.exports = {
    register: register
};
