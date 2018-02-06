/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var restify = require('restify');
var sdcClients = require('sdc-clients');
var vasync = require('vasync');

var LineStream;
var urlModule;
var imgapiUrl;
var dockerUrl;

var VERSION = '1.0.0';

function pushImageLayers(job, cb) {
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
        } else {
            dockerAdmin.post('/admin/progress', data, next);
        }
    }

    imgapi.adminPushDockerImage(job.params, function (err, res) {
        if (err) {
            job.log.info('adminImportDockerImage error %s', err);
            cb(err);
            return;
        }

        var lstream = new LineStream({ encoding: 'utf8' });

        lstream.on('error', function (lerr) {
            job.log.info('LineStream threw an error %s', lerr);
            cb(lerr);
        });

        lstream.on('readable', function _onReadable() {
            var line = lstream.read();
            while (line !== null) {
                queue.push(JSON.parse(line));
                line = lstream.read();
            }
        });

        res.on('end', function onEnd() {
            job.log.trace('pushImageLayers res.end received');
            queue.close();

            // Wait for queue to finish before ending the task
            queue.on('end', function () {
                job.log.trace('pushImageLayers queue.end received');
                if (queueError) {
                    cb(queueError);
                } else {
                    cb(null, 'pushImageLayers completed');
                }
            });
        });

        res.pipe(lstream);
    });
}

var workflow = module.exports = {
    name: 'push-image-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'push_image_layers',
        timeout: 3600,
        retry: 1,
        body: pushImageLayers,
        modules: {
            assert: 'assert-plus',
            LineStream: 'lstream',
            restify: 'restify',
            sdcClients: 'sdc-clients',
            urlModule: 'url',
            vasync: 'vasync'
        }
    }],
    timeout: 3620,
    onerror: [ {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            job.log.warn('Error handling job %s', job.params.req_id);
            return cb('Error executing job');
        }
    }]
};
