/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This test makes sure that all volume mounting modes supported by docker's
 * engine' are supported by Triton, and that a volume mounted with each valid
 * mode behaves as expected (e.g, that a volume mounted read-only cannot be
 * written to by its mounting container). Supported mounting modes are:
 *
 * - "ro", for read-only. - "rw", for read-write.
 *
 * The default mounting mode is equivalent to "rw".
 */

var common = require('../lib/common');
var dockerVersion = common.parseDockerVersion(process.env.DOCKER_CLI_VERSION);
if (dockerVersion.major < 1 || dockerVersion.minor < 9) {
    console.log('Skipping volume tests: volumes are not supported in Docker '
        + 'versions < 1.9');
    process.exit(0);
}

var assert = require('assert-plus');
var test = require('tape');

var cli = require('../lib/cli');
var log = require('../lib/log');
var mod_testVolumes = require('../lib/volumes');
var volumesCli = require('../lib/volumes-cli');

var createTestVolume = mod_testVolumes.createTestVolume;
var errorMeansNFSSharedVolumeSupportDisabled =
    mod_testVolumes.errorMeansNFSSharedVolumeSupportDisabled;
var VOLAPI_CLIENT = mod_testVolumes.getVolapiClient();

var NFS_SHARED_VOLUMES_DRIVER_NAME =
    mod_testVolumes.getNfsSharedVolumesDriverName();
var NFS_SHARED_VOLUME_NAMES_PREFIX =
    mod_testVolumes.getNfsSharedVolumesNamePrefix();

var MOUNT_MODE_SERVER_SIDE_VALIDATION = true;
if (dockerVersion.major === 1 && dockerVersion.minor <= 9) {
    // With docker version 1.9.x and older, validation for mounting modes (or
    // flags) such as 'ro', etc. is done client side, so there's no need to run
    // some tests that exercise the mode validation code in that case.
    MOUNT_MODE_SERVER_SIDE_VALIDATION = false;
}

var MOUNTING_CONTAINER_NAMES_PREFIX = 'test-nfs-mounting-modes-container';

var ALICE_USER;

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, function onCliInit(err, env) {
            t.ifErr(err, 'Docker environment initialization should not err');
            if (env) {
                ALICE_USER = env.user;
            }
        });
    });

    // Ensure the busybox image is around.
    tt.test('pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });
});

