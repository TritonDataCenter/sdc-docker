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
var dockerRegistry = require('docker-registry-client');
var dockerUrl;

var VERSION = '1.0.0';


function getImageMetadata(job, cb) {
    var session;
    // Initialize the job data that is going to be used by each
    // subsequent task
    job.params.data = { size: {} };

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

            job.params.data.ancestry = ancestry;
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
    var dockerApi = restify.createJsonClient({ url: dockerUrl });

    function writeProgress(progress, next) {
        progress.id = progress.id.substr(0, 12);

        if (!progress.progressDetail) {
            progress.progressDetail = {};
        }
        var data = {
            id: job.params.parsed.repo,
            payload: progress
        };

        dockerApi.post('/progress', data, function (err, req, res) {
            if (err) {
                job.log.info(err, 'Could not post progress');
                next(err);
            } else {
                job.log.info('Posted progress for %j', data);
                next();
            }
        });
    }

    function getImgJson(imgId, next) {
        session.getImgJson({
            imgId: imgId
        }, function (err, imgJson, getRes) {
            if (err) {
                next(err);
                return;
            }

            job.params.data.size[imgId] =
                Number(getRes.headers['x-docker-size']);
            next();
        });
    }

    function pullFsLayer(imgId, next) {
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
            var total = job.params.data.size[imgId];

            job.log.info('updateEvery %s', updateEvery);

            var shortId = imgId.slice(0, 12);
            var currentBytes = 0;
            var startTs = Math.floor(new Date().getTime() / 1000);

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
                next();
            });

            stream.on('data', function (chunk) {
                currentBytes += chunk.length;
                if (shortId == '01bf15a18638') {
                    job.log.info('currentBytes %s', currentBytes);
                    job.log.info('lastUpdate %s', lastUpdate);
                    job.log.info('resta %s', (currentBytes - lastUpdate));
                }
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

            stream.on('error', function (streamErr) {
                next(streamErr);
            });

            stream.resume();
        });
    }

    function pullOneLayer(imgId, next) {
        queue.push({
            id: imgId,
            status: 'Pulling metadata.'
        });

        vasync.pipeline({
            funcs: [
                getImgJson,
                pullFsLayer
            ],
            arg: imgId
        }, function (err, results) {
            if (err) {
                next(err);
                return;
            }

            queue.push({
                id: imgId,
                status: 'Download complete.'
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
        vasync.forEachParallel({
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
            restify: 'restify',
            vasync: 'vasync'
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
