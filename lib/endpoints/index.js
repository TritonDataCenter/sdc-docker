/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */


/*
 * Endpoints are in their own individual files, in a directory structure
 * that roughly matches their routes, eg:
 *   /containers -> containers.js
 */
var toRegister = {
    '/_ping': require('./_ping'),
    '/auth': require('./auth'),
    '/build': require('./build'),
    '/ca.pem': require('./ca'),
    '/commit': require('./commit'),
    '/containers': require('./containers'),
    '/events': require('./events'),
    '/exec': require('./exec'),
    '/images': require('./images'),
    '/info': require('./info'),
    '/version': require('./version'),
    '/volumes': require('./volumes')
};



// --- Exports



/*
 * Register all endpoints with the restify server
 */
function registerEndpoints(config, http, log, before) {
    for (var t in toRegister) {
        log.debug('Registering endpoints for "%s"', t);
        toRegister[t].register(config, http, before);
    }
}



module.exports = {
    register: registerEndpoints
};
