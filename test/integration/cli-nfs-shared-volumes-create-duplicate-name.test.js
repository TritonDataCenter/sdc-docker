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

test('Volume creation with same name as existing volume', function (tt) {
    var testVolumeName =
        common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);

    tt.test('creating volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            createTestVolume({
                name: testVolumeName
            }, function volumeCreated(err, stdout, stderr) {
                t.ifErr(err,
                    'volume should have been created successfully');
                t.equal(stdout, testVolumeName + '\n',
                    'output is newly created volume\'s name');

                t.end();
            });
        }
    );

    tt.test('creating second volume with name ' + testVolumeName + ' should '
        + 'fail with appropriate error message',
        function (t) {
            var expectedErrMsg = '(VOLUME_ALREADY_EXISTS) problem creating '
                + 'volume: Volume with name ' + testVolumeName
                + ' already exists';

            createTestVolume({
                name: testVolumeName
            }, function volumeCreated(err, stdout, stderr) {
                t.ok(err, 'volume creation should not succeed');
                t.ok(stderr.indexOf(expectedErrMsg) !== -1,
                    'Error message should include: ' + expectedErrMsg);

                t.end();
            });
        }
    );

    tt.test('removing volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            cli.rmVolume({args: testVolumeName},
                function onVolumeDeleted(err, stdout, stderr) {
                    var dockerVolumeOutput = stdout;

                    if (mod_testVolumes.dockerVolumeRmUsesStderr()) {
                        dockerVolumeOutput = stderr;
                    }

                    t.ifErr(err,
                        'Removing an existing shared volume should not '
                            + 'error');
                    t.equal(dockerVolumeOutput, testVolumeName + '\n',
                        'Output should be shared volume\'s name');

                    t.end();
                });
        });
});