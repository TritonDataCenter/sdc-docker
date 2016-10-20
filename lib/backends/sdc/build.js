/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 *
 * Overview: Build an image, given a build context (tarball).
 */

var format = require('util').format;
var net = require('net');
var stream = require('stream');

var assert = require('assert-plus');
var drc = require('docker-registry-client');
var LineStream = require('lstream');
var once = require('once');
var vasync = require('vasync');

var common = require('../../common');
var errors = require('../../../lib/errors');
var images = require('./images');
var utils = require('./utils');



//---- globals


/**
 * Return an image object in the docker inspect format.
 */
function getImageInInspectFormat(dockerId, opts, callback) {
    assert.string(dockerId, 'dockerId');
    assert.object(opts, 'opts');
    assert.string(opts.index_name, 'opts.index_name');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.req, 'opts.req');
    assert.string(opts.req_id, 'opts.req_id');

    var inspectOpts = {
        account: opts.req.account,
        app: opts.req.app,
        index_name: opts.index_name,
        log: opts.log,
        name: dockerId,
        req_id: opts.req_id
    };
    opts.req.backend.inspectImage(inspectOpts, callback);
}

/**
 * Build an image, given build params and a build context (tarball).
 *
 * @param {Object} opts
 * @param {Object} opts.dockerOpts The build params passed by docker client.
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.req Request instance.
 * @param {UUID} opts.req_id
 * @param callback {Function} `function (err, images)`
 */
function buildImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.dockerOpts, 'opts.dockerOpts');
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.rat, 'opts.rat');
    assert.object(opts.req, 'opts.req');
    assert.object(opts.res, 'opts.res');
    assert.string(opts.req_id, 'opts.req_id');

    var allDockerImages = [];
    var baseImageId = null;         // Base image id our build is based on.
    var baseImageIndexName = null;  // Base index_name our build is based on.
    var buildFinishedSuccessfully = false;
    var dockerOpts = opts.dockerOpts;
    var finalImageId = null;  // Final docker image id for resulting image.
    var log = opts.log;
    var previousErr;
    var rat = opts.rat;
    var req = opts.req;
    var req_id = opts.req_id;
    var res = opts.res;
    var scratchImage;
    var socketOpts;
    var vm;
    var vmDockerId;
    var vmUuid;

    // There is the potential to run the callback twice, so make sure that never
    // happens.
    callback = once(callback);

    vasync.pipeline({ funcs: [
        buildGetScratchImage,
        buildGetAllDockerImages,
        buildCreateContainer,
        buildGetVmObject,
        buildCnapiDockerBuild,
        buildSendContext,
        buildFromContext
    ]}, buildCleanup);


    function buildGetScratchImage(_, cb) {
        req.app.backend.getScratchImage(req,
        function _getScratchImageCb(err, img) {
            if (err) {
                log.error(err, 'getScratchImage failure');
                cb(err);
                return;
            }
            scratchImage = img;
            log.debug('scratchImage: ', scratchImage);
            cb();
        });
    }


    function buildGetAllDockerImages(_, cb) {
        // If nocache is specified, there is no need to lookup all images, as
        // this list of images is *only* used for build caching.
        if (dockerOpts.nocache) {
            cb();
            return;
        }
        var listOpts = {
            account: req.account,
            all: true,
            app: req.app,
            clientApiVersion: req.clientApiVersion,
            log: log,
            req_id: req_id,
            skip_smartos: true
        };
        req.backend.listImages(listOpts, function _listImagesCb(err, imgs) {
            if (err) {
                cb(err);
                return;
            }
            // Convert an img into the docker inspect format.
            function getImageDetails(img, next) {
                var inspectOpts = {
                    index_name: img.IndexName,
                    log: log,
                    req: req,
                    req_id: req_id
                };
                getImageInInspectFormat(img.Id, inspectOpts, next);
            }
            vasync.forEachPipeline({
                'func': getImageDetails,
                'inputs': imgs
            }, function _getImageDetailsCb(err2, results) {
                allDockerImages = results.successes;
                cb(err2);
            });
        });
    }


    function buildCreateContainer(_, cb) {
        var createOpts = {
            account: req.account,
            app: req.app,
            clientApiVersion: req.clientApiVersion,
            fabricRequireExternal: true,  // use external network
            image: scratchImage,
            log: log,
            name: 'build_' + req_id,
            payload: {
                HostConfig: {
                    Memory: dockerOpts.memory
                },
                Cmd: [ '# nop (build setup)' ]
            },
            req_id: req_id
        };

        req.backend.createContainer(createOpts,
        function _createContainerCb(err, result) {
            if (err) {
                log.error(err, 'error calling createContainer');
                cb(err);
                return;
            }
            vmDockerId = result.DockerId;
            vmUuid = common.dockerIdToUuid(result.DockerId);
            log.debug('buildImage: created build container:', vmUuid);
            cb();
        });
    }


    function buildGetVmObject(_, cb) {
        var getVmOpts = {
            log: log,
            owner_uuid : req.account.uuid,
            req_id: req_id,
            vmapi: req.app.vmapi
        };
        common.getVmByUuid(vmUuid, getVmOpts,
        function _getVmByUuidCb(err, vmobj) {
            if (err) {
                cb(new errors.DockerError(err,
                    'problem retrieving build container'));
                return;
            }

            vm = vmobj;
            cb();
        });
    }


    function buildCnapiDockerBuild(_, cb) {
        var cnapi = req.app.cnapi;
        var cnapiBuildPayload = common.objCopy(dockerOpts);
        var cnapiBuildOpts = {
            headers: {
                'x-request-id': req_id,
                // Add the docker registry headers.
                'x-registry-config': req.headers['x-registry-config'],
                'x-registry-auth': req.headers['x-registry-auth']
            }
        };

        cnapiBuildPayload.account_uuid = req.account.uuid;
        cnapiBuildPayload.command = 'build';  // Command type.
        cnapiBuildPayload.imgapi_url = req.app.config.imgapi.url;
        cnapiBuildPayload.allDockerImages = allDockerImages;

        /* CNAPI, go build for us. */
        cnapi.dockerBuild(vm.server_uuid, vmUuid,
            { payload: cnapiBuildPayload },
            cnapiBuildOpts,
            function _dockerBuildCb(err, result) {
                if (err) {
                    log.error(err, 'error calling cnapi.dockerBuild');
                    cb(errors.cnapiErrorWrap(
                        err, 'problem calling docker build'));
                    return;
                }

                socketOpts = result;
                cb();
            });
    }


    function buildSendContext(_, cb) {
        var host = socketOpts.host;
        var port = socketOpts.port;
        var cbCalled = false;

        var contextSocket = net.createConnection({ host:host, port:port });

        log.debug('build server running on host: ', host, 'port: ', port);

        contextSocket.on('connect', function _contextSocketConnectCb() {
            log.debug('build: context socket connected - piping context');
            req.pipe(contextSocket);
        });

        contextSocket.on('close', function _contextSocketCloseCb() {
            log.debug('build: contextSocket.close - starting build');
            if (!cbCalled) {
                cbCalled = true;
                cb();
            }
        });

        req.on('end', function _reqEndListener() {
            log.debug('build: req.end');
            res.socket.removeListener('end', respEndListener);
            if (!cbCalled) {
                cbCalled = true;
                cb();
            }
        });

        var respEndListener = function _respEndListenerCb() {
            log.debug('build got client res.end');
            // TODO: Cleanup if early close.
            // contextSocket.destroy();
        };
        res.socket.on('end', respEndListener);
    }


    function buildFromContext(_, cb) {
        var buildError;
        var buildEventStream;
        var host = socketOpts.host;
        var port = socketOpts.port;

        // There is the potential to call cb twice, make sure it never happens.
        cb = once(cb);

        log.debug('build: creating second connection to cnapi');
        var buildSocket = net.createConnection({ host: host, port: port });
        buildSocket.setTimeout(60 * 60 * 1000);  // 60 minutes

        var sendEventResponse = function (event, err, result) {
            var response = {
                messageId: event.messageId,
                type: 'callback'
            };
            if (err) {
                recordError(err, event.type + ' error');
                response.error = err.message;
            }
            if (typeof (result) !== 'undefined') {
                response['result'] = result;
            }
            log.debug('response:', response);
            buildSocket.write(JSON.stringify(response) + '\n');
        };

        buildSocket.on('connect', function _buildSocketConnectCb() {
            log.debug('build: cnapi build socket connected');
            // Don't need to do anything, the CNAPI build will send events.
        });

        buildEventStream = new LineStream();
        buildSocket.pipe(buildEventStream);
        buildEventStream.on('line', function _buildLineCb(event) {
            log.debug('build: got build event:', String(event));
            try {
                event = JSON.parse(event);
            } catch (e) {
                log.error('Build: invalid json: %s - ignoring', event);
                return;
            }
            switch (event.type) {
                case 'end':
                    if (event.error) {
                        // Will be passed to callback `cb`.
                        buildError = new Error(event.error);
                    }
                    break;
                case 'message':
                    log.info('Build message: %s', event.message);
                    break;
                case 'stdout':
                    log.debug('Build stdout: %s', event.message);
                    res.write(JSON.stringify({
                        'stream': event.message
                    }) + '\n');
                    break;
                case 'image_reprovision':
                    assert.string(event.cmdName, 'event.cmdName');
                    assert.string(event.imageName, 'event.imageName');
                    pullAndReprovisionImage(
                    {
                        imageName: event.imageName,
                        log: log,
                        rat: rat,
                        req: req,
                        req_id: req_id,
                        res: res,
                        vm: vm
                    }, function _pullReprovCb(err, result) {
                        // Note: result.image is in docker inspect format.
                        if (!err) {
                            baseImageId = result.image.Id;
                            baseImageIndexName = result.index_name;
                            log.debug('reprovisioned to baseImageId: %j',
                                baseImageId);
                        }
                        sendEventResponse(event, err, result);
                    });
                    break;
                case 'image_create':
                    createImage(event.payload, { rat: rat, req: req },
                        function _imageCreateCb(err, result)
                    {
                        sendEventResponse(event, err, result);
                    });
                    break;
                case 'run':
                    runBuildCommand(
                    {
                        dockerId: vmDockerId,
                        log: log,
                        req: req,
                        req_id: req_id,
                        res: res,
                        vm: vm
                    }, function _runCommandCb(err, result) {
                        sendEventResponse(event, err, result);
                    });
                    break;
                case 'build_finished':
                    finalImageId = event.finalId;
                    vasync.pipeline({ funcs: [
                        function _doAddBaseImageHead(_result, next) {
                            addBaseImageHead(baseImageId, finalImageId,
                            {
                                baseImageIndexName: baseImageIndexName,
                                req: req,
                                scratchImage: scratchImage
                            }, next);
                        },
                        function _doTagImage(_result, next) {
                            tagImage({
                                    docker_id: finalImageId,
                                    name: dockerOpts.tag,
                                    req: req
                                }, next);
                        }
                    ]}, function buildFinishPipeCb(err) {
                        if (!err) {
                            buildFinishedSuccessfully = true;
                        }
                        sendEventResponse(event, err);
                    });
                    break;
                default:
                    log.error('Unhandled build event: %j', event);
                    break;
            }
        });
        buildEventStream.on('close', function _eventStreamCloseCb() {
            log.debug('build: buildEventStream.close - closing socket');
        });
        buildSocket.on('end', function _buildSocketEndCb() {
            log.debug('build: buildSocket.end', buildError);
            cb(buildError);
        });
        buildSocket.on('error', function _buildSocketErrorCb(socketErr) {
            log.error('build: cnapi build socket error: %s', socketErr);
            cb(new Error('Build socket error: %s', socketErr));
        });
        buildSocket.on('timeout', function _buildSocketTimeoutCb() {
            log.error('build: cnapi build socket has timed out');
            buildSocket.destroy();
            cb(new Error('Build operation has timed out'));
        });

        res.socket.on('end', function _resSocketEndCb() {
            log.debug('build got client res.end');
            // TODO: Cleanup if early close.
            // buildSocket.destroy();
        });
    }


    function buildCleanup(err, results) {
        log.debug('build: final callback, err: %j', err);
        cleanup(err || previousErr, function buildCleanupCb(cleanuperr) {
            if (err) {
                callback(err);
                return;
            }
            if (previousErr) {
                // Error occurred during a previous cn-agent task.
                callback(previousErr);
                return;
            }
            if (!buildFinishedSuccessfully) {
                // Something went wrong, but weren't told what it was.
                callback(new errors.DockerError('Unexpected error'));
                return;
            } else {
                // Send the successfully built image message.
                res.write(JSON.stringify({
                    'stream': format('Successfully built %s\n',
                        finalImageId.substr(0, 12))
                }) + '\n');
            }
            callback(cleanuperr);
        });
    }


    function recordError(err, logMessage) {
        log.error(err, logMessage);
        if (!previousErr) {
            previousErr = err;
        }
    }


    function cleanup(err, cb) {
        if (vmUuid) {
            // Cleanup according to the user's cleanup rules.
            if ((!err && dockerOpts.rm) || (err && dockerOpts.forcerm)) {
                // Ensure the vm is deleted.
                log.debug('Removing the build container');
                deleteVm(vmUuid, function (deleteErr) {
                    if (deleteErr) {
                        // Tell client we had a problem deleting the container.
                        res.write(JSON.stringify({
                            'stream': 'Error deleting container: ' + err.message
                        }) + '\n');
                    }
                    // Note that 'err' is deliberately ignored here, as 'err' is
                    // being handled in the buildCleanup function.
                    cb(deleteErr);
                    return;
                });
                return;
            }
        }
        cb();
    }


    function deleteVm(uuid, cb) {
        var vmapi = req.app.vmapi;
        var deleteHeaders = { headers: { 'x-request-id': req_id } };
        var deleteParams = {
            owner_uuid: req.account.uuid,
            sync: true,
            uuid: uuid
        };
        log.debug('Deleting container ' + uuid);
        vmapi.deleteVm(deleteParams, deleteHeaders,
        function _deleteVmCb(deleteErr, job) {
            if (deleteErr) {
                log.error(deleteErr, 'Error deleting container.');
                return cb(errors.vmapiErrorWrap(
                        deleteErr, 'problem deleting container'));
            }

            log.debug('Deletion was successful');
            cb();
        });
    }
}


