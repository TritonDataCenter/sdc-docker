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

var VERSION = '1.1.0';

function pullImageLayers(job, cb) {
    job.log.info('Pulling dependent layers for %s', job.params.data.askedImg);
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

    function createImgapiImage(arg, next) {
        if (arg.exists || arg.unactivated) {
            next();
            return;
        }

        var imgId = arg.imgId;
        var opts = {
            imgId: imgId,
            repo: job.params.parsed.repo,
            skipOwnerCheck: true,
            uuid: imgmanifest.imgUuidFromDockerId(imgId),
            headers: { 'x-request-id': job.params.req_id }
        };

        imgapi.adminImportDockerImage(opts, function (impErr, img, res) {
            if (impErr) {
                next(impErr);
                return;
            }

            // TODO how to properly return this from IMGAPI?
            var imgJson = img.dockerImgJson;
            arg.imgJson = imgJson;

            var fileSize = Number(res.headers['x-docker-size']);
            var size = imgJson.Size || 0;
            job.params.data.fileSizes[imgId] = fileSize;
            job.params.data.virtual_size += size;

            job.params.data.images[imgId] = {
                size: size,
                created: new Date(imgJson.created).getTime(),
                virtual_size: job.params.data.virtual_size
            };

            if (imgJson.container_config) {
                job.params.data.images[imgId].container_config =
                    imgJson.container_config;
            }
            if (imgJson.config) {
                job.params.data.images[imgId].config = imgJson.config;
            }

            job.params.data.images[imgId].owner = img.owner;

            next();
        });
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
            data.virtual_size = job.params.data.images[imgId].virtual_size;
            data.config = job.params.data.images[imgId].config;
            data.container_config =
                job.params.data.images[imgId].container_config;

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
                createImgapiImage,
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

    queue.push({
        id: job.params.data.askedImg,
        status: 'Pulling dependent layers'
    });

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
