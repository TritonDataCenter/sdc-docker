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
 * Get all the images available to the given account.
 *
 * Dev note on `Uuid` field:
 * I've added a `Uuid` as required for "utils.js#imageFromUuid" (used for
 * `docker ps`) to function. This field doesn't exist in Docker-land
 * representation of an image object. However, AFAICT the way `listImages` is
 * currently used that `Uuid` field doesn't get exposed. IOW, no harm, no foul.
 *
 * @param {Object} opts
 * @param {String} opts.account The account to which to limit access.
 * @param {Object} opts.all Include intermediate docker layer images.
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param {UUID} opts.req_id
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
        var filters = {
            type: 'zone-dataset',
            account: opts.account.uuid,
            state: 'active'
        };

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

                dockerImage.RepoTags = [
                    img.uuid + ':' + img.version,
                    img.uuid + ':latest'
                ];
                dockerImage.Uuid = img.uuid;
                dockerImage.Id = (img.uuid + img.uuid).replace(/-/g, '');
                dockerImage.Created = Math.floor((new Date(img.published_at))
                    .getTime() / 1000);
                // Note: Slightly different semantics. This is showing the
                // (possibly compressed) image file size. Good enough.
                dockerImage.Size = img.files[0].size;
                // Note: this doesn't handle ancestry size.
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
                Uuid: img.image_uuid,
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

            // Intermediate layers don't have tags.
            if (!serialized.head) {
                pushImage(serialized);
                cb();
                return;
            }

            // XXX(trentm): Incorrect for 'same docker id, separate repo'.
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
 * Gets an image (model object).
 *
 * @param {Object} opts
 * @param {Object} opts.account
 * @param {Object} opts.indexName
 * @param {Object} opts.imgId
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param callback {Function} `function (err, image)`
 */
function imgFromImgInfo(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.indexName, 'opts.indexName');
    assert.string(opts.imgId, 'opts.imgId');

    var filter = {
        owner_uuid: opts.account.uuid,
        index_name: opts.indexName,
        docker_id: opts.imgId
    };
    Image.list(opts.app, opts.log, filter, function (err, imgs) {
        if (err) {
            callback(err);
            return;
        } else if (!imgs.length) {
            callback(new errors.ResourceNotFoundError(format(
                'No such image id (from registry %s): %s', opts.indexName,
                opts.imgId)));
            return;
        }
        assert.equal(imgs.length, 1);
        callback(null, imgs[0]);
    });
}


/**
 * Find the img (an 'Image' model object instance) for the named Docker
 * image (and for the given account).
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
 *    referring to images by imgId*. E.g., the same busybox image pulled from
 *    docker.io and from quay.io will have the same imgId, but different
 *    imgUuid in SDC. For now, if such an ambiguity comes up we'll return
 *    an error here: `AmbiguousDockerImageIdError`.
 *
 * @param {Object} opts
 * @param {Object} opts.app App instance
 * @param {Object} opts.log Bunyan log instance
 * @param {String} opts.name An imgId, imgId prefix or image
 *      [REGHOST]NAME[:TAG] name.
 * @param {Object} opts.account
 * @param callback {Function} `function (err, img, imgTag)`
 *      `img` is an `Image` instance or will be undefined if no matching
 *      image or no *unambiguous* match was found.
 *      `imgTag` will be the `ImageTag` instance for `name` iff it was found
 *      by name. E.g. if `name` is an imgId, then `imgTag` will be undefined.
 */
