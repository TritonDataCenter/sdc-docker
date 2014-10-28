/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    execFile = child_process.execFile;
var format = require('util').format;
var IMGAPI = require('sdc-clients').IMGAPI;


// ---- globals



// ---- main functionality

/**
 * Get all the images
 *
 * @param {Object} options:
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err, images)`
 */
function getImages(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.log, 'options.log');

    /*
     * @param filters {Object} Optional filter params, e.g. `{os: 'smartos'}`.
     *      See the doc link above for a full list of supported filters.
     * @param options {Object} Optional request options.
     *      - headers {Object} Optional extra request headers.
     * @param callback {Function} `function (err, images, res)`
     *
     * NOTE about filters.limit and filters.marker:
     *
     * When no limit is passed we want to allow listImages to automatically
     * loop through all available images because there is default 'hard'
     * limit of 1k images being imposed because of the moray backend. When
     * a limit is passed we are already overriding that so we don't need to
     * do multiple queries to form our response
     */

    var imgapi = new IMGAPI({url: process.env.IMGAPI_URL});
    imgapi.listImages({}, {}, function (err, images, res) {
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
    //XXX -> listImages
    getImages: getImages
};
