/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var ImageV2 = require('../../models/image-v2');

var UNSET_OWNER_UUID = '00000000-0000-0000-0000-000000000000';


/**
 * GET /admin/images_v2
 */
function adminListImagesV2(req, res, next) {
    var params = {};
    if (req.query.owner_uuid) {
        params.owner_uuid = req.query.owner_uuid;
    }
    if (req.query.config_digest) {
        params.config_digest = req.query.config_digest;
    }

    ImageV2.list(req.app, req.log, params, function (err, images) {
        if (err) {
            next(err);
            return;
        }

        var serialized = [];
        for (var i in images) {
            serialized.push(images[i].serialize());
        }

        res.send(200, serialized);
        return next();
    });
}


/**
 * POST /admin/images_v2?action=create
 */
function adminCreateImageV2(req, res, next) {
    var params = req.body;
    if (!params.owner_uuid || params.owner_uuid === UNSET_OWNER_UUID) {
        params.owner_uuid = req.app.config.adminUuid;
    }

    try {
        ImageV2.create(req.app, req.log, params, function (err, img) {
            if (err) {
                next(err);
            } else {
                res.send(200, img.serialize());
                next();
            }
        });
    } catch (ex) {
        next(ex);
    }
}


/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/admin/images_v2', name: 'AdminListImagesV2' },
        before, adminListImagesV2);
    http.post({ path: '/admin/images_v2', name: 'AdminCreateImageV2' },
        before, adminCreateImageV2);
}



module.exports = {
    register: register
};
