/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var restify = require('restify');
var sdcClients = require('sdc-clients');
var vasync = require('vasync');
var imgmanifest;
var dockerRegistry = require('docker-registry-client');
var urlModule;
var imgapiUrl;
var dockerUrl;

var VERSION = '1.0.1';


function getImageMetadata(job, cb) {
    var session;
    // Initialize the job data that is going to be used by each
    // subsequent task
    job.params.data = { images: {}, virtual_size: 0 };

    function getRegistrySession(_, next) {
        dockerRegistry.createRegistrySession({
            repo: job.params.parsed.repo
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
            job.params.data.repoTags = repoTags;
            job.params.data.askedImg = repoTags[job.params.askedTag];
            next();
        });
    }

    function getImageAncestry(_, next) {
        job.log.info('Getting ancestry for image %s', job.params.data.askedImg);
        session.getImgAncestry({
            imgId: job.params.data.askedImg
        }, function (err, ancestry) {
            if (err) {
                next(err);
                return;
            }

            // Start pulling from parent to children until IMGAPI supports
            // orphan images
            job.params.data.ancestry = ancestry.reverse();
            next();
        });
    }

    vasync.pipeline({
        funcs: [
            getRegistrySession,
            getRepoTags,
            getImageAncestry
        ]
    }, function (err, results) {
        if (err) {
            cb(err);
            return;
        }

        return cb(null, 'getImageMetadata completed');
    });
}

function pullImageLayers(job, cb) {
    job.log.info('Pulling dependent layers for %s', job.params.data.askedImg);
    var session;
    var queue = vasync.queue(writeProgress, 5);

    // For now assume dockerUrl is the URL to the DOCKER_HOST. In this case
    // we parse the URL to obtain the location of the admin host
    var parsedUrl = urlModule.parse(dockerUrl);
    var dockerAdminiUrl = parsedUrl.protocol + '//' + parsedUrl.hostname;
    var dockerAdmin = restify.createJsonClient({ url: dockerAdminiUrl });
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});

    function writeProgress(progress, next) {
        progress.id = progress.id.substr(0, 12);

        if (!progress.progressDetail) {
            progress.progressDetail = {};
        }
        var data = {
            id: job.params.parsed.repo,
            payload: progress
        };

        dockerAdmin.post('/admin/progress', data, function (err, req, res) {
            if (err) {
                job.log.info(err, 'Could not post progress');
                next(err);
            } else {
                job.log.info('Posted progress for %j', data);
                next();
            }
        });
    }

    function getImgJson(arg, next) {
        var imgId = arg.imgId;
        session.getImgJson({
            imgId: imgId
        }, function (err, imgJson, getRes) {
            if (err) {
                next(err);
                return;
            }

            var size = Number(getRes.headers['x-docker-size']);
            job.params.data.images[imgId] = {
                size: size,
                created: new Date(imgJson.created).getTime()
            };
            job.params.data.virtual_size += size;
            arg.imgJson = imgJson;

            next();
        });
    }

    function validateImgapiImageExists(arg, next) {
        var imgId = arg.imgId;
        var uuid = imgmanifest.imgUuidFromDockerId(imgId);

        var opts = { headers: { 'x-request-id': job.params.req_id } };
        imgapi.getImage(uuid, opts, function (err, img) {
            if (err && err.name === 'ResourceNotFoundError') {
                next();
                return;
            } else if (err) {
                next(err);
                return;
            }

            // If the image has been created but no files were added
            if (img.state == 'unactivated') {
                arg.unactivated = true;
            } else {
                arg.exists = true;
            }

            next();
        });
    }

    function createImgapiImage(arg, next) {
        if (arg.exists || arg.unactivated) {
            next();
            return;
        }

        var imgJson = arg.imgJson;
        var manifest = imgmanifest.imgManifestFromDockerJson({
            imgJson: imgJson
        });

        manifest.os = 'linux';
        manifest.tags.docker = true;
        delete manifest.state;

        job.params.data.images[arg.imgId].owner = manifest.owner;

        var opts = {
            skipOwnerCheck: true,
            headers: { 'x-request-id': job.params.req_id }
        };
        imgapi.adminImportImage(manifest, opts, function (impErr, img) {
            if (impErr) {
                next(impErr);
                return;
            }
            next();
        });
    }

    function addImageFile(arg, next) {
        if (arg.exists) {
            next();
            return;
        }

        var imgId = arg.imgId;
        job.log.info('Pulling fs layer for %s', imgId);
        queue.push({
            id: imgId,
            status: 'Pulling fs layer'
        });

        session.getImgLayerStream({
            imgId: imgId
        }, function (err, stream) {
            if (err) {
                next(err);
                return;
            }

            var lastUpdate = 0;
            var updateEvery = 512 * 1024;
            var total = job.params.data.images[imgId].size;
            var uuid = imgmanifest.imgUuidFromDockerId(imgId);

            var currentBytes = 0;
            var startTs = Math.floor(new Date().getTime() / 1000);

            imgapi.addImageFile({
                uuid: uuid,
                file: stream,
                size: total,
                compression: 'none'
            }, function (addErr) {
                if (addErr) {
                    next(addErr);
                    return;
                }
                next();
            });

            stream.on('end', function () {
                job.log.info('fs layer completed for %s', imgId);
                queue.push({
                    id: imgId,
                    status: 'Downloading',
                    progressDetail: {
                        current: currentBytes,
                        total: total,
                        start: startTs
                    }
                });
            });

            stream.on('data', function (chunk) {
                currentBytes += chunk.length;
                if ((currentBytes - lastUpdate) > updateEvery) {
                    queue.push({
                        id: imgId,
                        status: 'Downloading',
                        progressDetail: {
                            current: currentBytes,
                            total: total,
                            start: startTs
                        }
                    });
                    lastUpdate = currentBytes;
                }
            });

            // TODO next(err) will be called twice
            stream.on('error', function (streamErr) {
                next(streamErr);
            });
        });
    }

    function activateImage(arg, next) {
        if (arg.exists) {
            next();
            return;
        }

        var imgId = arg.imgId;
        queue.push({
            id: imgId,
            status: 'Activating image.'
        });
        var uuid = imgmanifest.imgUuidFromDockerId(imgId);
        imgapi.activateImage(uuid, next);
    }

    function createDockerImage(arg, next) {
        var imgId = arg.imgId;
        var data = {
            owner_uuid: job.params.data.images[imgId].owner,
            docker_id: imgId
        };

        dockerAdmin.get({
            path: '/admin/images',
            query: data
        }, function (err, req, res, images) {
            if (err) {
                next(err);
                return;
            } else if (images.length) {
                next();
                return;
            }

            data.created = job.params.data.images[imgId].created;
            data.size = job.params.data.images[imgId].size;
            data.virtual_size = job.params.data.virtual_size;
            if (imgId === job.params.data.askedImg) {
                data.head = true;
            }

            dockerAdmin.post('/admin/images', data, next);
        });
    }

    function pullOneLayer(imgId, next) {
        queue.push({
            id: imgId,
            status: 'Pulling metadata.'
        });

        var arg = { imgId: imgId };
        vasync.pipeline({
            funcs: [
                getImgJson,
                validateImgapiImageExists,
                createImgapiImage,
                addImageFile,
                activateImage,
                createDockerImage
            ],
            arg: arg
        }, function (err, results) {
            if (err) {
                next(err);
                return;
            }

            var message = (arg.exists ? 'Already exists'
                                        : 'Download complete.');
            queue.push({
                id: imgId,
                status: message
            });
            next();
        });
    }

    dockerRegistry.createRegistrySession({
        repo: job.params.parsed.repo
    }, function (err, sess) {
        if (err) {
            cb(err);
            return;
        }

        queue.push({
            id: job.params.data.askedImg,
            status: 'Pulling dependent layers'
        });

        session = sess;
        vasync.forEachPipeline({
            func: pullOneLayer,
            inputs: job.params.data.ancestry
        }, function (vErr, results) {
            queue.close();

            // Wait for queue to finish before ending the task
            queue.on('end', function () {
                if (vErr) {
                    cb(vErr);
                    return;
                }

                cb(null, 'pullImageLayers completed');
            });
        });
    });
}

