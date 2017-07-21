/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */


/*
 * Endpoints are in their own individual files, in a directory structure
 * that roughly matches their routes, eg:
 *   /containers -> containers.js
 */
var toRegister = {
    '/admin/config': require('./config'),
    '/admin/progress': require('./progress'),
    '/admin/images_v2': require('./images-v2'),
    '/admin/image_tags_v2': require('./image-tags-v2')
};



// --- Exports



/*
 * Register all endpoints with the restify server
 */
function registerEndpoints(http, log, before) {
    for (var t in toRegister) {
        log.debug('Registering endpoints for "%s"', t);
        toRegister[t].register(http, before);
    }
}



module.exports = {
    register: registerEndpoints
};
