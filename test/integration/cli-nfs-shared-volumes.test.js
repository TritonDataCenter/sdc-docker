/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for `docker volume` using the driver that implements NFS
 * shared volumes (currently named 'tritonnfs').
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
var vasync = require('vasync');

var cli = require('../lib/cli');
var log = require('../lib/log');

var configLoader = require('../../lib/config-loader');
var CONFIG = configLoader.loadConfigSync({log: log});
var NFS_SHARED_VOLUMES_SUPPORTED = false;
if (CONFIG.experimental_nfs_shared_volumes === true) {
    NFS_SHARED_VOLUMES_SUPPORTED = true;
}
var NFS_SHARED_VOLUMES_DRIVER_NAME = 'tritonnfs';

var NFS_SHARED_VOLUME_NAMES_PREFIX = 'test-nfs-shared-volume';
var MOUNTING_CONTAINER_NAMES_PREFIX = 'test-nfs-mounting-container';

var STATE = {
    log: log
};

var ALICE;
var DOCKER_API_CLIENT;

function checkVolumesSupportDisabled(t, err, stderr) {
    assert.object(t, 't');
    assert.optionalObject(err, 'err');
    assert.optionalString(stderr, 'stderr');

    var expectedErrMsg = 'Volumes are not supported';

    t.ok(err, 'Volume operation should result in an errror');
    t.notEqual(stderr.indexOf(expectedErrMsg), -1);
}

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', cli.init);

    // Ensure the busybox image is around.
    tt.test('pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });
});

test('docker volume with default driver', function (tt) {

    tt.test('creating volume with no specific driver should fail',
        function (t) {
            cli.createVolume({args: '--name foo'},
                function onVolumeCreated(err, stdout, stderr) {
                    var expectedErrMsg;
                    t.ok(err, 'Creating a volume with no specific driver '
                        + 'should error');
                    if (NFS_SHARED_VOLUMES_SUPPORTED) {
                        expectedErrMsg = '(Validation) local is not a '
                            + 'supported volume driver';
                    } else {
                        expectedErrMsg = 'Volumes are not supported';
                    }

                    t.notEqual(stderr.indexOf(expectedErrMsg), -1);
                    t.end();
                });
        });
});

test('docker NFS shared volume simple creation', function (tt) {
    var containerName;
    var volumeName;

    tt.test('mounting a non-existing NFS shared volume should fail',
        function (t) {
            var nonExistingVolumeName = 'non-existing-volume';
            var expectedErrorMsg = 'Error response from daemon: ';
            if (NFS_SHARED_VOLUMES_SUPPORTED) {
                expectedErrorMsg += 'first of 1 error: No volume found with '
                    + 'name ' + nonExistingVolumeName + ' for current user';
            } else {
                expectedErrorMsg += 'host volumes are not supported';
            }

            containerName =
                common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);

            cli.run(t, {
                args: '--name ' + containerName
                    + ' -v ' + nonExistingVolumeName + ':/data busybox:latest',
                expectedErr: expectedErrorMsg
            });
        });

    tt.test('creating a NFS shared volume should succeed', function (t) {
            volumeName =
                common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
            cli.createVolume({
                args: '--name ' + volumeName + ' --driver '
                    + NFS_SHARED_VOLUMES_DRIVER_NAME
            }, function onVolumeCreated(err, stdout, stderr) {
                if (NFS_SHARED_VOLUMES_SUPPORTED) {
                    t.ifErr(err,
                        'volume should have been created successfully');
                    t.equal(stdout, volumeName + '\n',
                        'output should be newly created volume\'s name');
                } else {
                    checkVolumesSupportDisabled(t, err, stderr);
                }

                t.end();
            });
    });

    tt.test('listing volumes should output newly created volume', function (t) {
        cli.listVolumes({}, function onVolumesListed(err, stdout, stderr) {
            var outputLines;
            var foundNewlyCreatedVolume = false;

            if (NFS_SHARED_VOLUMES_SUPPORTED) {
                t.ifErr(err, 'listing volumes should not error');
                outputLines = stdout.trim().split(/\n/);
                // Remove header from docker volume ls' output.
                outputLines = outputLines.slice(1);
                t.ok(outputLines.length > 0,
                    'volumes list should not be empty');

                outputLines.forEach(function checkVolumeLsOutputLine(line) {
                    var driverAndName = line.trim().split(/\s+/);
                    t.equal(driverAndName[0], NFS_SHARED_VOLUMES_DRIVER_NAME,
                        'driver should be ' + NFS_SHARED_VOLUMES_DRIVER_NAME);
                    if (driverAndName[1] === volumeName) {
                        foundNewlyCreatedVolume = true;
                    }
                });

                t.ok(foundNewlyCreatedVolume, 'newly created volume should be '
                    + 'present in volume ls output');
            } else {
                checkVolumesSupportDisabled(t, err, stderr);
            }

            t.end();
        });
    });

    // Skip next tests if NFS shared volumes are not supported, as they would
    // fail since the volume that needs to be mounted would have not been
    // created. Testing that mounting a nonexistent module fails is done in a
    // separate test, and this allows us to make the rest of this test slightly
    // simpler to read.
    if (!NFS_SHARED_VOLUMES_SUPPORTED) {
        return;
    }

    tt.test('mounting a NFS shared volume from a container should succeed',
        function (t) {
            containerName =
                common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);
            cli.run(t, {
                args: '--name ' + containerName + ' -v ' + volumeName
                    + ':/data busybox:latest /bin/sh -c '
                    + '"touch /data/foo.txt && ls /data"'
            }, function onContainerRun(err, output) {
                t.ifErr(err, 'Mounting a valid volume should not error');
                t.equal(output.stdout, 'foo.txt\n', 'Output should equal '
                    + 'newly created container\'s name');
                t.end();
            });
        });

        tt.test('deleting first mounting container should succeed',
            function (t) {
                cli.rm(t, {args: containerName},
                function onContainerDeleted(err, stdout, stderr) {
                    t.ifErr(err,
                        'deleting container mounting NFS shared volume '
                            + 'should succeed');
                    t.end();
                });
        });

        tt.test('file created by a container should be visible from another '
            + 'container', function (t) {
                containerName =
                    common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);
                cli.run(t, {
                    args: '--name ' + containerName + ' -v ' + volumeName
                        + ':/data busybox:latest ls /data/foo.txt'
                }, function onContainerRun(err, output) {
                    t.ifErr(err, 'Mounting a valid volume should not error');
                    t.equal(output.stdout, '/data/foo.txt\n',
                        'Output should equal name of file created in shared '
                            + 'volume');
                    t.end();
                });
        });

        tt.test('deleting second mounting container should succeed',
            function (t) {
                cli.rm(t, {args: containerName},
                function onContainerDeleted(err, stdout, stderr) {
                    t.ifErr(err,
                        'deleting container mounting NFS shared volume '
                            + 'should succeed');
                    t.end();
                });
        });

        tt.test('deleting shared volume should succeed', function (t) {
            cli.rmVolume({args: volumeName},
                function onVolumeDeleted(err, stdout, stderr) {
                    t.ifErr(err,
                        'Removing an existing shared volume should not error');
                    t.equal(stdout, volumeName + '\n',
                        'Output should be shared volume\'s name');
                    t.end();
                });
        });
});

