/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var common = require('../lib/common');
var mod_testVolumes = require('../lib/volumes');

var dockerVersion = common.parseDockerVersion(process.env.DOCKER_CLI_VERSION);
if (dockerVersion.major < 1 || dockerVersion.minor < 9) {
    console.log('Skipping volume tests: volumes are not supported in Docker '
        + 'versions < 1.9');
    process.exit(0);
}

if (!mod_testVolumes.nfsSharedVolumesSupported()) {
    console.log('Skipping volume tests: volumes are not supported in this '
        + 'Triton setup');
    process.exit(0);
}

var assert = require('assert-plus');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var log = require('../lib/log');

var createTestVolume = mod_testVolumes.createTestVolume;

var NFS_SHARED_VOLUMES_DRIVER_NAME =
    mod_testVolumes.getNfsSharedVolumesDriverName();
var NFS_SHARED_VOLUME_NAMES_PREFIX =
    mod_testVolumes.getNfsSharedVolumesNamePrefix();

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', cli.init);

    // Ensure the busybox image is around.
    tt.test('pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });
});

test('Volume creation with invalid size', function (tt) {
    tt.test('creating volume with invalid sizes should fail', function (t) {
        var INVALID_SIZES = ['invalid-size', '$%#%', ''];

        vasync.forEachParallel({
            func: createVolumeWithInvalidSize,
            inputs: INVALID_SIZES
        }, function invalidSizesTested(err, results) {
            t.end();
        });

        function createVolumeWithInvalidSize(invalidSize, callback) {
            assert.string(invalidSize, 'invalidSize');
            assert.func(callback, 'callback');

            var expectedErrMsg = 'Validation error, causes: Error: size "'
                + invalidSize + '" is not a valid volume size';

            createTestVolume({
                size: invalidSize
            }, function volumeCreated(err, stdout, stderr) {
                t.ok(err, 'volume creation should result in an error');
                t.ok(stderr.indexOf(expectedErrMsg) !== -1,
                    'Error message should include: ' + expectedErrMsg);

                callback();
            });
        }
    });
});