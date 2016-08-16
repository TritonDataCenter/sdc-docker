/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var sdcClients = require('sdc-clients');
var vasync = require('vasync');

var cli = require('./cli');
var common = require('./common');
var configLoader = require('../../lib/config-loader');
var log = require('./log');

var CONFIG = configLoader.loadConfigSync({log: log});

var NFS_SHARED_VOLUMES_SUPPORTED = false;
if (CONFIG.experimental_nfs_shared_volumes === true) {
    NFS_SHARED_VOLUMES_SUPPORTED = true;
}

/*
 * Returns true if the instance of sdc-docker against which these tests are run
 * supports NFS shared volumes, false otherwise.
 */
function nfsSharedVolumesSupported() {
    return NFS_SHARED_VOLUMES_SUPPORTED;
}

/*
 * Returns a string representing the driver name used by NFS shared volumes.
 */
function getNfsSharedVolumesDriverName() {
    return 'tritonnfs';
}

/*
 * Returns a string representing the prefix that can (and should) be used when
 * creating any NFS shared volume as part of the tests suite.
 */
function getNfsSharedVolumesNamePrefix() {
    return 'test-nfs-shared-volume';
}

/*
 * Returns true if the version of the Docker client used by the current
 * integration test supports volumes, false otherwise.
 */
function dockerClientSupportsVolumes(dockerVersionString) {
    assert.string(dockerVersionString, 'dockerVersionString');

    var dockerVersion = common.parseDockerVersion(dockerVersionString);

    if (dockerVersion.major < 1 || dockerVersion.minor < 9) {
        return false;
    }

    return true;
}

/*
 * Returns true if the "docker rm command" for the version of the Docker client
 * used by the current integration test outputs its results on stderr. False
 * otherwise.
 */
function dockerVolumeRmUsesStderr(dockerVersionString) {
    assert.string(dockerVersionString, 'dockerVersionString');

    var dockerVersion = common.parseDockerVersion(dockerVersionString);

    // The docker rm command with versions of the Docker client >= 1.12 output
    // the deleted volume name on stderr instead of stdout.
    return dockerVersion.major >= 1 && dockerVersion.minor >= 12;
}

/*
 * Returns true if the string "volumeName" represents a valid
 * automatically-generated volume name, false otherwise.
 */
function validGeneratedVolumeName(volumeName) {
    assert.string(volumeName, 'volumeName');

    var GENERATED_VOLUME_NAME_REGEXP = /^[\w0-9]{64}$/;

    return GENERATED_VOLUME_NAME_REGEXP.test(volumeName);
}

/*
 * Returns true if the error object "err" and the optional stderr output
 * "stderr" represent an error that means that NFS shared volumes are not
 * supported by the instance of the sdc-docker service from which this error was
 * received.
 */
function errorMeansNFSSharedVolumeSupportDisabled(err, errMsg) {
    assert.optionalObject(err, 'err');
    assert.string(errMsg, 'errMsg');

    var expectedErrMsg = 'Volumes are not supported';

    if (err && (errMsg === undefined
        || errMsg.indexOf(expectedErrMsg) !== -1)) {
        return true;
    }

    return false;
}

var VOLAPI_CLIENT;

function getVolapiClient() {
    var volapiConfig;

    if (VOLAPI_CLIENT === undefined) {
        volapiConfig = jsprim.deepCopy(CONFIG.volapi);

        volapiConfig.version = '^1';
        volapiConfig.userAgent = 'sdc-docker-tests';

        VOLAPI_CLIENT = new sdcClients.VOLAPI(volapiConfig);
    }

    return VOLAPI_CLIENT;
}

module.exports = {
    getNfsSharedVolumesNamePrefix: getNfsSharedVolumesNamePrefix,
    getNfsSharedVolumesDriverName: getNfsSharedVolumesDriverName,
    validGeneratedVolumeName: validGeneratedVolumeName,
    errorMeansNFSSharedVolumeSupportDisabled:
        errorMeansNFSSharedVolumeSupportDisabled,
    nfsSharedVolumesSupported: nfsSharedVolumesSupported,
    getVolapiClient: getVolapiClient,
    dockerVolumeRmUsesStderr: dockerVolumeRmUsesStderr,
    dockerClientSupportsVolumes: dockerClientSupportsVolumes
};