function imgFromName(opts, callback) {
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

    var imgUuid;
    var imgTag;
    var img;

    vasync.pipeline({funcs: [
        function findByName(_, next) {
            var filter = [
                {repo: name, owner_uuid: opts.account.uuid, tag: tag}
            ];
            ImageTag.list(opts.app, opts.log, filter, function (err, imgTags) {
                if (err) {
                    next(err);
                } else if (imgTags.length === 0) {
                    next();
                } else {
                    imgTag = imgTags[0];
                    // We can calculate the imgUuid from the ImageTag fields.
                    imgUuid = imgmanifest.imgUuidFromDockerInfo({
                        id: imgTag.docker_id,
                        indexName: drc.parseRepo(imgTag.repo).index.name
                    });
                    next();
                }
            });
        },

        function findImage(_, next) {
            var filter = [];
            if (imgUuid) {
                // We've found an imgTag, get the `Image` for it.
                filter.push(
                    {image_uuid: imgUuid, owner_uuid: opts.account.uuid});
            } else if (/^[0-9a-f]+$/.test(name) && name.length <= 64) {
                // Else, could possibly be an imgId, search for that.
                if (name.length === 64) {
                    filter.push(
                        {docker_id: name, owner_uuid: opts.account.uuid});
                } else {
                    filter.push(
                        {docker_id: name + '*', owner_uuid: opts.account.uuid});
                }
            } else {
                next();
                return;
            }

            Image.list(opts.app, opts.log, filter, function (err, imgs) {
                if (err || imgs.length === 0) {
                    /*jsl:pass*/
                } else if (imgs.length === 1) {
                    img = imgs[0];
                } else {
                    var imgIds = {};
                    var indexNames = [];
                    for (var i = 0; i < imgs.length; i++) {
                        var ix = imgs[i];
                        imgIds[ix.docker_id] = true;
                        indexNames.push(ix.index_name);
                    }
                    if (Object.keys(imgIds).length === 1) {
                        assert.ok(indexNames.length > 1);
                        /*
                         * We have multiple hits for a single imgId, this is
                         * ambiguity case #2 described above.
                         */
                        err = new errors.AmbiguousDockerImageIdError(
                            name, indexNames);
                    }
                }
                next(err);
            });
        }
    ]}, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null, img, imgTag);
        }
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

    function historyItemFromImg(img) {
        var createdBy = '';
        if (img.container_config && img.container_config.Cmd) {
            createdBy = img.container_config.Cmd.join(' ');
        }
        var created = Math.floor((new Date(img.created))
            .getTime() / 1000);
        return {
            Id: img.docker_id,
            Created: created,
            CreatedBy: createdBy,
            Size: img.size
        };
    }

    vasync.pipeline({arg: {}, funcs: [
        function getImgId(ctx, next) {
            imgFromName(opts, function (err, img) {
                if (err) {
                    next(err);
                } else if (!img) {
                    next(new errors.ResourceNotFoundError(
                        'No such image: ' + opts.name));
                } else {
                    ctx.img = img;
                    next();
                }
            });
        },

        function gatherHistory(ctx, next) {

            function addAndGetNextItem(img) {
                history.push(historyItemFromImg(img));

                if (!img.parent) {
                    next();
                    return;
                }

                imgFromImgInfo({
                    app: app,
                    log: log,
                    account: opts.account,
                    indexName: img.index_name,
                    imgId: img.parent
                }, function (err, parentImg) {
                    if (err) {
                        next(err);
                    } else {
                        addAndGetNextItem(parentImg);
                    }
                });
            }

            addAndGetNextItem(ctx.img);
        }
    ]}, function (err) {
        callback(err, history);
    });
}


