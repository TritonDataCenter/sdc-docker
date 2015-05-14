/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Some relevant info regarding image handling in sdc-docker that should help
 * maintenance of this file.
 *
 * - Remote API endpoints are defined in lib/endpoints/images.js". They
 *   typically call methods in this file to do their work.
 * - Related models (persistent data stored in Moray):
 *      ImageTag            An account's tagged images. Given an image name,
 *                          e.g. 'bob/ubuntu:latest', a lookup in this Moray
 *                          bucket will tell if the account has that image
 *                          pulled and tagged.
 *      Image               All pulled images for each account (not just
 *                          tagged ones). This table holds Docker image
 *                          metadata for each pulled image.
 *      TombstoneImage      A record of images that have been removed, via
 *                          `docker rmi`, are not used by any account in SDC
 *                          and are slated for actual deletion after a
 *                          period.
 *
 *
 * Common naming:
 *
 *      imgId               A Docker image ID, the full 64-char string.
 *                          Also sometimes called `docker_id`.
 *      imgTag              An ImageTag instance
 *      img                 An Image model instance
 *      imageUuid, uuid, image_uuid
 *                          "uuid" always refers to the SDC IMGAPI UUID for
 *                          this Docker image.
 *      sdcImg?             Naming for SDC IMGAPI images, if necessary?
 */

var assert = require('assert-plus');
var format = require('util').format;
var imgmanifest = require('imgmanifest');
var drc = require('docker-registry-client');
var sdcClients = require('sdc-clients');
var IMGAPI = sdcClients.IMGAPI;
var VMAPI = sdcClients.VMAPI;
var vasync = require('vasync');

var Image = require('../../models/image');
var ImageTag = require('../../models/image-tag');
var errors = require('../../../lib/errors');
var TombstoneImage = require('../../models/tombstone-image');
var utils = require('./utils');
var waitForJob = require('../../common').waitForJob;



//---- globals

var _vmapiClientCache; // set in `getVmapiClient`


//---- internal support routines

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
    var imgapi = opts.app.imgapi;

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

        Image.list(app, log, params, function (err, images) {
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

            ImageTag.list(app, log, getParams, function (err, imageTag) {
                if (err) {
                    cb(err);
                    return;
                }
                var repoTags = imageTag.map(function (it) {
                    return it.repo + ':' + it.tag;
                });
                pushImage(serialized, repoTags);
                cb();
            });
        }
    }
}


/**
 * Gets an image (model object) from an ImageTag instance.
 *
 * @param {Object} opts
 * @param {Object} opts.imgInfo An object with 'repo' and 'docker_id' fields
 *      (the fields required to uniquely identify an image). Commonly this
 *      is an ImageTag instances, e.g. from `imgTagFromName`.
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param callback {Function} `function (err, image)`
 */
function imgFromImgInfo(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.imgInfo, 'opts.imgInfo');
    assert.object(opts.account, 'opts.account');
    assert.optionalObject(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');

    var indexName = drc.parseRepo(opts.imgInfo.repo).index.name;
    var filter = {
        owner_uuid: opts.account.uuid,
        index_name: indexName,
        docker_id: opts.imgInfo.docker_id
    };

    Image.list(opts.app, opts.log, filter, function (err, images) {
        if (err) {
            callback(err);
            return;
        } else if (!images.length) {
            callback(new errors.ResourceNotFoundError(format(
                'No such image id (from registry %s): %s', indexName,
                opts.imgId)));
            return;
        }
        assert.equal(images.length, 1);
        callback(null, images[0]);
    });
}


/**
 * Find the Docker imgTag for the named image (and for the given account).
 *
 * Given a name, e.g. 'cafe', that could be either a name or an id prefix,
 * Docker semantics say that *name* wins. That means we need to lookup by
 * name first, then fallback to imgId prefix.
 *
 * Ambiguity notes:
 * 1. One form of ambiguity is if an imgId prefix matches more than one imgId.
 *    For this case, this function returns no imgTag.
 * 2. There is another form. Because SDC's design of keeping Docker images from
 *    different registry hosts separate, even if they have the same imgId, we
 *    have a potential confusion for users and an *inherent ambiguity in
 *    referring to images by imgId*. For now, if such an ambiguity comes
 *    up we'll return an error here: `AmbiguousDockerImageIdError`.
 *
 * @param {Object} opts
 * @param {Object} opts.app App instance
 * @param {Object} opts.log Bunyan log instance
 * @param {String} opts.name An imgId, imgId prefix or image
 *      [REGHOST]NAME[:TAG] name.
 * @param {Object} opts.account
 * @param callback {Function} `function (err, imgTag)` where `imgTag` will
 *      be undefined if no matching image or no *unambiguous* match was found.
 *
 * TODO: this logic should live in models/image-tag.js
 */
