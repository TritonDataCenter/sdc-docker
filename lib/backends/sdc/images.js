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
var errors = require('../../../lib/errors');
var format = require('util').format;
var imgmanifest = require('imgmanifest');
var IMGAPI = require('sdc-clients').IMGAPI;
var registry = require('docker-registry-client');
var restify = require('restify');
var TombstoneImage = require('../../models/tombstone-image');
var utils = require('./utils');
var vasync = require('vasync');
var VMAPI = require('sdc-clients').VMAPI;
var waitForJob = require('../../common').waitForJob;

//---- globals

var _imgapiClientCache; // set in `getImgapiClient`
var _vmapiClientCache; // set in `getVmapiClient`

//---- internal support routines

function getImgapiClient(config) {
    if (!_imgapiClientCache) {
        // intentionally global
        _imgapiClientCache = new IMGAPI(config);
    }
    return _imgapiClientCache;
}

function getVmapiClient(config) {
    if (!_vmapiClientCache) {
        // intentionally global
        _vmapiClientCache = new VMAPI(config);
    }
    return _vmapiClientCache;
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
    assert.object(opts.account, 'opts.account');
    assert.optionalBool(opts.all, 'opts.all');
    assert.string(opts.req_id, 'opts.req_id');

    opts.url = this.config.imgapi.url;

    var app = opts.app;
    var log = opts.log;
    var dockerImages = [];
    var funcs = [];
    var imgapi = new IMGAPI(opts);

    if (!opts.skip_smartos) {
        funcs.push(listSmartOSImages);
    }
    funcs.push(listDockerImages);

    vasync.parallel({funcs: funcs}, function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, dockerImages);
    });

    function listSmartOSImages(next) {
        var filters = { type: 'zone-dataset' };

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
                if (img.disabled) {
                    return;
                }

                dockerImage.RepoTags = [
                    img.uuid + ':' + img.version,
                    img.uuid + ':latest'
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
        var params = { owner_uuid: opts.account.uuid };
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
            var getParams = {
                docker_id: image.docker_id,
                owner_uuid: opts.account.uuid
            };
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
                    // Official image repos are named without library/
                    if (tag.repo.indexOf('library/') === 0) {
                        return  tag.name + ':' + tag.tag;
                    } else {
                        return  tag.repo + ':' + tag.tag;
                    }
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
    assert.object(opts.account, 'opts.account');

    var app = opts.app;
    var log = opts.log;

    var getParams = {
        docker_id: opts.docker_id,
        owner_uuid: opts.account.uuid
    };

    DockerImage.list(app, log, getParams, function (err, images) {
        if (err) {
            callback(err);
            return;
        } else if (!images.length) {
            callback(new restify.ResourceNotFoundError(
                    'No such id: %s', opts.docker_id));
            return;
        }

        callback(null, images[0].serialize());
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
    var ancestry, imgId, repo;

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
        var listParams = [ {docker_id: format('*%s*', opts.parsed.name)}, {
            name: opts.parsed.name,
            tag: opts.parsed.tag
        }];

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
            repo = tags[0].repo;
            next();
        });
    }

    function getAncestry(_, next) {
        registry.createRegistrySession({
            repo: repo
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
    assert.bool(opts.force, 'opts.force');
    assert.optionalObject(opts.log, 'opts.log');
    assert.object(opts.parsed, 'opts.parsed');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var dcRefcount;
    var head;
    var tag;
    var history = [];
    var layers;
    var app = opts.app;
    var log = opts.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    vasync.pipeline({
        funcs: [
            getHeadImg,
            verifyNotInUse,
            getLayers,
            getDatacenterRefcount,
            removeLayers,
            untagHead
        ]}, function (err) {

        if (err) {
            callback(err);
            return;
        }

        callback(null, history.reverse());
    });

    function getHeadImg(_, cb) {
        var tagParams = [ {docker_id: format('*%s*', opts.parsed.name)}, {
            name: opts.parsed.name,
            owner_uuid: opts.account.uuid,
            tag: opts.parsed.tag
        }];

        DockerImageTag.list(app, log, tagParams, function (err, tags) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            } else if (!tags.length) {
                cb(new restify.ResourceNotFoundError(
                    'No such id: %s', opts.parsed.repo));
                return;
            }

            head = tags[0].docker_id;
            tag = tags[0].tag;
            cb();
        });
    }

    function verifyNotInUse(_, cb) {
        var image_uuid;
        var layerParams = {
            docker_id: head,
            owner_uuid: opts.account.uuid
        };

        DockerImage.list(app, log, layerParams, function (err, _layers) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }

            if (!_layers.length) {
                cb();
                return;
            }

            image_uuid = _layers[0].image_uuid;
            verifyVmsNotActive();
        });


        // If force === false this function will return an error if there is at
        // least a running or stopped VM using the image.
        // If force === true, it will return an error if there is at least a
        // running VMusing the image
        function verifyVmsNotActive() {
            var query = {
                docker: true,
                state: (opts.force ? 'running' : 'active'),
                image_uuid: image_uuid,
                owner_uuid: opts.account.uuid
            };

            vmapi.listVms(query, {
                headers: {'x-request-id': opts.req_id}
            }, function (vmapiErr, vms) {
                if (vmapiErr) {
                    log.error(vmapiErr, 'Error retrieving VMs used by '
                        + 'image_uuid %', image_uuid);
                    cb(errors.vmapiErrorWrap(vmapiErr,
                        'could not delete image'));
                    return;
                }

                if (!vms.length) {
                    cb();
                    return;
                }

                vms.sort(function (a, b) {
                    if (a.state < b.state)
                        return -1;
                    if (a.state > b.state)
                        return 1;
                    return 0;
                });

                var forceStr = opts.force ? 'force ' : '';
                var messageFormat;
                var sId = vms[0].internal_metadata['docker:id'].substr(0, 12);

                if (vms[0].state === 'running') {
                    messageFormat = 'Conflict, cannot %sdelete %s because '
                        + 'the running container %s is using it, stop it and '
                        + 'use -f to force';
                } else {
                    messageFormat = 'Conflict, cannot %sdelete %s because '
                        + 'the container %s is using it, use -f to force';
                }

                var message = format(messageFormat, forceStr,
                        opts.parsed.name, sId);
                cb(new errors.DockerError(message));
            });
        }
    }

    function getLayers(_, cb) {
        var layerParams = {
            heads: head,
            owner_uuid: opts.account.uuid
        };

        DockerImage.list(app, log, layerParams, function (err, _layers) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }

            layers = _layers;
            cb();
        });
    }

    // Get all layers that are ready to be moved to docker_tombstones
    function getDatacenterRefcount(_, cb) {
        var params = {
            docker_id: head,
            limit: 1
        };

        DockerImage.datacenterRefcount(app, log, params, function (err, count) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }

            dcRefcount = count;
            cb();
        });
    }

    function removeLayers(_, cb) {
        vasync.forEachPipeline({
            func: removeLayer,
            inputs: layers
        }, function (err) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }

            cb();
        });
    }

    // We only remove the layer when it is no longer being used by the account.
    // If this is the last layer id being used across the whole DC, then we mark
    // this layer to be deleted by creating a new TombstoneImage object
    function removeLayer(layer, cb) {
        if (layer.refcount > 1) {
            var heads = layer.params.heads.filter(function (id) {
                return id !== head;
            });

            var obj = {
                docker_id: layer.docker_id,
                heads: heads,
                owner_uuid: opts.account.uuid
            };

            DockerImage.update(app, log, obj, cb);
            return;
        }

        var tombstone = (dcRefcount[layer.docker_id] !== undefined);
        var delOpts = {
            docker_id: layer.docker_id,
            owner_uuid: opts.account.uuid
        };

        DockerImage.del(app, log, delOpts, function (err) {
            if (err) {
                cb(err);
                return;
            }

            history.push({ Deleted: layer.docker_id });

            if (!tombstone) {
                cb();
                return;
            }

            var ttImage = {
                docker_id: layer.docker_id,
                image_uuid: layer.image_uuid
            };

            TombstoneImage.create(app, log, ttImage, function (ttErr, ttImg) {
                if (ttErr) {
                    cb(ttErr);
                    return;
                }

                cb();
            });
        });
    }

    function untagHead(_, cb) {
        var delOpts = {
            docker_id: head,
            owner_uuid: opts.account.uuid,
            tag: tag
        };

        DockerImageTag.del(app, log, delOpts, function (err) {
            if (err) {
                cb(err);
                return;
            }

            var repo = opts.parsed.name + ':' + opts.parsed.tag;
            history.push({ Untagged: repo });
            cb();
        });
    }
}


function inspectImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.parsed, 'opts.parsed');
    assert.object(opts.account, 'opts.account');
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
        var getParams = [ {docker_id: format('*%s*', name)}, {
            name: name,
            owner_uuid: opts.account.uuid,
            tag: tag
        }];

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
        var getParams = { owner_uuid: opts.account.uuid };
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
    assert.object(opts.req, 'opts.req');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.res, 'opts.res');
    assert.object(opts.wfapi, 'opts.wfapi');
    assert.object(opts.account, 'opts.account');

    var jobUuid;

    // This is a chunked transfer so we can't return a restify error because
    // headers have already been sent when the downloads have started
    function errorAndEnd(err, job) {
        opts.req.log.error(err, 'imageCreate job error');

        var payload;
        if (!job || !job.params.head) {
            payload = { status: err.message };
        } else {
            var imgId = job.params.head.substr(0, 12);
            payload = {
                id: imgId,
                status: format('Error pulling image (%s), %s',
                    imgId, err.message),
                progressDetail: {}
            };
        }

        opts.res.write(JSON.stringify(payload));
        opts.res.end();
    }

    vasync.pipeline({
        funcs: [
            createPullJob,
            waitForPullJob
        ]
    }, callback);

    function createPullJob(_, next) {
        var jobOpts = {
            askedTag: opts.askedTag,
            parsed: opts.parsed,
            req_id: opts.req_id,
            account: opts.account
        };

        opts.wfapi.createPullImageJob(jobOpts, function (err, juuid) {
            if (err) {
                errorAndEnd(err);
                next();
                return;
            }

            jobUuid = juuid;

            // Create an in-progress pull operation so the wfapi job can report
            // progress back to us
            opts.app.sockets.setSocket('job', opts.parsed.repo, {
                socket: opts.res
            });

            next();
        });
    }

    function waitForPullJob(_, next) {
        waitForJob(opts.wfapi, jobUuid, function (err, job) {
            if (err) {
                errorAndEnd(err, job);
            }

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