function tagHeadImage(job, cb) {
    var parsedUrl = urlModule.parse(dockerUrl);
    var dockerAdminiUrl = parsedUrl.protocol + '//' + parsedUrl.hostname;
    var dockerAdmin = restify.createJsonClient({ url: dockerAdminiUrl });

    var imgId = job.params.data.askedImg;
    var data = {
        docker_id: imgId,
        tag: job.params.parsed.tag
    };

    dockerAdmin.get({
        path: '/admin/image_tags',
        query: data
    }, function (err, req, res, tags) {
        if (err) {
            cb(err);
            return;
        } else if (tags.length) {
            cb();
            return;
        }

        data.name = job.params.parsed.name;
        data.owner_uuid = job.params.data.images[imgId].owner;
        data.repo = job.params.parsed.repo;

        dockerAdmin.post('/admin/image_tags', data, function (createErr) {
            if (createErr) {
                cb(createErr);
                return;
            }
            cb();
        });
    });
}


var workflow = module.exports = {
    name: 'pull-image-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'get_image_metadata',
        timeout: 20,
        retry: 1,
        body: getImageMetadata,
        modules: { dockerRegistry: 'docker-registry-client', vasync: 'vasync' }
    }, {
        name: 'pull_image_layers',
        timeout: 3600,
        retry: 1,
        body: pullImageLayers,
        modules: {
            dockerRegistry: 'docker-registry-client',
            imgmanifest: 'imgmanifest',
            restify: 'restify',
            sdcClients: 'sdc-clients',
            urlModule: 'url',
            vasync: 'vasync'
        }
    }, {
        name: 'tag_head_image',
        timeout: 20,
        retry: 1,
        body: tagHeadImage,
        modules: {
            restify: 'restify',
            urlModule: 'url'
        }
    }],
    timeout: 3600,
    onerror: [ {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
