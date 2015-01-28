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

var VERSION = '1.2.0';

function pullImageLayers(job, cb) {
    job.log.info('Pulling dependent layers for %s %s',
        job.params.parsed.name, job.params.parsed.tag);
    var queue = vasync.queue(processMessage, 5);

    // For now assume dockerUrl is the URL to the DOCKER_HOST. In this case
    // we parse the URL to obtain the location of the admin host
    var parsedUrl = urlModule.parse(dockerUrl);
    var dockerAdminiUrl = parsedUrl.protocol + '//' + parsedUrl.hostname;
    var dockerAdmin = restify.createJsonClient({ url: dockerAdminiUrl });
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});

    var virtualSize = 0;

    function processMessage(data, next) {
        job.log.info('processMessage');
        if (data.type === 'data') {
            createDockerImage(data, next);
        } else if (data.type === 'head') {
            job.params.head = data.head;
            next();
        } else {
            writeProgress(data, next);
        }
    }

    // progress messages can be status or progress messages
    function writeProgress(progress, next) {
        if (progress.type == 'progress'
            && progress.payload && !progress.payload.progressDetail) {
            progress.payload.progressDetail = {};
        }

        dockerAdmin.post('/admin/progress', progress, next);
    }

    function createDockerImage(data, next) {
        job.log.info('createDockerImage');

        var imgJson = data.imgJson;
        var imgId = imgJson.id;

        var size = imgJson.Size || 0;
        virtualSize += size;

        var layer = {
            created: new Date(imgJson.created).getTime(),
            docker_id: imgId,
            owner_uuid: data.image.owner,
            size: size,
            virtual_size: virtualSize
        };

        if (imgJson.container_config) {
            layer.container_config = imgJson.container_config;
        }
        if (imgJson.config) {
            layer.config = imgJson.config;
        }
        if (imgJson.parent) {
            layer.parent = imgJson.parent;
        }
        if (job.params.head === imgId) {
            job.log.info('parent found %s', imgId);
            layer.head = true;
            job.params.headOwner = layer.owner;
        }

        var query = {
            owner_uuid: layer.owner,
            docker_id: imgId
        };

        dockerAdmin.get({
            path: '/admin/images',
            query: query
        }, function (err, req, res, images) {
            if (err) {
                next(err);
                return;
            } else if (images.length) {
                next();
                return;
            }

            dockerAdmin.post('/admin/images', layer, next);
        });
    }

    var opts = {
        repo: job.params.parsed.repo,
        tag: job.params.askedTag,
        skipOwnerCheck: true,
        headers: { 'x-request-id': job.params.req_id }
    };

    job.log.info('before adminImportDockerImage');

    imgapi.adminImportDockerImage(opts, function (connectErr, res) {
        job.log.info('adminImportDockerImage');
        if (connectErr) {
            job.log.info('adminImportDockerImage error %s', connectErr);
            cb(connectErr);
            return;
        }
        job.log.info('adminImportDockerImage no error');
        res.on('data', onData);
        res.on('end', onEnd);

        function onData(chunk) {
            job.log.info('data chunk %s', chunk.toString());
            var data = JSON.parse(chunk.toString());
            queue.push(data);
        }

        function onEnd() {
            job.log.info('onEnd');
            queue.close();

            // Wait for queue to finish before ending the task
            queue.on('end', function () {
                cb(null, 'pullImageLayers completed');
            });
        }
    });
}

function tagHeadImage(job, cb) {
    var parsedUrl = urlModule.parse(dockerUrl);
    var dockerAdminiUrl = parsedUrl.protocol + '//' + parsedUrl.hostname;
    var dockerAdmin = restify.createJsonClient({ url: dockerAdminiUrl });

    var imgId = job.params.head;
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
            job.log.info('got tags %j', tags);
            job.log.info('query %j', data);
            cb();
            return;
        }

        data.name = job.params.parsed.name;
        data.owner_uuid = job.params.headOwner;
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
        timeout: 60,
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
    timeout: 60,
    onerror: [ {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