test('mounting more than one NFS shared volume', function (tt) {
    var firstVolumeName;
    var secondVolumeName;
    var containerName;

    tt.test('creating first NFS shared volume should succeed', function (t) {
            firstVolumeName =
                common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
            cli.createVolume({
                args: '--name ' + firstVolumeName + ' --driver '
                    + NFS_SHARED_VOLUMES_DRIVER_NAME
            }, function onVolumeCreated(err, stdout, stderr) {
                if (NFS_SHARED_VOLUMES_SUPPORTED) {
                    t.ifErr(err,
                        'volume should have been created successfully');
                    t.equal(stdout, firstVolumeName + '\n',
                        'output should be newly created volume\'s name');
                } else {
                    checkVolumesSupportDisabled(t, err, stderr);
                }

                t.end();
            });
    });

    tt.test('creating second NFS shared volume should succeed', function (t) {
            secondVolumeName =
                common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
            cli.createVolume({
                args: '--name ' + secondVolumeName + ' --driver '
                    + NFS_SHARED_VOLUMES_DRIVER_NAME
            }, function onVolumeCreated(err, stdout, stderr) {
                if (NFS_SHARED_VOLUMES_SUPPORTED) {
                    t.ifErr(err,
                        'volume should have been created successfully');
                    t.equal(stdout, secondVolumeName + '\n',
                        'output should be newly created volume\'s name');
                } else {
                    checkVolumesSupportDisabled(t, err, stderr);
                }

                t.end();
            });
    });

    // Skip next tests if NFS shared volumes are not supported, as they would
    // fail since the volume that needs to be mounted would have not been
    // created. Testing that mounting a nonexistent module fails is done in a
    // separate test, and this allows us to make the rest of this test slightly
    // simpler to read.
    if (!NFS_SHARED_VOLUMES_SUPPORTED) {
        return;
    }

    tt.test('mounting both NFS shared volumes from a container should succeed',
        function (t) {
            containerName =
                common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);
            cli.run(t, {
                args: '--name ' + containerName + ' '
                + '-v ' + firstVolumeName + ':/data-first '
                + '-v ' + secondVolumeName + ':/data-second '
                + 'busybox:latest /bin/sh -c "'
                + 'touch /data-first/foo.txt && '
                + 'touch /data-second/bar.txt && ls /data*"'
            }, function onContainerRun(err, output) {
                var expectedOutput =
                    '/data-first:\nfoo.txt\n\n/data-second:\nbar.txt\n';
                t.ifErr(err, 'Mounting both volumes should not error');
                t.equal(output.stdout, expectedOutput,
                    'Output should list files from both volumes');
                t.end();
            });
        });

    tt.test('deleting first shared volume should succeed', function (t) {
        cli.rmVolume({args: firstVolumeName},
            function onVolumeDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'Removing first shared volume should not error');
                t.equal(stdout, firstVolumeName + '\n',
                    'Output should be first shared volume\'s name');
                t.end();
            });
    });

    tt.test('deleting second shared volume should succeed', function (t) {
        cli.rmVolume({args: secondVolumeName},
            function onVolumeDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'Removing second shared volume should not error');
                t.equal(stdout, secondVolumeName + '\n',
                    'Output should be secondVolumeName shared volume\'s name');
                t.end();
            });
    });

    tt.test('deleting mounting container should succeed',
            function (t) {
                cli.rm(t, {args: containerName},
                function onContainerDeleted(err, stdout, stderr) {
                    t.ifErr(err,
                        'deleting container mounting NFS shared volume '
                            + 'should succeed');
                    t.end();
                });
        });
});