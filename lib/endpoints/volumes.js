/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var restify = require('restify');
var vasync = require('vasync');
var VError = require('verror');

var errors = require('../errors');
var mod_volumes = require('../volumes');
var validate = require('../validate');

function getErrorFromVolSizeNotAvailableError(err) {
    assert.object(err, 'err');

    var availableSizes;
    var availableSizesInGiB;
    var volSizeNotAvailableErr = VError.findCauseByName(err,
        'VolumeSizeNotAvailableError');

    availableSizes = volSizeNotAvailableErr.body.availableSizes;
    availableSizesInGiB = availableSizes.map(function convertToGib(size) {
        return size / 1024 + 'G';
    });

    return new errors.VolumeSizeNotAvailableError(availableSizesInGiB);
}

function createVolume(req, res, next) {
    assert.object(req, 'object');

    assert.object(req.params, 'req.params');
    assert.string(req.params.Name, 'req.params.Name');
    assert.string(req.params.Driver, 'req.params.Driver');
    assert.optionalObject(req.params.DriverOpts, 'req.params.DriverOpts');

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

    var sizeParams;
    var networkParams;

    if (req.params.DriverOpts) {
        /*
         * The "size" input parameter was validated by a previous restify
         * handler, so it's safe to call "parseVolumeSize" here, even though it
         * throws on invalid input.
         */
        sizeParams = mod_volumes.parseVolumeSize(req.params.DriverOpts.size);
        networkParams = req.params.DriverOpts.network;
    }

    var volumeParams = {
        name: req.params.Name,
        size: sizeParams,
        network: networkParams,
        type: req.params.Driver
    };

    // The 'local' volume driver is used by default and implicitly by at least
    // several Docker clients when creating a volume (including the docker
    // binary and docker-compose). Since "local" volumes don't make much sense
    // on Triton (different containers may end up on different servers), the
    // implicitly set 'local' driver is overriden to Triton's own default volume
    // driver.
    if (volumeParams.type === 'local') {
        volumeParams.type = mod_volumes.DEFAULT_DRIVER;
    }

    req.backend.createVolume(volumeParams, options,
        function onVolumeCreated(err, volume) {
            log.debug({err: err}, 'result from backend');
            if (err) {
                log.error({volume: volume, err: err}, 'createVolume error');
                /*
                 * VolumeSizeNotAvailable errors include some extra information
                 * in their body: a list of available volume sizes in mebibytes.
                 * However, users of the docker client specify volume sizes in
                 * gibibytes, so we need to generate a new error with a message
                 * that mentions available volume sizes in mebibytes.
                 */
                if (err.restCode === 'VolumeSizeNotAvailable') {
                    next(getErrorFromVolSizeNotAvailableError(err));
                    return;
                }
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
    params.filters = req.query.filters;

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

    req.backend.deleteVolume({
        name: volumeName
    }, options, function volumeDeleted(err) {
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
            if (volume === undefined) {
                res.send(404);
            } else {
                res.send(200, volapiToDockerVolume(volume));
            }

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
        if (config.experimental_docker_nfs_shared_volumes !== true) {
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
