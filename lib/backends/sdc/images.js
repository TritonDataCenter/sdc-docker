/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var DockerImage = require('../../models/image');
var DockerImageTag = require('../../models/image-tag');
var IMGAPI = require('sdc-clients').IMGAPI;
var utils = require('./utils');
var vasync = require('vasync');


//---- globals

var _imgapiClientCache; // set in `getImgapiClient`

//---- internal support routines

function getImgapiClient(config) {
    if (!_imgapiClientCache) {
        // intentionally global
        _imgapiClientCache = new IMGAPI(config);
    }
    return _imgapiClientCache;
}


/**
 * Get all the images
 *
 * @param {Object} opts
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param callback {Function} `function (err, images)`
 */
function listImages(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    opts.url = this.config.imgapi.url;

    var app = opts.app;
    var log = opts.log;
    var dockerImages = [];
    var imgapi = new IMGAPI(opts);

    vasync.parallel({
        funcs: [listLxImages, listDockerImages]
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, dockerImages);
    });

    // Deprecated. This function only works for our manually built images
    function listLxImages(next) {
        var filters = { type: 'lx-dataset' };

        imgapi.listImages(filters, {
            headers: {'x-request-id': opts.req_id}
        }, function (err, images) {
            var results = [];

            if (err) {
                next(err);
                return;
            }

            images.forEach(function (img) {
                var dockerImage = {};

                // XXX this filtering should be done at the API
                if (!img.tags || !img.tags.docker || img.disabled) {
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

            dockerImages = dockerImages.concat(results);
            next();
        });
    }

    function listDockerImages(next) {
        var params = { head: true };
        var results = [];

        DockerImage.list(app, log, params, function (err, images) {
            if (err) {
                next(err);
                return;
            }

            vasync.forEachParallel({
                func: getTags,
                inputs: images
            }, function (getErr) {
                if (getErr) {
                    next(getErr);
                    return;
                }

                dockerImages = dockerImages.concat(results);
                next();
            });
        });

        function getTags(image, cb) {
            var getParams = { docker_id: image.docker_id };
            var serialized = image.serialize();

            DockerImageTag.list(app, log, getParams, function (err, tags) {
                if (err) {
                    cb(err);
                    return;
                }

                var repoTags = tags.map(function (tag) {
                    return  tag.name + ':' + tag.tag;
                });
                var dockerImage = {
                    RepoTags: repoTags,
                    Id: serialized.docker_id,
                    Created: Math.floor((new Date(serialized.created))
                                .getTime() / 1000),
                    Size: serialized.size,
                    VirtualSize: serialized.virtual_size
                };

                results.push(dockerImage);
                cb();
            });
        }
    }
}


function inspectImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.name, 'opts.name');
    assert.optionalObject(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var name = opts.name;
    var log = opts.log || this.log;
    var imgapi = getImgapiClient(this.config.imgapi);

    utils.getImgapiImageForName(name, {
        log: log,
        imgapi: imgapi,
        req_id: opts.req_id
    }, function (imgapi_err, image) {
        if (imgapi_err) {
            log.error({err: imgapi_err}, 'failed to get image');
            callback(imgapi_err);
            return;
        }

        var img = utils.imgobjToInspect({}, image);
        log.trace({image: image, obj: img}, 'image');

        return callback(null, img);
    });
}

// ---- exports

module.exports = {
    listImages: listImages,
    inspectImage: inspectImage
};
