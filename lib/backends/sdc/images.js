/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var IMGAPI = require('sdc-clients').IMGAPI;


/**
 * Get all the images
 *
 * @param {Object} opts
 * @param callback {Function} `function (err, images)`
 */
function listImages(opts, callback) {
    assert.object(opts, 'opts');
    opts.url = this.config.imgapi.url;

    var imgapi = new IMGAPI(opts);
    var filters = {};
    imgapi.listImages(filters, function (err, images) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, images);
        return;
    });
}


// ---- exports

module.exports = {
    listImages: listImages
};
