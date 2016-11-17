/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var ImageTagV2 = require('../../models/image-tag-v2');

var UNSET_OWNER_UUID = '00000000-0000-0000-0000-000000000000';


/**
 * GET /admin/image_tags_v2
 */
function adminListImageTagsV2(req, res, next) {
    var params = {};
    if (req.query.owner_uuid) {
        params.owner_uuid = req.query.owner_uuid;
    }
    if (req.query.config_digest) {
        params.config_digest = req.query.config_digest;
    }
    if (req.query.tag) {
        params.tag = req.query.tag;
    }

    ImageTagV2.list(req.app, req.log, params, function (err, tags) {
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
 * POST /admin/image_tags_v2
 */
function adminCreateImageTagV2(req, res, next) {
    var params = req.body;
    if (!params.owner_uuid || params.owner_uuid === UNSET_OWNER_UUID) {
        params.owner_uuid = req.app.config.adminUuid;
    }

    ImageTagV2.create(req.app, req.log, params, function (err, tag) {
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
    http.get({ path: '/admin/image_tags_v2', name: 'AdminListImageTagsV2' },
        before, adminListImageTagsV2);
    http.post({ path: '/admin/image_tags_v2', name: 'AdminCreateImageTagV2' },
        before, adminCreateImageTagV2);
}



module.exports = {
    register: register
};
