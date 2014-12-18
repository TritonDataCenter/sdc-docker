/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Handles initializing all models
 */

var image = require('./image');
var image_tag = require('./image-tag');
var vasync = require('vasync');



// --- Exports



/**
 * Initialize models
 */
function initializeModels(app, callback) {
    vasync.forEachParallel({
        inputs: [
        	image,
            image_tag
        ],
        func: function _initModel(mod, cb) {
            mod.init(app, cb);
        }
    }, callback);
}


module.exports = {
    init: initializeModels
};
