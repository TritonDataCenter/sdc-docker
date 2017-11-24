/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
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

var VERSION = '1.0.0';

function pullImageLayersV2(job, cb) {
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
    var imageCreated = false;
    var imgapi = new sdcClients.IMGAPI({url: imgapiUrl});

    function processMessage(data, next) {
        if (data.type == 'error') {
            /*
             * Currently WFAPI will add `err.message` and `err.name` to the
             * chain_results. We'll slip our error *code* in using `err.name`.
             */
            queueError = new Error(data.error.message);
            if (data.error.code) {
                queueError.name = data.error.code;
            }
            next();
        } else if (data.type === 'create-docker-image') {
            createDockerImage(data, next);
        } else {
            // type 'progress' or 'status'
            if (data.type == 'progress'
                && data.payload && !data.payload.progressDetail) {
                data.payload.progressDetail = {};
            }
            dockerAdmin.post('/admin/progress', data, next);
        }
    }

    function createDockerImage(data, next) {
        assert.string(data.config_digest, 'data.config_digest');

        job.log.info('createDockerImage:: data: %s', JSON.stringify(data));

        var query = {
            owner_uuid: job.params.account_uuid,
            config_digest: data.config_digest
        };
        // Remeber the digest for tagging.
        job.params.config_digest = data.config_digest;

        dockerAdmin.get({
            path: '/admin/images_v2',
            query: query
        }, function (err, req, res, images) {
            if (err) {
                next(err);
                return;
            }

            if (images && images.length > 0) {
                // Image with this digest already exists - no need to update, if
                // they have the same digest then they have the same content.
                job.log.debug({config_digest: data.config_digest},
                    'createDockerImage:: image already exists');
                imageCreated = true;
                next();
                return;
            }

            var path = '/admin/images_v2?action=create';
            data.owner_uuid = job.params.account_uuid;
            dockerAdmin.post(path, data, function (adminErr) {
                if (adminErr) {
                    queueError = adminErr;
                    job.log.error({config_digest: data.config_digest},
                        'createDockerImage:: error: %s', adminErr);
                } else {
                    imageCreated = true;
                    job.log.debug({config_digest: data.config_digest},
                        'createDockerImage:: image created');
                }
                next(err);
            });
        });
    }

    var opts = {
        repo: job.params.rat.canonicalName,
        tag: job.params.rat.tag,
        digest: job.params.rat.digest,
        regAuth: job.params.regAuth,
        regConfig: job.params.regConfig,
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

        lstream.on('readable', function () {
            var line;
            while ((line = lstream.read()) !== null) {
                queue.push(JSON.parse(line));
            }
        });

        res.on('end', function onEnd() {
            queue.close();

            // Wait for queue to finish before ending the task
            queue.on('end', function () {
                if (queueError) {
                    cb(queueError);
                } else if (!imageCreated) {
                    // If there was no error, yet there was no image created,
                    // then there must have been a timeout (i.e. connection was
                    // closed abruptly), so fire the callback with an error.
                    cb(new Error('pullImageLayers failed - '
                        + 'no successful create-docker-image'));
                } else {
                    cb(null, 'pullImageLayers completed');
                }
            });
        });

        res.pipe(lstream);
    });
}

function tagImageV2(job, cb) {
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
        repo: job.params.rat.localName,
        tag: job.params.rat.tag,
        config_digest: job.params.config_digest
    };

    dockerAdmin.post('/admin/image_tags_v2', data, function (createErr) {
        if (createErr) {
            cb(createErr);
            return;
        }

        cb(null, 'Head image has been tagged');
    });
}


var workflow = module.exports = {
    name: 'pull-image-v2-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'pull_image_v2_layers',
        timeout: 3600,
        retry: 1,
        body: pullImageLayersV2,
        modules: {
            assert: 'assert-plus',
            LineStream: 'lstream',
            restify: 'restify',
            sdcClients: 'sdc-clients',
            urlModule: 'url',
            vasync: 'vasync'
        }
    }, {
        name: 'tag_image_v2',
        timeout: 20,
        retry: 1,
        body: tagImageV2,
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