function pullImage(opts, callback) {
    var imageName = opts.imageName;
    var log = opts.log;
    var req = opts.req;
    var res = opts.res;

    log.debug('pullImage');

    // 1. Parse the image name.
    // 2. Pull the image if it's not already downloaded.
    // 2a. Stream pull messages back to client.

    try {
        var rat = drc.parseRepoAndTag(imageName);
    } catch (e) {
        callback(e);
        return;
    }

    var imageOpts = {
        app: req.app,
        log: log,
        account: req.account,
        index_name: rat.index.name,
        name: imageName,
        includeSmartos: false
    };
    req.backend.imgFromName(imageOpts, function (err, image) {
        if (err) {
            callback(err);
            return;
        }
        if (image) {
            callback(null, image);
            return;
        }

        // Pipe pull stream back to the client.
        var pullStream = new stream.Transform();
        pullStream.headersSent = true; // Fake it so it looks like a real res.
        pullStream._headerSent = true; // Fake it so it looks like a real res.
        pullStream._transform = function (chunk, encoding, done) {
            res.write(chunk);
            done();
        };
        // Try and pull the image.
        req.backend.pullImage({
            app: req.app,
            log: log,
            rat: rat,
            req: req,
            req_id: opts.req_id,
            res: pullStream,
            wfapi: req.wfapi,
            account: req.account
        }, function (perr) {
            // Cleanup the socket used.
            req.app.sockets.removeSocket('job', rat.canonicalName);
            if (perr) {
                callback(perr);
                return;
            }
            // Try again to lookup the image.
            req.backend.imgFromName(imageOpts, callback);
        });
    });
}


