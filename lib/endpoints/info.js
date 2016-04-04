/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */


/**
 * GET /$version/info
 */
function info(req, res, next) {
    req.backend.getInfo({
        clientApiVersion: req.clientApiVersion,
        app: req.app,
        log: req.log,
        req_id: req.getId(),
        account: req.account
    }, function (err, sysinfo) {
        if (err) {
            return next(err);
        }
        res.send(sysinfo);
        next();
    });
}



/**
 * Register all endpoints with the restify server
 */
function register(config, http, before) {
    http.get({ path: /^(\/v[^\/]+)?\/info$/, name: 'Info' },
        before, info);
}



module.exports = {
    register: register
};