/* BEGIN JSSTYLED */
/*
 * Exploring `docker rmi ...` behaviour:
 *

$ docker history hello-world
IMAGE               CREATED             CREATED BY                                      SIZE
ef872312fe1b        7 months ago        /bin/sh -c #(nop) CMD [/hello]                  0 B
7fa0dcdc88de        7 months ago        /bin/sh -c #(nop) ADD file:e524d9aa2d2d2b65c5   910 B
511136ea3c5a        23 months ago

 *
 * - Docker: if a container is using that image, don't delete it.
 *   SDC: We don't *need* to have that requirement. We can remove an image for
 *   future provs, but current containers are fine. However, for now we'll
 *   match that behaviour.
 *

$ docker rmi hello-world
Error response from daemon: Conflict, cannot delete ef872312fe1b because the container 32a4a48c4b89 is using it, use -f to force
FATA[0000] Error: failed to remove one or more images

 *
 * - '-f' will force remove that image even if a *stopped* container is using
 *   it. It won't force remove an image with a *running* container using it.
 *
 *   XXX(trentm): Not sure this is accurate with subsequent 1.6.0 testing.
 *      I was able to untag, but not delete the image id if there was a
 *      stopped container.
 *

$ docker rmi -f hello-world
Untagged: hello-world:latest
Deleted: ef872312fe1bbc5e05aae626791a47ee9b032efa8f3bda39cc0be7b56bfe59b9
Deleted: 7fa0dcdc88de9c8a856f648c1f8e0cf8141a505bbddb7ecc0c61f1ed5e086852

 *
 * - Note that the previous delete did not remove the 511136ea3c5a image
 *   because it is used by other images.
 *
 * - Now that the image was force removed, in Docker-docker I can't start that
 *   container
 *

$ docker start 32a4a48c4b89
Error response from daemon: Cannot start container 32a4a48c4b89: Error getting container 32a4a48c4b8946bbf087930f5df9d55bed55ec2afa2d9cad16abb304edc11e5d from driver aufs: invalid argument
FATA[0000] Error: failed to start one or more containers

 *
 * - If there are other tags on the image, then just untag it:
 *

$ docker rmi ef
Untagged: ef:latest

 *
 * - Can't remove images that have children. This is effectively the same
 *   thing as saying "non-head" images, as long as we trust we're keeping
 *   our 'head' info up to date (in the Image model). Docker-docker's error
 *   message leaves something to be desired. We'll do a little better.
 *

$ docker rmi b2eda1f5dec1
Error response from daemon: Conflict, b2eda1f5dec1 wasn't deleted
FATA[0000] Error: failed to remove one or more images

 *
 * - Deleting by imgId will will untag *all image tags to that id.
 *

$ docker rmi 156401cf89a1
Untagged: postgres:9.1
Untagged: postgres:9.1.14
Deleted: 156401cf89a1e3486dfd2468aa55d807584ccdc6e122dc07fa0a7d1ddefd80e5
...
Deleted: 7ac189b455b8fd7704dde3cff6fcf940900c343e63c1d92558592959ce1a28aa

*
*    Unless that is tagged for separate repositories.
*

ubuntu@1fd15fd8-e5cd-6ef0-ab35-aae2181b7cd4:~$ docker images
REPOSITORY                    TAG                 IMAGE ID            CREATED             VIRTUAL SIZE
165.225.157.24:5001/busybox   latest              8c2e06607696        4 weeks ago         2.433 MB
localhost:5001/busybox        latest              8c2e06607696        4 weeks ago         2.433 MB
busybox                       latest              8c2e06607696        4 weeks ago         2.433 MB
busybox                       trent               8c2e06607696        4 weeks ago         2.433 MB

ubuntu@1fd15fd8-e5cd-6ef0-ab35-aae2181b7cd4:~$ docker rmi 8c2e06607696
Error response from daemon: Conflict, cannot delete image 8c2e06607696 because it is tagged in multiple repositories, use -f to force
FATA[0000] Error: failed to remove one or more images

 *
 * - TODO: Support 'noprune' option.
 */