function reprovisionFromImageUuid(image_uuid, opts, callback) {
    var req = opts.req;
    var vm = opts.vm;
    var vmapi = req.app.vmapi;

    vmapi.reprovisionVm({
        image_uuid: image_uuid,
        owner_uuid: req.account.uuid,
        sync: true,
        uuid: vm.uuid
    }, {headers: {'x-request-id': opts.req_id}}, function (err, result) {
        if (err) {
            callback(errors.vmapiErrorWrap(err, 'problem creating container'));
            return;
        }
        callback();
    });
}


/**
 * Ensure the given image exists (by trying to pull it down) and then
 * reprovision the container with that image.
 */
function pullAndReprovisionImage(opts, callback) {
    pullImage(opts, function pullImage_callback(err, image) {
        // Note: image is in the imgapi format.
        if (err) {
            callback(err);
            return;
        }
        // Warning: pullImage can return a null image, which means an error
        // occurred (e.g. the requested image was not found).
        if (!image) {
            callback(new errors.DockerError(
                'could not pull image: ' + opts.imageName));
            return;
        }

        // DOCKER-748: Ensure the tag and the base image are from the same repo.
        var index_name = opts.rat && opts.rat.index.name || 'docker.io';
        if (index_name !== image.index_name) {
            opts.log.warn('Build failure - using different registries: %s, %s',
                index_name, image.index_name);
            callback(new errors.DockerError(format(
                'Cannot build an image that references different registries '
                + '(%s, %s)', index_name, image.index_name)));
            return;
        }

        reprovisionFromImageUuid(image.image_uuid, opts, function (rerr) {
            if (rerr) {
                callback(rerr);
                return;
            }
            var dockerId = image.docker_id;
            opts.index_name = image.index_name;
            getImageInInspectFormat(dockerId, opts, function (ierr, iimg) {
                if (ierr) {
                    callback(ierr);
                    return;
                }
                callback(null, { image: iimg, index_name: image.index_name });
            });
        });
    });
}


