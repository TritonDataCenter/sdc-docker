/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var assert = require('assert-plus');
var restify = require('restify');
var sdcClients = require('sdc-clients');
var vasync = require('vasync');

var LineStream;
var urlModule;
var imgapiUrl;
var dockerUrl;

var VERSION = '1.4.3';

function pullImageLayers(job, cb) {
    var queue = vasync.queue(processMessage, 5);
    var queueError;

    // For now assume dockerUrl is the URL to the DOCKER_HOST. In this case
    // we parse the URL to obtain the location of the admin host
    var parsedUrl = urlModule.parse(dockerUrl);
    var dockerAdminiUrl = parsedUrl.protocol + '//' + parsedUrl.hostname;
    var dockerAdmin = restify.createJsonClient({
        url: dockerAdminiUrl,
        headers: { 'x-request-id': job.params.req_id }
    });
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});

    var virtualSize = 0;

    function processMessage(data, next) {
        if (data.type == 'error') {
            queueError = new Error(data.error.message);
            next();
        } else if (data.type === 'data') {
            createDockerImage(data, next);
        } else if (data.type === 'head') {
            job.params.head = data.head;
            next();
        } else {
            // type 'progress' or 'status'
            if (data.type == 'progress'
                && data.payload && !data.payload.progressDetail) {
                data.payload.progressDetail = {};
            }
            dockerAdmin.post('/admin/progress', data, next);
        }
    }

    // Inside this function we verify if the layer was already refcounted
    // by this head image before. The idea is that we want to track how
    // many head images are have a reference to this layer and when there
    // are no more references to it we can safely remove it from the bucket
    // when `docker rmi` is called
    function createDockerImage(data, next) {
        assert.object(data.imgJson, 'data.imgJson');
        assert.object(data.image, 'data.image');
        assert.bool(data.private, 'data.private');

        var imgJson = data.imgJson;
        var imgId = imgJson.id;

        var size = imgJson.Size || 0;
        virtualSize += size;

        var query = {
            owner_uuid: job.params.account_uuid,
            index_name: job.params.rat.index.name,
            docker_id: imgId
        };

        dockerAdmin.get({
            path: '/admin/images',
            query: query
        }, function (err, req, res, images) {
            if (err) {
                next(err);
                return;
            }

            var action;
            var heads;

            if (images.length) {
                // Layer already exists:
                // 1) check if this pull is already refcounted and return
                // 2) update the refcount for this image
                var image = images[0];
                if (image.heads.indexOf(job.params.head) !== -1) {
                    next();
                    return;
                }

                action = 'update';
                image.heads.push(job.params.head);
                heads = image.heads;
            } else {
                action = 'create';
                heads = [ job.params.head ];
            }

            var layer = {
                created: new Date(imgJson.created).getTime(),
                docker_id: imgId,
                heads: heads,
                image_uuid: data.image.uuid,
                index_name: job.params.rat.index.name,
                owner_uuid: job.params.account_uuid,
                size: size,
                virtual_size: virtualSize,
                private: data.private
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
                layer.head = true;
            }

            var path = '/admin/images?action=' + action;
            dockerAdmin.post(path, layer, next);
        });
    }

    var opts = {
        repo: job.params.rat.canonicalName,
        tag: job.params.rat.tag,
        digest: job.params.rat.digest,
        regAuth: job.params.regAuth,
        /*
         * All sdc-docker pull images are owned by and private to 'admin'.
         * It is sdc-docker code that gates access to all the images.
         */
        public: false,
        headers: { 'x-request-id': job.params.req_id }
    };

    imgapi.adminImportDockerImage(opts, function (connectErr, res) {
        if (connectErr) {
            job.log.info('adminImportDockerImage error %s', connectErr);
            cb(connectErr);
            return;
        }

        var lstream = new LineStream({ encoding: 'utf8' });

        lstream.on('error', function (lerr) {
            job.log.info('LineStream threw an error %s', lerr);
            cb(lerr);
        });

        lstream.on('line', function (line) {
            line = line.trim();
            if (!line) {
                return;
            }

            var data = JSON.parse(line);
            queue.push(data);
        });

        res.on('end', function onEnd() {
            queue.close();

            // Wait for queue to finish before ending the task
            queue.on('end', function () {
                if (queueError) {
                    cb(queueError);
                } else {
                    cb(null, 'pullImageLayers completed');
                }
            });
        });

        res.pipe(lstream);
    });
}

function tagHeadImage(job, cb) {
    // TODO(DOCKER-584): handle digest when supporting that.
    if (!job.params.rat.tag) {
        cb(null, 'No tag for head image');
        return;
    }

    var parsedUrl = urlModule.parse(dockerUrl);
    var dockerAdminUrl = parsedUrl.protocol + '//' + parsedUrl.hostname;
    var dockerAdmin = restify.createJsonClient({
        url: dockerAdminUrl,
        headers: { 'x-request-id': job.params.req_id }
    });

    var data = {
        owner_uuid: job.params.account_uuid,
        index_name: job.params.rat.index.name,
        repo: job.params.rat.localName,
        tag: job.params.rat.tag,
        docker_id: job.params.head
    };

    dockerAdmin.post('/admin/image_tags', data, function (createErr) {
        if (createErr) {
            cb(createErr);
            return;
        }

        cb(null, 'Head image has been tagged');
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
            assert: 'assert-plus',
            LineStream: 'lstream',
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
    timeout: 3620,
    onerror: [ {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
