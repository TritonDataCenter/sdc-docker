/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');
var vasync = require('vasync');
var registry = require('docker-registry-client');
var mod_url = require('url');
var format = require('util').format;
var fs = require('fs');

var common = require('../common');
var writeProgress = common.writeProgress;

/**
 * GET /images/json
 */
function imageList(req, res, next) {
    var log = req.log;
    var options = {};

    options.log = req.log;
    options.req_id = req.getId();

    req.backend.listImages(options, function (err, images) {

        log.debug({query: req.query}, 'got query');

        if (err) {
            log.error({err: err}, 'Problem loading images');
            next(new restify.InternalError('Problem loading images'));
            return;
        }

        res.send(images);
        next();
    });
}


/**
 * POST /images/create
 */
function imageCreate(req, res, next) {
    var log = req.log;
    var options = {};

    options.log = req.log;
    options.req_id = req.getId();

    // The docker client will always pass a tag unless the intention is to pull
    // all tags for a given repository. In that case parsed.tag might
    // default to 'latest' if fromImage is just ubuntu
    var askedTag = req.query.fromImage.split(':')[1] || 'all';
    var parsed = registry.parseRepoAndTag(req.query.fromImage);

    var data = { size: {} };
    var session;

    res.status(200);
    res.header('Content-Type', 'application/json');
    writeProgress(res, {status: format('Pulling repository %s', parsed.name)});

    vasync.pipeline({
        funcs: [
            getRepoImgs,
            getRegistrySession,
            getRepoTags,
            getImageAncestry,
            pullImageLayers
        ]
    }, function (err, results) {
        writeProgress(res, {
            id: data.askedImg,
            status: 'Download complete.'
        });
        writeProgress(res, {
            id: data.askedImg,
            status: format('Status: Downloaded newer image for %s:%s',
                parsed.name, askedTag)
        });
        return next(err);
    });

    // This is actually not needed the way /v1/ docker pull works
    function getRepoImgs(_, cb) {
        req.indexClient.listRepoImgs({
            repo: parsed.repo
        }, function (err, repoImgs, res) {
            if (err) {
                console.error(err.message);
                cb(err);
                return;
            }

            var registries;
            if (res.headers['x-docker-endpoints'] !== undefined) {
                var proto = mod_url.parse(req.indexClient.url).protocol;
                /*JSSTYLED*/
                registries = res.headers['x-docker-endpoints'].split(/\s*,\s*/g)
                    .map(function (e) { return proto + '//' + e; });
            }
            data.registry = registries[0];
            data.repoImgs = repoImgs;
            cb();
        });
    }

    function getRegistrySession(_, cb) {
        registry.createRegistrySession({
            repo: parsed.repo
        }, function (err, sess) {
            if (err) {
                console.error(err.message);
                cb(err);
                return;
            }
            session = sess;
            cb();
        });
    }

    function getRepoTags(_, cb) {
        session.listRepoTags(function (err, repoTags) {
            if (err) {
                console.error(err.message);
                cb(err);
                return;
            }
            data.repoTags = repoTags;
            data.askedImg = repoTags[askedTag];
            cb();
        });
    }

    function getImageAncestry(_, cb) {
        writeProgress(res, {
            id: data.askedImg,
            status: format('Pulling image (%s) from %s', askedTag, parsed.name)
        });
        writeProgress(res, {
            id: data.askedImg,
            status: format('Pulling image (%s) from %s, endpoint: %s', askedTag,
                parsed.name, data.registry)
        });

        session.getImgAncestry({
            imgId: data.askedImg
        }, function (err, ancestry) {
            if (err) {
                console.error(err.message);
                cb(err);
                return;
            }

            data.ancestry = ancestry;
            cb();
        });
    }

    function getImgJson(imgId, cb) {
        session.getImgJson({
            imgId: imgId
        }, function (err, imgJson, getRes) {
            if (err) {
                console.error(err.message);
                cb(err);
                return;
            }

            data.size[imgId] = Number(getRes.headers['x-docker-size']);
            cb();
        });
    }

    function pullFsLayer(imgId, cb) {
        writeProgress(res, {
            id: imgId,
            status: 'Pulling fs layer'
        });

        session.getImgLayerStream({
            imgId: imgId
        }, function (err, stream) {
            if (err) {
                console.error(err.message);
                return;
            }

            var shortId = imgId.slice(0, 12);
            var totalBytes = 0;
            var startTs = Math.floor(new Date().getTime() / 1000);
            var fout = fs.createWriteStream('/var/tmp/' + shortId + '.layer');

            fout.on('finish', function () {
                console.log('Done downloading image layer %s', shortId);
                writeProgress(res, {
                    id: imgId,
                    status: 'Downloading',
                    progressDetail: {
                        current: data.size[imgId],
                        total: data.size[imgId],
                        start: startTs
                    }
                });
                cb();
            });

            stream.on('data', function(chunk) {
                totalBytes += chunk.length;

                writeProgress(res, {
                    id: imgId,
                    status: 'Downloading',
                    progressDetail: {
                        current: totalBytes,
                        total: data.size[imgId],
                        start: startTs
                    }
                });
            });

            stream.on('error', function (streamErr) {
                console.error('Error downloading:', streamErr);
                cb(streamErr);
            });

            fout.on('error', function (writeErr) {
                console.error('Error writing:', writeErr);
                cb(writeErr);
            });

            stream.pipe(fout);
            stream.resume();
        });
    }

    function pullOneLayer(imgId, cb) {
        writeProgress(res, {
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
            writeProgress(res, {
                id: imgId,
                status: 'Download complete.'
            });
            return cb(err);
        });
    }

    function pullImageLayers(_, cb) {
        writeProgress(res, {
            id: data.askedImg,
            status: 'Pulling dependent layers'
        });

        vasync.forEachParallel({
            func: pullOneLayer,
            inputs: data.ancestry
        }, function (err, results) {
            return cb(err);
        });
    }
}