/**
 * Creates a new image (in both imgapi and sdc-docker).
 */
function createImage(payload, opts, callback) {
    assert.object(payload, 'payload');
    assert.string(payload.finalId, 'payload.finalId');
    assert.object(payload.image, 'payload.image');
    assert.finite(payload.size, 'payload.size');
    assert.optionalNumber(payload.virtual_size, 'payload.virtual_size');
    assert.object(opts, 'opts');
    assert.optionalObject(opts.rat, 'opts.rat');
    assert.object(opts.req, 'opts.req');

    var rat = opts.rat;
    var req = opts.req;
    var createOpts = {
        payload: {
            head: (payload.finalId === payload.image.id),
            heads: [payload.finalId],
            image: payload.image,
            size: payload.size,
            virtual_size: payload.virtual_size
        },
        rat: rat,
        req: req
    };

    req.log.debug(format('Creating image %j', createOpts.payload));
    req.backend.createImage(createOpts, callback);
}


/**
 * Update all parent images of finalImageId to include a head reference to
 * finalImageId (for sdc-docker image model).
 */
function addBaseImageHead(baseImageId, finalImageId, opts, callback) {
    assert.string(finalImageId, 'finalImageId');
    assert.object(opts, 'opts');
    assert.object(opts.req, 'opts.req');
    assert.object(opts.scratchImage, 'opts.scratchImage');

    if (!baseImageId || (baseImageId === opts.scratchImage.id)) {
        callback();
        return;
    }

    assert.string(baseImageId, 'baseImageId');
    assert.string(opts.baseImageIndexName, 'opts.baseImageIndexName');
    var req = opts.req;
    var log = req.log;

    // Find the base image.
    var imageOpts = {
        app: req.app,
        log: log,
        account: req.account,
        name: baseImageId,
        index_name: opts.baseImageIndexName,
        includeSmartos: false
    };
    req.backend.imgFromName(imageOpts, function (findErr, image) {
        if (findErr) {
            callback(findErr);
            return;
        }
        if (!image) {
            callback(new errors.DockerError(
                'could not find base image: ' + baseImageId));
            return;
        }

        // Update base image (and all base image parent images) to include the
        // new head reference.
        req.backend.getImageHistory({
            account: req.account,
            app: req.app,
            img: image,
            log: log
        }, function (histErr, history) {
            if (histErr) {
                callback(new errors.DockerError(histErr,
                    'could not create image layer'));
                return;
            }

            vasync.forEachPipeline({
                inputs: history,
                func: addImageHead
            }, function (err) {
                if (err) {
                    callback(new errors.DockerError(err,
                        'could not create image layer'));
                    return;
                }
                callback();
            });

            function addImageHead(img, next) {
                log.debug('addImageHead img id: %s, head: %s',
                    img.docker_id, finalImageId);
                var addHeadOpts = {
                    heads: [finalImageId],
                    id: img.docker_id,
                    index_name: img.index_name,
                    req: req
                };

                req.log.debug(format('Adding %j to %j image heads',
                    finalImageId, img.docker_id));
                req.backend.addImageHeads(addHeadOpts, next);
            }
        });
    });
}


