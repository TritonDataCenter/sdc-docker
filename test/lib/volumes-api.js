/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('./common');
var constants = require('../../lib/constants');
var testVolumes = require('./volumes');

/*
 * Creates a docker volume with the following parameters:
 *
 * - opts: an object with properties that represents the following options:
 *   - opts.dockerClient: an object representing the docker API client that will
 *     be used to perform all operations.
 *
 *   - opts.name: the name of the volume to create.
 *
 * - callback: a function that will be called when the volume is created. That
 *   function will be called with the following parameters:
 *
 *     - err: an object representing an error, if an error occured.
 *
 *     - volume: an object representing the volume that was just created. That
 *       object is of the same form than the object returned by the docker
 *       volume inspect command.
 */
function createDockerVolume(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.dockerClient, 'opts.dockerClient');
    assert.optionalString(opts.name, 'opts.name');
    assert.func(callback, 'callback');

    assert.ok(testVolumes.nfsSharedVolumesSupported());

    var dockerClient = opts.dockerClient;
    var dockerApiVersion = opts.apiVersion || ('v' + constants.API_VERSION);

    vasync.waterfall([
        function createVolume(next) {
            var volumeNamesPrefix =
                testVolumes.getNfsSharedVolumesNamePrefix();
            var volumeName = opts.name;
            var volumeType = testVolumes.getNfsSharedVolumesDriverName();

            if (!volumeName) {
                volumeName = common.makeResourceName(volumeNamesPrefix);
            }

            var payload =  {
                Name: volumeName,
                Driver: volumeType,
                DriverOpts: {},
                Labels: {}
            };

            dockerClient.post('/' + dockerApiVersion + '/volumes/create',
                payload,
                function onVolumeCreated(err, res, req, body) {
                    next(err, body);
                });
        },
        function getVolumeInfo(volumeCreationResponse, next) {
            assert.object(volumeCreationResponse, 'volumeCreationResponse');
            assert.string(volumeCreationResponse.Name,
                'volumeCreationResponse.Name');

            var volumeName = volumeCreationResponse.Name;

            dockerClient.get('/' + dockerApiVersion + '/volumes/' + volumeName,
                function onVolumeInspect(err, res, req, body) {
                    next(err, body);
                });
        }
    ], callback);
}

module.exports = {
    createDockerVolume: createDockerVolume
};