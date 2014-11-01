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
    assert.string(opts.req_id, 'opts.req_id');

    opts.url = this.config.imgapi.url;

    var imgapi = new IMGAPI(opts);
    var filters = {};

    imgapi.listImages(filters, {
        headers: {'x-request-id': opts.req_id}
    }, function (err, images) {
        var results = [];

        if (err) {
            callback(err);
            return;
        }

        images.forEach(function (img) {
            var dockerImage = {};

            // XXX this filtering should be done at the API
            if (!img.tags.docker || img.disabled) {
                return;
            }

            dockerImage.RepoTags = [
                img.name + ':' + img.version,
                img.name + ':latest'
            ];
            dockerImage.Id = (img.uuid + img.uuid).replace(/-/g, '');
            dockerImage.Created = Math.floor((new Date(img.published_at))
                .getTime() / 1000);
            dockerImage.Size = img.files[0].size;
            dockerImage.VirtualSize = img.files[0].size;

            results.push(dockerImage);
        });

        callback(null, results);
    });
}

// ---- exports

module.exports = {
    listImages: listImages
};
