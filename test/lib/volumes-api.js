/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
    assert.optionalString(opts.network, 'opts.network');
    assert.func(callback, 'callback');

    var dockerClient = opts.dockerClient;
    var dockerApiVersion = opts.apiVersion || ('v' + constants.API_VERSION);

    vasync.waterfall([
        function createVolume(next) {
            var volumeNamesPrefix =
                testVolumes.getNfsSharedVolumesNamePrefix();
            var volumeName = opts.name;
            var volumeType = testVolumes.getNfsSharedVolumesDriverName();

            if (volumeName === undefined) {
                volumeName = common.makeResourceName(volumeNamesPrefix);
            }

            var payload =  {
                Name: volumeName,
                Driver: volumeType,
                DriverOpts: {},
                Labels: {}
            };

            if (opts.network) {
                payload.DriverOpts.network = opts.network;
            }

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

/*
 * Deletes a docker volume.
 *
 * @param {Object} opts: object with the following fields:
 *   - apiVersion {String}: the desired Docker engine API version
 *   - dockerClient {Object}: the docker client to use to perform the request
 *   - name {String}: the name of the volume to delete
 * @param {Function} callback: a function called when volume creation completes
 *   either successfully or with an error. The function signature is:
 *   function (err, body).
 */
function deleteDockerVolume(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.apiVersion, 'opts.apiVersion');
    assert.object(opts.dockerClient, 'opts.dockerClient');
    assert.string(opts.name, 'opts.name');
    assert.func(callback, 'callback');

    var dockerApiVersion = opts.apiVersion || ('v' + constants.API_VERSION);
    var dockerClient = opts.dockerClient;

    dockerClient.del('/' + dockerApiVersion + '/volumes/' + opts.name,
        function onVolumeDelete(delErr, res, req, body) {
            callback(delErr, body);
        });
}

module.exports = {
    createDockerVolume: createDockerVolume,
    deleteDockerVolume: deleteDockerVolume
};