function imgTagFromName(opts, callback) {
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.name, 'opts.name');
    assert.object(opts.account, 'opts.account');

    try {
        var rat = drc.parseRepoAndTag(opts.name);
    } catch (e) {
        callback(new errors.DockerError(e, e.message));
        return;
    }
    var name = rat.localName;
    var tag = rat.tag;

    var filter = [
        {repo: name, owner_uuid: opts.account.uuid, tag: tag}
    ];
    if (/^[0-9a-f]+$/.test(name) && name.length <= 64) {
        // Could possibly be an imgId.
        if (name.length === 64) {
            filter.push({docker_id: name, owner_uuid: opts.account.uuid});
        } else {
            filter.push({docker_id: name + '*', owner_uuid: opts.account.uuid});
        }
    }

    ImageTag.list(opts.app, opts.log, filter, function (err, imgTags) {
        var imgTag;
        if (err || imgTags.length === 0) {
            /*jsl:pass*/
        } else if (imgTags.length === 1) {
            imgTag = imgTags[0];
        } else {
            // If there is an exact repo===name match, then use that.
            var imgIds = {};
            var registries = {};
            for (var i = 0; i < imgTags.length; i++) {
                var it = imgTags[i];
                if (it.repo === name) {
                    imgTag = it;
                    break;
                }
                imgIds[it.docker_id] = true;
                var registry = drc.parseRepo(it.repo).index.name;
                registries[registry] = true;
            }
            if (!imgTag && Object.keys(imgIds).length === 1) {
                /*
                 * All matches are for a single imgId, either:
                 * - They are all for the same repo, meaning they are point
                 *   to a unique IMGAPI image, so we can return any one of
                 *   them (on the presumption that the imgTag is being used to
                 *   identify a unique image). Or,
                 * - They are from multiple registries, meaning ambiguity
                 *   case #2 described above.
                 */
                if (Object.keys(registries).length === 1) {
                    imgTag = imgTags[0];
                } else {
                    err = new errors.AmbiguousDockerImageIdError(
                        name, registries);
                }
            }
        }
        opts.log.debug({err: err, filter: filter, numImgTags: imgTags.length,
            opts: {name: opts.name}, imgTag: imgTag}, 'imgTagFromName');
        callback(err, imgTag);
    });
}


/**
 * Inspect an image
 *
 * @param {Object} opts
 * @param {Object} opts.app App instance
 * @param {Object} opts.log Bunyan log instance
 * @param {String} opts.name An imgId or image NAME[:TAG] to inspect.
 *      If just "NAME" is given then TAG=latest is implied.
 * @param {Object} opts.account
 * @param callback {Function} `function (err, history)`
 */
function getImageHistory(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.name, 'opts.name');
    assert.object(opts.account, 'opts.account');

    var app = opts.app;
    var log = opts.log;
    var history = [];

    vasync.pipeline({arg: {}, funcs: [
        function getImgId(ctx, next) {
            imgTagFromName(opts, function (err, imgTag) {
                if (err) {
                    next(err);
                } else if (!imgTag) {
                    next(new errors.ResourceNotFoundError(
                        'No such image: ' + opts.name));
                } else {
                    ctx.imgTag = imgTag;
                    next();
                }
            });
        },

        function gatherHistory(ctx, next) {

            function getNextOne(imgInfo) {
                imgFromImgInfo({
                    app: app,
                    log: log,
                    imgInfo: imgInfo,
                    account: opts.account
                }, function (err, img) {
                    if (err) {
                        next(err);
                    } else {
                        var createdBy = '';
                        if (img.container_config && img.container_config.Cmd) {
                            createdBy = img.container_config.Cmd.join(' ');
                        }
                        var created = Math.floor((new Date(img.created))
                            .getTime() / 1000);
                        history.push({
                            Id: img.docker_id,
                            Created: created,
                            CreatedBy: createdBy,
                            Size: img.size
                        });

                        if (img.parent) {
                            getNextOne({
                                repo: imgInfo.repo,
                                docker_id: img.parent
                            });
                        } else {
                            next();
                        }
                    }
                });
            }

            getNextOne(ctx.imgTag);
        }
    ]}, function (err) {
        callback(err, history);
    });
}