/* END JSSTYLED */
function deleteImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.app, 'opts.app');
    assert.bool(opts.force, 'opts.force');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.name, 'opts.name');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var DRY_RUN = false; // for development
    var app = opts.app;
    var log = opts.log;
    var vmapi = getVmapiClient(this.config.vmapi);
    var changes = [];
    log.debug({name: opts.name}, 'deleteImage');

    vasync.pipeline({arg: {}, funcs: [
        getImg,
        ensureIsHeadImage,
        getImgTags,
        verifyNotInUse,
        getImgsToDelete,
        getDatacenterRefcount,
        deleteImgs,
        untagHeads
    ]}, function (err) {
        callback(err, changes.reverse());
    });


    function getImg(ctx, cb) {
        imgFromName(opts, function (err, img, imgTag) {
            if (err) {
                cb(err);
            } else if (!img) {
                cb(new errors.ResourceNotFoundError(
                    'No such image: ' + opts.name));
            } else {
                log.debug({img: img, imgTag: imgTag}, 'deleteImage: getImg');
                ctx.img = img;
                if (imgTag) {
                    // Only set if `name` was not an imgId.
                    ctx.imgTags = [imgTag];
                }
                cb();
            }
        });
    }

    function ensureIsHeadImage(ctx, cb) {
        if (ctx.img.head !== true) {
            var heads = ctx.img.heads.map(function (imgId) {
                return imgId.substr(0, 12);
            }).join(', ');
            var message = format('Conflict, %s wasn\'t deleted because it '
                + 'is an intermediate layer being referenced by %s',
                ctx.img.docker_id.substr(0, 12), heads);
            cb(new errors.DockerError(message));
        } else {
            cb();
        }
    }

    function getImgTags(ctx, cb) {
        if (ctx.imgTags) {
            cb();
            return;
        }

        /*
         * This is a head image, but we don't have an imgTag for it: IOW it
         * was named by imgId. Find all imgTags for this guy for untagging.
         *
         * Note: if there are tags from more than one repository, then we
         * should error out (see TODO above).
         */
        var filter = {
            docker_id: ctx.img.docker_id,
            owner_uuid: opts.account.uuid
        };
        ImageTag.list(app, log, filter, function (err, imgTags) {
            if (err) {
                cb(err);
                return;
            }
            log.debug({docker_id: ctx.img.docker_id, imgTags: imgTags},
                'deleteImage: getImgTags');

            // Get the set of repos. If more than one, then error out.
            var repos = {};
            imgTags.forEach(function (it) { repos[it.repo] = true; });
            repos = Object.keys(repos);
            if (repos.length > 1 && !opts.force) {
                cb(new errors.DockerError(format('Conflict, cannot delete '
                    + 'image %s because it is tagged in multiple '
                    + 'repositories (%s), use -f to force', opts.name,
                    repos.join(', '))));
                return;
            }

            ctx.imgTags = imgTags;
            cb();
        });
    }

    function verifyNotInUse(ctx, cb) {
        // If force === false this function will return an error if there is at
        // least a running or stopped VM using the image.
        // If force === true, it will return an error if there is at least a
        // running VMusing the image
        var query = {
            docker: true,
            state: (opts.force ? 'running' : 'active'),
            image_uuid: ctx.img.image_uuid,
            owner_uuid: opts.account.uuid
        };

        vmapi.listVms(query, {
            headers: {'x-request-id': opts.req_id}
        }, function (vmapiErr, vms) {
            if (vmapiErr) {
                cb(errors.vmapiErrorWrap(vmapiErr,
                    'could not delete image'));
                return;
            } else if (vms.length === 0) {
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
            // If the vm is state=incomplete, we might not have
            // internal_metadata.
            var sId = utils.vmUuidToShortDockerId(vms[0].uuid);
            if (vms[0].state === 'running') {
                messageFormat = 'Conflict, cannot %sdelete %s because '
                    + 'the running container %s is using it, stop it and '
                    + 'use -f to force';
            } else {
                messageFormat = 'Conflict, cannot %sdelete %s because '
                    + 'the container %s is using it, use -f to force';
            }
            var message = format(messageFormat, forceStr,
                opts.name, sId);

            cb(new errors.DockerError(message));
        });
    }

    function getImgsToDelete(ctx, cb) {
        /*
         * Get all the docker images that have this image as a head. (This
         * should be the same as this image's history/ancestry.) This includes
         * itself (a head image has itself in 'heads').
         *
         * Dev Note: This should be the same as this image's history/ancestry.
         * We are relying on moray insert ordering (a default sort?) to
         * have a correct ordering. A problem with that might only show
         * up with tombstone deletes of IMGAPI images. Perhaps share
         * getting the ancestry with `getImageHistory`?
         */
        var filter = {
            heads: ctx.img.docker_id,
            index_name: ctx.img.index_name,
            owner_uuid: opts.account.uuid
        };
        Image.list(app, log, filter, function (err, imgs) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }
            ctx.imgsToDelete = imgs;
            cb();
        });
    }

    // Get all images that are ready to be moved to docker_tombstones.
    function getDatacenterRefcount(ctx, cb) {
        var params = {
            docker_id: ctx.img.docker_id,
            // XXX need index_name in here and datacenterRefcount
            limit: 1
        };
        Image.datacenterRefcount(app, log, params, function (err, count) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }
            ctx.dcRefcount = count;
            cb();
        });
    }

    function deleteImgs(ctx, cb) {
        vasync.forEachPipeline({
            inputs: ctx.imgsToDelete,
            func: function deleteOneImg(img, nextImg) {
                /*
                 * We only remove the image when it is no longer being used
                 * by the account. If this is the last usage of the image
                 * across the whole DC (dcRefcount), then we mark this image
                 * to be deleted (after a waiting period) by creating a new
                 * TombstoneImage object.
                 */
                log.debug({imgId: img.docker_id, indexName: img.index_name},
                    'deleteImage: deleteOneImg');
                if (DRY_RUN) {
                    changes.push({ Deleted: img.docker_id });
                    nextImg();
                    return;
                }

                if (img.refcount > 1) {
                    log.debug({imgId: img.docker_id, indexName: img.index_name},
                        'deleteImage: remove %s from heads', ctx.img.docker_id);
                    var heads = img.params.heads.filter(function (id) {
                        return id !== ctx.img.docker_id;
                    });
                    Image.update(app, log, {
                        owner_uuid: img.owner_uuid,
                        index_name: img.index_name,
                        docker_id: img.docker_id,
                        // Update:
                        heads: heads
                    }, nextImg);

                } else {
                    var shouldTombstone = (ctx.dcRefcount[img.docker_id]
                                            !== undefined);
                    log.debug({imgId: img.docker_id, indexName: img.index_name},
                        'deleteImage: delete image', ctx.img.docker_id);
                    Image.del(app, log, img, function (err) {
                        if (err) {
                            nextImg(err);
                            return;
                        }
                        changes.push({ Deleted: img.docker_id });

                        if (!shouldTombstone) {
                            nextImg();
                            return;
                        }

                        log.debug({imgId: img.docker_id,
                            indexName: img.index_name},
                            'deleteImage: tombstone');
                        TombstoneImage.create(app, log, {
                            docker_id: img.docker_id,
                            image_uuid: img.image_uuid
                        }, nextImg);
                    });
                }
            }
        }, function (err) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }
            cb();
        });
    }

    function untagHeads(ctx, cb) {
        log.debug({imgTags: ctx.imgTags}, 'deleteImage: untagHeads');

        vasync.forEachPipeline({
            inputs: ctx.imgTags,
            func: function untagOne(imgTag, nextImgTag) {
                if (DRY_RUN) {
                    changes.push({ Untagged: imgTag.repo + ':' + imgTag.tag });
                    nextImgTag();
                    return;
                }
                ImageTag.del(app, log, imgTag, function (err) {
                    if (err) {
                        nextImgTag(err);
                    } else {
                        changes.push({
                            Untagged: imgTag.repo + ':' + imgTag.tag });
                        nextImgTag();
                    }
                });
            }
        }, cb);
    }
}


/**
 * Inspect an image.
 *
 * @param name {String} An imgId, imgId prefix, or image [REG/]NAME[:TAG] to
 *      inspect.
 * ...
 */
function inspectImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.name, 'opts.name');
    assert.object(opts.log, 'opts.log');

    imgFromName(opts, function (err, img) {
        if (err) {
            callback(err);
        } else if (!img) {
            callback(new errors.ResourceNotFoundError(
                'No such image: ' + opts.name));
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
            console.log('XXX error reporting in pullImage: payload', payload);
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
