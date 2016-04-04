/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var fs = require('fs');



/**
 * GET /ca.pem
 */
function caPem(req, res, next) {
    var data = fs.readFileSync('/data/tls/cert.pem');
    res.writeHead(200);
    res.end(data);
    next();
}



/**
 * Register all endpoints with the restify server.
 */
function register(config, http, before) {
    // Note: 'ca.pem' ignores the 'before' argument to avoid performing auth.
    http.get({ path: '/ca.pem', name: 'CA' }, caPem);
}



module.exports = {
    register: register
};