/*
 * TODO: Is the 'noprune' option ever called by `docker`? What is it for?
 */
function deleteImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.app, 'opts.app');
    assert.bool(opts.force, 'opts.force');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.name, 'opts.name');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var dcRefcount;
    var head;
    var history = [];
    var layers;
    var name = opts.parsed.name;
    var repo;
    var tag;

    var app = opts.app;
    var log = opts.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    vasync.pipeline({ funcs: [
        ensureIsHeadImage,
        getHeadImage,
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

    function ensureIsHeadImage(_, cb) {
        // XXX inspectImage sig change
        inspectImage(opts, function (err, imageObj, imageLayer) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }

            // Cannot remove intermediate layer
            var layer = imageLayer.raw();
            if (layer.head !== true) {
                var heads = layer.heads.map(function (imgId) {
                    return imgId.substr(0, 12);
                }).join(', ');

                var message = format('Conflict, %s wasn\'t deleted because it '
                    + 'is an intermediate layer being referenced by %s',
                    layer.docker_id.substr(0, 12), heads);
                cb(new errors.DockerError(message));
                return;
            }

            cb();
        });
    }

    function getHeadImage(_, cb) {
        var tagParams = [ {docker_id: format('*%s*', name)}, {
            name: name,
            owner_uuid: opts.account.uuid,
            tag: opts.parsed.tag
        }];

        ImageTag.list(app, log, tagParams, function (err, imageTags) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            } else if (!imageTags.length) {
                cb(new errors.ResourceNotFoundError(
                    'No such id: ' + opts.parsed.repo));
                return;
            }

            head = imageTags[0].docker_id;
            // Use known repo/tag once retrieved from database. This will
            // get the proper tag name docker rm is called with an id
            repo = imageTags[0].repo;
            tag = imageTags[0].tag;
            cb();
        });
    }

    function verifyNotInUse(_, cb) {
        var image_uuid;
        var layerParams = {
            docker_id: head,
            owner_uuid: opts.account.uuid
        };

        Image.list(app, log, layerParams, function (err, _layers) {
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

        Image.list(app, log, layerParams, function (err, _layers) {
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

        Image.datacenterRefcount(app, log, params, function (err, count) {
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

            Image.update(app, log, obj, cb);
            return;
        }

        var tombstone = (dcRefcount[layer.docker_id] !== undefined);
        var delOpts = {
            docker_id: layer.docker_id,
            owner_uuid: opts.account.uuid
        };

        Image.del(app, log, delOpts, function (err) {
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

        ImageTag.del(app, log, delOpts, function (err) {
            if (err) {
                cb(err);
                return;
            }

            history.push({ Untagged: repo + ':' + tag });
            cb();
        });
    }
}


/**
 * Inspect an image.
 *
 * @param name {String} An imgId or image NAME[:TAG] to inspect.
 *      If just "NAME" is given then TAG=latest is implied.
 * ...
 */
function inspectImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.name, 'opts.name');
    assert.object(opts.log, 'opts.log');

    var imgTag, img;

    vasync.pipeline({funcs: [
        function getImgTag(_, next) {
            imgTagFromName(opts, function (err, imgTag_) {
                if (err) {
                    next(err);
                } else if (!imgTag_) {
                    next(new errors.ResourceNotFoundError(
                        'No such image: ' + opts.name));
                } else {
                    imgTag = imgTag_;
                    next();
                }
            });
        },

        function getImg(_, next) {
            imgFromImgInfo({
                app: opts.app,
                log: opts.log,
                imgInfo: imgTag,
                account: opts.account
            }, function (err, img_) {
                if (err) {
                    next(err);
                } else {
                    img = img_;
                    next();
                }
            });
        }

    ]}, function (err) {
        if (err) {
            callback(err);
        } else {
            var inspect = utils.imgobjToInspect(img);
            callback(null, inspect, img);
        }
    });
}


function pullImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.rat, 'opts.rat');  // rat === Repo And Tag
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
            // XXX err formating,
            // XXX clearer err handling, use 'error' payload?
            // XXX getting err codes
            payload = {
                status: errors.formatErrOrText(opts.req, opts.res, err)
            };
            console.log('XXX payload formatted', payload);
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
            rat: opts.rat,
            req_id: opts.req_id,
            account: opts.account,
            regAuth: opts.req.headers['x-registry-auth']
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
            opts.app.sockets.setSocket('job', opts.rat.canonicalName, {
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
    getImageHistory: getImageHistory,
    listImages: listImages,
    inspectImage: inspectImage,
    pullImage: pullImage
};