test('docker volumes mounting modes', function (tt) {
    var testVolumeName =
        common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
    var readOnlyThatWritesContainerName, readOnlyThatReadsContainerName;
    var defaultModeContainerName;
    var readWriteModeContainerName;

    tt.test('creating volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            volumesCli.createTestVolume(ALICE_USER, {
                name: testVolumeName
            }, function volumeCreated(err, stdout, stderr) {
                if (mod_testVolumes.nfsSharedVolumesSupported()) {
                    t.ifErr(err,
                        'volume should have been created successfully');
                    t.equal(stdout, testVolumeName + '\n',
                        'output is newly created volume\'s name');
                } else {
                    t.notEqual(stderr.indexOf('Volumes are not supported'),
                        -1);
                }

                t.end();
            });
        }
    );

    /* Testing invalid modes */
    if (MOUNT_MODE_SERVER_SIDE_VALIDATION) {
        tt.test('mounting volume with empty mode should fail', function (t) {
            var invalidModeContainerName =
                common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);
            cli.run(t, {
                args: '--name ' + invalidModeContainerName + ' -v '
                    + testVolumeName + ':/data: busybox:latest /bin/sh '
                    + '-c "echo empty-mode > /data/foo.txt && cat '
                    + '/data/foo.txt"',
                expectedErr: new RegExp(testVolumeName + ':/data:: an empty '
                    + 'flag is not a valid flag')
        }, function onContainerRun(err, output) {
                t.end();
            });
        });

        tt.test('mounting volume with invalid mode should fail', function (t) {
            var invalidModeContainerName =
                common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);
            cli.run(t, {
                args: '--name ' + invalidModeContainerName + ' -v '
                    + testVolumeName + ':/data:invalid-mode busybox:latest '
                    + '/bin/sh -c "echo invalid-mode > /data/foo.txt && cat '
                    + '/data/foo.txt"',
                expectedErr: new RegExp(testVolumeName + ':/data:invalid-mode: '
                    + '"invalid-mode" is not a valid flag')
        }, function onContainerRun(err, output) {
                t.end();
            });
        });
    }

    /*
     * Testing default mode.
     */
    tt.test('writing to volume with default mode should succeed', function (t) {
        defaultModeContainerName =
            common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);
        cli.run(t, {
            args: '--name ' + defaultModeContainerName + ' -v '
                + testVolumeName + ':/data busybox:latest /bin/sh -c "echo '
            + 'default-mode > /data/foo.txt && cat /data/foo.txt"'
        }, function onContainerRun(err, output) {
            var expectedOutput = 'default-mode\n';

            t.ifErr(err,
                'creating file in default mode mount should not error');
            t.equal(output.stdout, expectedOutput,
                'Output should be ' + expectedOutput);
            t.end();
        });
    });

    /*
     * Testing "rw" mode.
     */
    tt.test('writing to volume with "rw" mode should succeed', function (t) {
        readWriteModeContainerName =
            common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);
        cli.run(t, {
            args: '--name ' + readWriteModeContainerName + ' -v '
                + testVolumeName + ':/data:rw busybox:latest /bin/sh -c "echo '
                + 'rw-mode > /data/foo.txt && cat /data/foo.txt"'
    }, function onContainerRun(err, output) {
            var expectedOutput = 'rw-mode\n';

            t.ifErr(err,
                'creating file in "rw" mode mount should not error');
            t.equal(output.stdout, expectedOutput,
                'Output should be ' + expectedOutput);
            t.end();
        });
    });

    /*
     * Testing "ro" mode.
     */
    tt.test('writing to volume with "ro" mode should fail', function (t) {
        var expectedErrMsg =
                '/bin/sh: can\'t create /data/foo.txt: Read-only file system\n';

        readOnlyThatWritesContainerName =
            common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);

        cli.run(t, {
            args: '--name ' + readOnlyThatWritesContainerName + ' -v '
                + testVolumeName + ':/data:ro busybox:latest /bin/sh -c "echo '
                + 'ro-mode > /data/foo.txt && cat /data/foo.txt"',
            expectRuntimeError: true
        }, function onContainerRun(err, output) {
            t.equal(output.stderr, expectedErrMsg, 'Error message should be: '
                + expectedErrMsg + ' but was: ' + output.stderr);
            t.end();
        });
    });

    tt.test('reading from volume with "ro" mode should succeed', function (t) {
        // We expect the output from the last write operaiton that succeeded.
        var expectedOutput = 'rw-mode\n';

        readOnlyThatReadsContainerName =
            common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);

        cli.run(t, {
            args: '--name ' + readOnlyThatReadsContainerName + ' -v '
                + testVolumeName + ':/data:ro busybox:latest /bin/sh -c "cat '
                + '/data/foo.txt"'
        }, function onContainerRun(err, output) {
            t.equal(output.stdout, expectedOutput, 'Output should be: '
                + expectedOutput + ' but was: ' + output.stdout);
            t.end();
        });
    });

    tt.test('deleting container with name ' + defaultModeContainerName
        + ' should succeed', function (t) {
        cli.rm(t, {args: defaultModeContainerName},
            function onContainerDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'deleting container mounting NFS shared volume '
                        + 'should succeed');
                t.end();
            });
    });

    /* Cleaning up resources created for this tests suite */

    tt.test('deleting container with name ' + readWriteModeContainerName
        + ' should succeed', function (t) {
        cli.rm(t, {args: readWriteModeContainerName},
            function onContainerDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'deleting container mounting NFS shared volume '
                        + 'should succeed');
                t.end();
            });
    });

    tt.test('deleting container with name ' + readOnlyThatWritesContainerName
        + ' should succeed', function (t) {
        cli.rm(t, {args: '-f ' + readOnlyThatWritesContainerName},
            function onContainerDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'deleting container mounting NFS shared volume '
                        + 'should succeed');
                t.end();
            });
    });

    tt.test('deleting container with name ' + readOnlyThatReadsContainerName
        + ' should succeed', function (t) {
        cli.rm(t, {args: '-f ' + readOnlyThatReadsContainerName},
            function onContainerDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'deleting container mounting NFS shared volume '
                        + 'should succeed');
                t.end();
            });
    });

    tt.test('removing volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            volumesCli.rmVolume({
                user: ALICE_USER,
                args: testVolumeName
            }, function onVolumeDeleted(err, stdout, stderr) {
                    var dockerVolumeOutput = stdout;

                    t.ifErr(err,
                        'Removing an existing shared volume should not '
                            + 'error');
                    t.equal(dockerVolumeOutput, testVolumeName + '\n',
                        'Output should be shared volume\'s name');

                    t.end();
                });
        });
});