/**
 * Tag - your it! Tag is applied to the sdc-docker image model.
 */
function tagImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.docker_id, 'opts.docker_id');
    assert.object(opts.req, 'opts.req');
    assert.optionalString(opts.name, 'opts.name');

    if (!opts.name) {
        callback();
        return;
    }

    opts.req.log.debug(format('Adding tag %j to image with docker id %j',
                            opts.name, opts.docker_id));
    opts.req.backend.tagImage(opts, callback);
}


/**
 * Run the given run command inside of the container. This will start/stop the
 * container.
 */
function runBuildCommand(opts, callback) {
    var log = opts.log;
    var req = opts.req;
    var res = opts.res;

    log.debug('runBuildCommand: attachContainer');

    // 1. Attach to the container (it will do the cmd exec after start fires).
    // 2. Start the container.
    // 3. Send any cmd (stdout/stder) data back to the client.
    // 4. Wait until attach finishes - we're done.

    callback = once(callback);
    var payload = {
        AttachConsole: true,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Cmd: ['AttachConsole'], // To fix in cn-agent
        Container: opts.dockerId,
        Tty: false
    };

    // Pipe attachContainer data back to the client.
    var attachStream = new stream.Writable();
    attachStream._write = function (chunk, encoding, done) {
        log.debug('runBuildCommand: attach wrote %j bytes', chunk.length);
        res.write(JSON.stringify({ stream: String(chunk) }) + '\n');
        done();
    };

    /**
     * This flow is a little strange, so an explanation is warranted:
     *
     * - attachContainer launches and then it waits for the container to start
     *   before returning via the callback.
     *
     * - in parallel, a call to startContainer is made and this allows
     *   the attachContainer call to return.
     *
     * - when both attachContainer and startContainer fire their callbacks,
     *   waitContainer is then called to get the exit code.
     */

    vasync.parallel({ funcs: [
        function _attach(next) {
            req.backend.attachContainer({
                account: req.account,
                app: req.app,
                doNotEncodeData: true,  // Don't encode when writing to stream.
                id: opts.dockerId,
                log: log,
                payload: payload,
                req_id: opts.req_id,
                socket: attachStream,
                vm: opts.vm
            }, function (err) {
                log.debug('runBuildCommand: attachContainer finished, err: %j',
                    err);
                next(err);
            });
        },

        function _start(next) {
            req.backend.startContainer({
                account: req.account,
                app: req.app,
                log: log,
                req_id: opts.req_id,
                vm: opts.vm
            }, function (err) {
                log.debug('runBuildCommand: startContainer finished, err: %j',
                    err);
                next(err);
            });
        }
    ]}, function (err) {
        if (err) {
            callback(err);
            return;
        }
        // Get return code from the run command.
        req.backend.waitContainer({
            account: req.account,
            app: req.app,
            log: log,
            req_id: opts.req_id,
            vm: opts.vm
        }, function (waitErr, exitCode) {
            log.debug('runBuildCommand: container exit code: %j', exitCode);
            callback(waitErr, { exitCode: exitCode });
        });
    });
}