/**
 * GET /images/:name/json
 *
 * Images can be inspected by name[:tag] or id
 */
function imageInspect(req, res, next) {
    var name = req.params.name;
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.backend.inspectImage({
        name: name,
        app: req.app,
        log: log,
        req_id: req.getId()
    }, function (err, image) {

        if (err) {
            log.error({err: err}, 'backend.imageInspect failed.');
            next(err);
            return;
        }

        res.send(image);
        next();
    });
}


/**
 * GET /images/:name/history
 */
function imageHistory(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /images/:name/push
 */
function imagePush(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/:name/changes
 */
function imageChanges(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/:name/tag
 */
function imageTag(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * DELETE /images/:name
 */
function imageDelete(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /images/search
 */
function imageSearch(req, res, next) {
    var term = req.query.term;
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.indexClient.search({
        term: term,
        log: log
    }, function (err, images) {
        if (err) {
            log.error({err: err}, 'registry.search failed.');
            next(err);
            return;
        }

        res.send(images.results);
        next();
    });
}


/**
 * GET /images/:name/get
 */
function imageGet(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /images/:name/load
 */
function imageLoad(req, res, next) {
    return next(new restify.InvalidVersionError('Not implemented'));
}




/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/v1.15/images/json', name: 'ImageList' },
        before, imageList);
    http.post({ path: '/v1.15/images/create', name: 'ImageCreate' },
            before, imageCreate);
    http.get({ path: '/v1.15/images/:name/json', name: 'ImageInspect' },
        before, imageInspect);
    http.get({ path: '/images/:name/history', name: 'ImageHistory' },
        before, imageHistory);
    http.post({ path: '/images/:name/push', name: 'ImagePush' },
        before, imagePush);
    http.post({ path: '/images/:name/tag', name: 'ImageTag' },
        before, imageTag);
    http.del({ path: '/images/:name', name: 'ImageDelete' },
        before, imageDelete);
    http.get({ path: '/v1.15/images/search', name: 'ImageSearch' },
        before, imageSearch);
    http.get({ path: '/images/:name/get', name: 'ImageGet' },
        before, imageGet);
    http.post({ path: '/images/:name/load', name: 'ImageLoad' },
        before, imageLoad);
}



module.exports = {
    register: register
};
