/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var Image = require('../../models/image');

var UNSET_OWNER_UUID = '00000000-0000-0000-0000-000000000000';


/**
 * GET /admin/images
 */
function adminListImages(req, res, next) {
    var params = {};
    if (req.query.owner_uuid) {
        params.owner_uuid = req.query.owner_uuid;
    }
    if (req.query.index_name) {
        params.index_name = req.query.index_name;
    }
    if (req.query.docker_id) {
        params.docker_id = req.query.docker_id;
    }

    Image.list(req.app, req.log, params, function (err, images) {
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
 * POST /admin/images?action=create
 * POST /admin/images?action=update
 */
function adminCreateImage(req, res, next) {
    // XXX(trent): validate args
    var params = req.body;
    if (!params.owner_uuid || params.owner_uuid === UNSET_OWNER_UUID) {
        params.owner_uuid = req.app.config.adminUuid;
    }

    var fn = (req.query.action === 'update' ? Image.update : Image.create);
    fn.call(Image, req.app, req.log, params, function (err, img) {
        if (err) {
            next(err);
        } else {
            res.send(200, img.serialize());
            next();
        }
    });
}


/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/admin/images', name: 'AdminListImages' },
        before, adminListImages);
    http.post({ path: '/admin/images', name: 'AdminCreateImage' },
        before, adminCreateImage);
}



module.exports = {
    register: register
};