/**
 * Commit (create) an image from a given container.
 *
 * @param {Object} req - Request instance.
 * @param {Object} opts
 * @param {String} opts.author - Author name for the image
 * @param {Array} opts.changes - Docker image changes to make.
 * @param {String} opts.comment - Comment notes for the image.
 * @param {Object} opts.config - Image config object
 * @param {Boolean} opts.pause - common.boolFromQueryParam(req.query.pause),
 * @param {String} opts.tag - repoAndTag
 *
 * @param callback {Function} `function (err, imageId)`
 */
function commitImage(req, opts, callback) {
    assert.object(req, 'req');
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');
    assert.optionalString(opts.author, 'opts.author');
    assert.optionalArrayOfString(opts.changes, 'opts.changes');
    assert.optionalString(opts.comment, 'opts.comment');
    assert.optionalObject(opts.config, 'opts.config');
    assert.optionalBool(opts.pause, 'opts.pause');
    assert.optionalString(opts.tag, 'opts.tag');

    var vm = req.vm;
    assert.object(vm, 'vm');  // Should have been added by the backend.

    var baseImg;
    var baseImageId = vm.internal_metadata['docker:imageid'];
    var commitFinishedSuccessfully = false;
    var finalImageId = null;  // Final docker image id for resulting image.
    var log = req.log;
    var previousErr;
    var rat;
    var req_id = req.getId();
    var scratchImage;
    var socketOpts;

    // There is the potential to run the callback twice, so make sure that never
    // happens.
    callback = once(callback);

    try {
        rat = drc.parseRepoAndTag(opts.tag || '');
    } catch (e) {
        callback(new errors.DockerError(e, e.message));
        return;
    }

    vasync.pipeline({ funcs: [
        getScratchImage,
        findContainerImage,
        checkTagRepository,
        startCnapiDockerCommit,
        runCnapiDockerCommit
    ]}, commitCleanup);


    function getScratchImage(_, cb) {
        req.app.backend.getScratchImage(req,
        function _getScratchImageCb(err, sImg) {
            if (err) {
                log.error(err, 'getScratchImage failure');
                cb(err);
                return;
            }
            scratchImage = sImg;
            cb();
        });
    }

    // Find the Image model for running container.
    function findContainerImage(_, cb) {
        var dockerImageOpts = {
            account: req.account,
            app: req.app,
            log: log
        };
        images.getDockerImageForUuid(vm.image_uuid, dockerImageOpts,
            function _dockerImageUuidCb(err, imgModel) {
                baseImg = imgModel;
                cb(err);
            }
        );
    }

    function checkTagRepository(_, cb) {
        // DOCKER-748: Ensure the tag and the image are in the same repository.
        if (baseImg.index_name !== rat.index.name) {
            cb(new errors.DockerError(format(
                'Cannot create tag reference between different registries '
                + '(%s, %s)', baseImg.index_name, rat.index.name)));
            return;
        }
        cb();
    }

    // Start the cn-agent commit task.
    function startCnapiDockerCommit(_, cb) {
        var cnapi = req.app.cnapi;
        var cnapiCommitPayload = common.objCopy(opts);
        var cnapiCommitOpts = {
            headers: {
                'x-request-id': req_id,
                // Add the docker registry headers.
                'x-registry-config': req.headers['x-registry-config'],
                'x-registry-auth': req.headers['x-registry-auth']
            }
        };

        cnapiCommitPayload.account_uuid = req.account.uuid;
        cnapiCommitPayload.command = 'commit';  // Command type.
        cnapiCommitPayload.fromImage = utils.imgobjToInspect(baseImg);
        cnapiCommitPayload.fromImageUuid = vm.image_uuid;
        cnapiCommitPayload.imgapi_url = req.app.config.imgapi.url;

        /* CNAPI, commit the container to an image for us. */
        cnapi.dockerBuild(vm.server_uuid, vm.uuid,
            { payload: cnapiCommitPayload },
            cnapiCommitOpts,
            function _dockerCommitCb(err, result) {
                if (err) {
                    log.error(err, 'error calling cnapi.dockerCommit');
                    cb(err);
                    return;
                }

                socketOpts = result;
                cb();
            }
        );
    }


    function runCnapiDockerCommit(_, cb) {
        var commitError;
        var commitEventStream;
        var host = socketOpts.host;
        var port = socketOpts.port;

        // There is the potential to call cb twice, make sure it never happens.
        cb = once(cb);

        var commitSocket = net.createConnection({ host: host, port: port });
        commitSocket.setTimeout(10 * 60 * 1000);  // 10 minutes
        log.debug('commit: created socket connection to cnapi');

        var sendEventResponse = function (event, err, result) {
            var response = {
                messageId: event.messageId,
                type: 'callback'
            };
            if (err) {
                recordError(err, event.type + ' error');
                response.error = err.message;
            }
            if (typeof (result) !== 'undefined') {
                response['result'] = result;
            }
            log.debug('response:', response);
            commitSocket.write(JSON.stringify(response) + '\n');
        };

        commitSocket.on('connect', function _commitSocketConnectCb() {
            log.debug('commit: cnapi commit socket connected');
            // Don't need to do anything, the CNAPI commit will send events.
        });

        commitEventStream = new LineStream();
        commitSocket.pipe(commitEventStream);
        commitEventStream.on('line', function _commitLineCb(event) {
            log.debug('commit: got commit event:', String(event));
            try {
                event = JSON.parse(event);
            } catch (e) {
                log.error('Commit: invalid json: %s - ignoring', event);
                return;
            }
            switch (event.type) {
                case 'end':
                    if (event.error) {
                        // Will be passed to callback `cb`.
                        commitError = new Error(event.error);
                    }
                    break;
                case 'message':
                case 'stdout':
                    log.info('Commit event message: %s', event.message);
                    break;
                case 'image_create':
                    createImage(event.payload, { rat: rat, req: req },
                        function _imageCreateCb(err, result)
                    {
                        sendEventResponse(event, err, result);
                    });
                    break;
                case 'commit_finished':
                    finalImageId = event.finalId;
                    vasync.pipeline({ funcs: [
                        function _doAddBaseImageHead(_result, next) {
                            addBaseImageHead(baseImageId, finalImageId,
                            {
                                baseImageIndexName: baseImg.index_name,
                                req: req,
                                scratchImage: scratchImage
                            }, next);
                        },
                        function _doTagImage(_result, next) {
                            tagImage({
                                    docker_id: finalImageId,
                                    name: opts.tag,
                                    req: req
                                }, next);
                        }
                    ]}, function commitFinishPipeCb(err) {
                        if (!err) {
                            commitFinishedSuccessfully = true;
                        }
                        sendEventResponse(event, err);
                    });
                    break;
                default:
                    log.error('Unhandled commit event: %j', event);
                    break;
            }
        });
        commitEventStream.on('close', function _eventStreamCloseCb() {
            log.debug('commit: commitEventStream.close - closing socket');
        });
        commitSocket.on('end', function _commitSocketEndCb() {
            log.debug('commit: commitSocket.end', commitError);
            cb(commitError);
        });
        commitSocket.on('error', function _commitSocketErrorCb(socketErr) {
            log.error('commit: cnapi commit socket error: %s', socketErr);
            cb(new Error('Commit socket error: %s', socketErr));
        });
        commitSocket.on('timeout', function _commitSocketTimeoutCb() {
            log.error('commit: cnapi commit socket has timed out');
            commitSocket.destroy();
            cb(new Error('Commit operation has timed out'));
        });
    }


    function commitCleanup(err, results) {
        log.debug('commit: final callback, err: %j', err);
        if (err) {
            callback(err);
            return;
        }
        if (previousErr) {
            // Error occurred during a previous cn-agent task.
            callback(previousErr);
            return;
        }
        if (!commitFinishedSuccessfully) {
            callback(new errors.DockerError('Unexpected commit error'));
            return;
        }
        callback(null, finalImageId);
    }


    function recordError(err, logMessage) {
        log.error(err, logMessage);
        if (!previousErr) {
            previousErr = err;
        }
    }
}


// ---- exports

module.exports = {
    buildImage: buildImage,
    commitImage: commitImage
};
