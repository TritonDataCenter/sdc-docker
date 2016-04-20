/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var restify = require('restify');
var vasync = require('vasync');

var validate = require('../validate');

function createVolume(req, res, next) {
    assert.object(req, 'object');
    assert.object(req.log, 'req.log');
    assert.object(res, 'object');
    assert.func(next, 'next');

    var log = req.log;

    var options = {
        account: req.account,
        app: req.app,
        log: log,
        reqId: req.getId()
    };

    var volumeParams = {
        name: req.params.Name,
        size: req.params.DriverOpts.size,
        network: req.params.DriverOpts.network,
        type: req.params.Driver
    };

    req.backend.createVolume(volumeParams, options,
        function onVolumeCreated(err, volume) {
            log.debug({err: err}, 'result from backend');
            if (err) {
                log.error({volume: volume, err: err}, 'createVolume error');
                next(err);
                return;
            }

            res.send({
                Name: volume.name
            });

            next();
        });
}

function volapiToDockerNfsVolume(volapiVolume) {
    assert.object(volapiVolume, 'volapiVolume');

    return {
        Name: volapiVolume.name,
        Driver: volapiVolume.type,
        Mountpoint: volapiVolume.filesystem_path
    };
}

function volapiToDockerVolume(volapiVolume) {
    assert.object(volapiVolume, 'volapiVolume');

    var volumesFormatters = {
        tritonnfs: volapiToDockerNfsVolume
    };

    var volumeFormatter = volumesFormatters[volapiVolume.type];
    if (volumeFormatter) {
        return volumeFormatter(volapiVolume);
    } else {
        return volapiVolume;
    }
}

function volapiToDockerVolumes(volapiVolumes) {
    assert.arrayOfObject(volapiVolumes, 'volapiVolumes');

    return volapiVolumes.map(volapiToDockerVolume);
}

function listVolumes(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var log = req.log;

    var params = {};
    params.filter = req.query.filter;

    var options = {
        account: req.account,
        app: req.app,
        log: log,
        reqId: req.getId()
    };

    req.backend.listVolumes(params, options,
        function onVolumesListed(err, volapiVolumes) {
            var dockerVolumes = [];

            if (err) {
                log.error({err: err, volapiVolumes: volapiVolumes},
                    'Error when listing volumes');
                next(err);
            } else {
                dockerVolumes = volapiToDockerVolumes(volapiVolumes);
                res.send(200, {
                    Volumes: dockerVolumes
                });
                next();
            }
        });
}

function deleteVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var log = req.log;
    var volumeName = req.params.name;

    var options = {
        account: req.account,
        app: req.app,
        log: log,
        reqId: req.getId()
    };

    vasync.waterfall([
        function _findVolumeIdByName(done) {
            req.backend.listVolumes({
                name: volumeName
            }, options, function onVolumesListed(err, volumes) {
                assert.optionalArrayOfObject(volumes, 'volumes');
                var volumeUuid;
                if (volumes && volumes.length > 0) {
                    volumeUuid = volumes[0].uuid;
                }

                done(err, volumeUuid);
            });
        },
        function _deleteVolume(volumeUuid, done) {
            req.backend.deleteVolume({
                uuid: volumeUuid
            }, options, done);
        }
    ], function _onVolumeDeleted(err) {
        if (err) {
            log.error({err: err}, 'Error when deleting volume');
            next(err);
        } else {
            res.send(204);
            next();
        }
    });
}

function inspectVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var log = req.log;
    var options = {
        account: req.account,
        app: req.app,
        log: log,
        reqId: req.getId()
    };

    req.backend.inspectVolume({
        name: req.params.name
    }, options, function onVolumeInspected(err, volume) {
        if (err) {
            log.error({err: err}, 'Error when inspecting volume');
            next(err);
        } else {
            res.send(200, volapiToDockerVolume(volume));
            next();
        }
    });
}

/**
 * Register all endpoints with the restify server
 */
function register(config, http, before) {
    function reqParamsName(req, res, next) {
        assert.object(req, 'req');
        assert.object(res, 'res');
        assert.func(next, 'next');

        req.params.name = decodeURIComponent(req.params[1]);
        next();
    }

    function volumesSupported(req, res, next) {
        assert.object(req, 'req');
        assert.object(res, 'res');
        assert.func(next, 'next');

        var err;
        if (config.experimental_nfs_shared_volumes !== true) {
            err = new Error('Volumes are not supported');
        }

        next(err);
    }

    http.post({
        path: /^(\/v[^\/]+)?\/volumes\/create$/,
        name: 'CreateVolume'
    }, before, volumesSupported, restify.bodyParser(),
        validate.createVolume, createVolume);

    http.get({
        path: /^(\/v[^\/]+)?\/volumes$/,
        name: 'ListVolumes'
    }, before, volumesSupported, restify.queryParser({mapParams: false}),
        listVolumes);

    http.del({
        path: /^(\/v[^\/]+)?\/volumes\/([^\/]+)$/,
        name: 'DeleteVolume'
    }, before, volumesSupported, reqParamsName,
        restify.queryParser({mapParams: false}),
        validate.deleteVolume, deleteVolume);

    http.get({
        path: /^(\/v[^\/]+)?\/volumes\/([^\/]+)$/,
        name: 'InspectVolume'
    }, before, volumesSupported, reqParamsName, validate.inspectVolume,
        inspectVolume);
}

module.exports = {
    register: register
};
