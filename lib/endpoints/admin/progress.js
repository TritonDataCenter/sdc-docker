/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var restify = require('restify');



/**
 * POST /admin/progress
 */
function adminProgress(req, res, next) {
    var id = req.body.id;
    var payload = req.body.payload;
    var operation = req.app.sockets.getSocket('job', id);

    if (!id || !operation) {
        return next(new restify.ResourceNotFoundError('Operation not found'));
    } else if (!payload) {
        return next(new restify.MissingParameterError('Missing payload'));
    }

    operation.socket.write(JSON.stringify(payload));
    res.send(200);
    return next();
}



/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.post({ path: '/admin/progress', name: 'AdminProgress' },
        before, adminProgress);
}



module.exports = {
    register: register
};
