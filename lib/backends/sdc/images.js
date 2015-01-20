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
var format = require('util').format;
var imgmanifest = require('imgmanifest');
var IMGAPI = require('sdc-clients').IMGAPI;
var registry = require('docker-registry-client');
var restify = require('restify');
var utils = require('./utils');
var vasync = require('vasync');
var waitForJob = require('../../common').waitForJob;

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
 * @param {Object} opts.all Return all images including intermediate layers
 * @param {Object} opts.app App instance
 * @param callback {Function} `function (err, images)`
 */
function listImages(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.optionalBool(opts.all, 'opts.all');
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
    // Also, listLxImages doesn't support ?all=1
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
        var params = {};
        var results = [];

        if (!opts.all) {
            params.head = true;
        }

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


        function pushImage(img, repoTags) {
            // reminder: img.config is the image config, img.container_config
            // is the config for the container that created the image.
            var imgConfig = img.config || {};
            var dockerImage = {
                RepoTags: repoTags || ['<none>:<none>'],
                Id: img.docker_id,
                Created: Math.floor((new Date(img.created))
                            .getTime() / 1000),
                Cmd: imgConfig.Cmd,
                Env: imgConfig.Env,
                Entrypoint: imgConfig.Entrypoint,
                ExposedPorts: imgConfig.ExposedPorts,
                Size: img.size,
                Tty: imgConfig.Tty,
                User: imgConfig.User,
                VirtualSize: img.virtual_size,
                Volumes: imgConfig.Volumes,
                WorkingDir: imgConfig.WorkingDir
            };

            results.push(dockerImage);
        }

        function getTags(image, cb) {
            var getParams = { docker_id: image.docker_id };
            var serialized = image.serialize();

            // Intermediate layers don't have tags
            if (!serialized.head) {
                pushImage(serialized);
                cb();
                return;
            }

            DockerImageTag.list(app, log, getParams, function (err, tags) {
                if (err) {
                    cb(err);
                    return;
                }

                var repoTags = tags.map(function (tag) {
                    return  tag.name + ':' + tag.tag;
                });

                pushImage(serialized, repoTags);
                cb();
            });
        }
    }
}


/**
 * Gets an image from a docker_id
 *
 * @param {Object} opts
 * @param {Object} opts.docker_id docker Id
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param callback {Function} `function (err, image)`
 */
function getImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.app, 'opts.app');
    assert.string(opts.docker_id, 'opts.docker_id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var app = opts.app;
    var log = opts.log;

    var getParams = { docker_id: opts.docker_id };

    DockerImage.get(app, log, getParams, function (err, image) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, image.serialize());
    });
}


/**
 * Gets an image ancestry from a docker repo name
 *
 * @param {Object} opts
 * @param {Object} opts.parsed Parsed repo instance
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param callback {Function} `function (err, image)`
 */
function getImageAncestry(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.object(opts.parsed, 'opts.parsed');

    var app = opts.app;
    var log = opts.log;
    var ancestry, imgId;

    vasync.pipeline({
        funcs: [
            getDockerId,
            getAncestry
        ]
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        return callback(null, ancestry);
    });

    function getDockerId(_, next) {
        var listParams = { name: opts.parsed.name, tag: opts.parsed.tag };

        DockerImageTag.list(app, log, listParams, function (err, tags) {
            if (err) {
                next(err);
                return;
            } else if (!tags.length) {
                next(new restify.ResourceNotFoundError(
                    'No such id: %s', opts.parsed.repo));
                return;
            }

            imgId = tags[0].docker_id;
            next();
        });
    }

    function getAncestry(_, next) {
        registry.createRegistrySession({
            repo: opts.parsed.repo
        }, function (err, session) {
            if (err) {
                next(err);
                return;
            }

            session.getImgAncestry({ imgId: imgId }, function (ancErr, anc) {
                if (ancErr) {
                    next(ancErr);
                    return;
                }

                ancestry = anc;
                next();
            });
        });
    }
}


function deleteImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.object(opts.parsed, 'opts.parsed');

    var self = this;
    var imgapi = getImgapiClient(this.config.imgapi);
    var history = [];
    var head;
    var app = opts.app;
    var log = opts.log;

    self.getImageAncestry(opts, function (err, ancestry) {
        if (err) {
            callback(err);
            return;
        }

        head = ancestry[0];

        vasync.forEachPipeline({
            func: removeLayer,
            inputs: ancestry
        }, untagHead);
    });

    function untagHead(pipeErr) {
        if (pipeErr) {
            callback(pipeErr);
            return;
        }

        var delOpts = { docker_id: head };
        DockerImageTag.del(app, log, delOpts, function (err) {
            if (err && err.name !== 'ResourceNotFoundError') {
                callback(err);
                return;
            }

            var repo = opts.parsed.name + ':' + opts.parsed.tag;
            history.push({ Untagged: repo });
            callback(null, history.reverse());
        });
    }

    function removeLayer(imgId, cb) {
        var delOpts = { docker_id: imgId };
        DockerImage.del(app, log, delOpts, function (err) {
            if (err && err.name !== 'ResourceNotFoundError') {
                cb(err);
                return;
            }

            var uuid = utils.dockerIdToUuid(imgId);
            imgapi.deleteImage(uuid, function (delErr) {
                // When reaching an image that has many other children or an
                // image that was deleted already, stop here and just untag
                // the head image
                if (delErr && (delErr.name === 'ImageHasDependentImagesError'
                        || delErr.name === 'ResourceNotFoundError')) {
                    cb();
                    return;
                } else if (delErr) {
                    cb(delErr);
                    return;
                }

                history.push({ Deleted: imgId });
                cb();
            });
        });
    }
}


function inspectImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.parsed, 'opts.parsed');
    assert.optionalObject(opts.log, 'opts.log');

    var app = opts.app;
    var name = opts.parsed.name;
    var tag = opts.parsed.tag;
    var log = opts.log || this.log;

    var dockerId;
    var image;

    // First try to match the given image name to an existing image tag
    // and then look through all existing image layers
    vasync.pipeline({
        funcs: [findDockerImageTag, findDockerImage]
    }, function (err) {
        if (err) {
            callback(err);
            return;
        } else if (!image) {
            callback(
                new restify.ResourceNotFoundError(
                    'No such image: %s', name));
            return;
        }

        var img = utils.imgobjToInspect(image);
        callback(null, img);
    });

    function findDockerImageTag(_, next) {
        var getParams = {
            name: name,
            tag: tag
        };

        DockerImageTag.list(app, log, getParams, function (err, tags) {
            if (err) {
                next(err);
                return;
            } else if (!tags.length) {
                next();
                return;
            }

            dockerId = tags[0].docker_id;
            next();
        });
    }

    function findDockerImage(_, next) {
        var getParams = {};
        if (dockerId) {
            getParams.docker_id = dockerId;
        } else {
            getParams.docker_id = format('*%s*', name);
        }

        DockerImage.list(app, log, getParams, function (err, images) {
            if (err) {
                next(err);
                return;
            }

            image = images[0];
            next();
        });
    }
}


function pullImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.askedTag, 'opts.askedTag');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.parsed, 'opts.parsed');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.res, 'opts.res');
    assert.object(opts.wfapi, 'opts.wfapi');

    var session;
    var jobUuid;
    var data = { images: {}, fileSizes: {}, virtual_size: 0 };

    vasync.pipeline({
        funcs: [
            getRegistrySession,
            getRepoTags,
            getAncestry,
            createPullJob,
            waitForPullJob
        ]
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, data);
    });

    function getRegistrySession(_, next) {
        registry.createRegistrySession({
            repo: opts.parsed.repo
        }, function (err, sess) {
            if (err) {
                next(err);
                return;
            }
            session = sess;
            next();
        });
    }

    function getRepoTags(_, next) {
        session.listRepoTags(function (err, repoTags) {
            if (err) {
                next(err);
                return;
            }
            data.repoTags = repoTags;
            data.askedImg = repoTags[opts.askedTag];
            next();
        });
    }

    function getAncestry(_, next) {
        session.getImgAncestry({
            imgId: data.askedImg
        }, function (err, ancestry) {
            if (err) {
                next(err);
                return;
            }

            // Start pulling from parent to children until IMGAPI supports
            // orphan images
            data.ancestry = ancestry.reverse();
            next();
        });
    }

    function createPullJob(_, next) {
        var jobOpts = {
            data: data,
            askedTag: opts.askedTag,
            parsed: opts.parsed,
            req_id: opts.req_id
        };

        opts.wfapi.createPullImageJob(jobOpts, function (err, juuid) {
            if (err) {
                next(err);
                return;
            }

            jobUuid = juuid;
            // Create an in-progress pull operation so the wfapi job can report
            // progress back to us
            opts.app.operations[opts.parsed.repo] = { socket: opts.res };
            next();
        });
    }

    function waitForPullJob(_, next) {
        waitForJob(opts.wfapi, jobUuid, function (err) {
            if (err) {
                next(err);
                return;
            }

            delete opts.app.operations[opts.parsed.repo];
            next();
        });
    }
}

// ---- exports

module.exports = {
    deleteImage: deleteImage,
    getImage: getImage,
    getImageAncestry: getImageAncestry,
    listImages: listImages,
    inspectImage: inspectImage,
    pullImage: pullImage
};
