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

var assert = require('assert-plus');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var volumesCli = require('../lib/volumes-cli');
var common = require('../lib/common');
var testVolumes = require('../lib/volumes');

if (!testVolumes.dockerClientSupportsVolumes(process.env.DOCKER_CLI_VERSION)) {
    console.log('Skipping volume tests: volumes are not supported in Docker '
        + 'versions < 1.9');
    process.exit(0);
}

var errorMeansNFSSharedVolumeSupportDisabled =
    testVolumes.errorMeansNFSSharedVolumeSupportDisabled;

var NFS_SHARED_VOLUMES_SUPPORTED = testVolumes.nfsSharedVolumesSupported();
var NFS_SHARED_VOLUME_NAMES_PREFIX =
    testVolumes.getNfsSharedVolumesNamePrefix();
var NFS_SHARED_VOLUMES_DRIVER_NAME =
    testVolumes.getNfsSharedVolumesDriverName();

var MOUNTING_CONTAINER_NAMES_PREFIX = 'test-nfs-mounting-container';

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

test('cleanup leftover resources from previous tests run', function (tt) {
    tt.test('deleting all volumes for test user', function (t) {
        volumesCli.deleteAllVolumes(ALICE_USER,
            function allVolumesDeleted(err) {
                t.ifErr(err, 'deleting all volumes should not error');

                t.end();
            });
    });
});

test('docker volume with default driver', function (tt) {
    var volumeName;

    tt.test('creating volume with no driver should succeed', function (t) {
        volumeName =
            common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);

        vasync.pipeline({funcs: [
            function createVolume(_, next) {
                volumesCli.createVolume({
                    user: ALICE_USER,
                    args: '--name ' + volumeName
                }, function onVolumeCreated(err, stdout, stderr) {
                    if (NFS_SHARED_VOLUMES_SUPPORTED) {
                        t.ifErr(err,
                            'volume should have been created successfully');
                        t.equal(stdout, volumeName + '\n',
                            'output is newly created volume\'s name');
                    } else {
                        t.notEqual(stderr.indexOf('Volumes are not supported'),
                            -1);
                    }

                    next(err);
                });
            },
            function inspectVolume(_, next) {
                if (!NFS_SHARED_VOLUMES_SUPPORTED) {
                    next();
                    return;
                }

                volumesCli.inspectVolume({
                    user: ALICE_USER,
                    args: volumeName
                }, function onInspect(err, stdout, stderr) {
                    var inspectParsedOutput;

                    t.ifErr(err, 'inspect should succeed');
                    try {
                        inspectParsedOutput = JSON.parse(stdout);
                    } catch (inspectParseErr) {
                    }

                    t.equal(inspectParsedOutput[0].Driver,
                        NFS_SHARED_VOLUMES_DRIVER_NAME,
                            'volume driver should be '
                                + NFS_SHARED_VOLUMES_DRIVER_NAME);

                    next();
                });
            },
            function _deleteVolume(_, next) {
                volumesCli.rmVolume({
                    user: ALICE_USER,
                    args: volumeName
                }, function onVolumeDeleted(err, stdout, stderr) {
                    var dockerVolumeOutput = stdout;

                    t.ifErr(err,
                        'Removing an existing shared volume should not error');
                    t.equal(dockerVolumeOutput, volumeName + '\n',
                        'Output should be shared volume\'s name');
                    next();
                });
            }
        ]}, function allDone(err) {
            t.end();
        });
    });
});

test('docker volume with default name', function (tt) {
    var volumeName;

    tt.test('creating volume without specifying a name should succeed and '
        + 'generate a new name', function (t) {
        vasync.pipeline({funcs: [
            function _createVolume(_, next) {
                volumesCli.createVolume({
                    user: ALICE_USER,
                    args: '--driver ' + NFS_SHARED_VOLUMES_DRIVER_NAME
                }, function onVolumeCreated(err, stdout, stderr) {
                    var stdoutLines;

                    if (NFS_SHARED_VOLUMES_SUPPORTED) {
                        t.ifErr(err,
                            'volume should have been created successfully');

                        stdoutLines = stdout.split('\n');
                        t.equal(stdoutLines.length, 2,
                            'output should be two lines');

                        volumeName = stdoutLines[0];
                        t.ok(testVolumes.validGeneratedVolumeName(volumeName),
                            'newly created volume\'s name "' + volumeName
                                + '" should match automatically generated '
                                + 'volume name pattern');
                    } else {
                        t.notEqual(stderr.indexOf('Volumes are not supported'),
                            -1);
                    }

                    next();
                });
            },
            function _deleteVolume(_, next) {
                volumesCli.rmVolume({
                    user: ALICE_USER,
                    args: volumeName
                },
                function onVolumeDeleted(err, stdout, stderr) {
                    var dockerVolumeOutput = stdout;

                    t.ifErr(err,
                        'Removing an existing shared volume should not error');
                    t.equal(dockerVolumeOutput, volumeName + '\n',
                        'Output should be shared volume\'s name');
                    next();
                });
            }
        ]}, function allDone(err) {
            t.end();
        });
    });
});

test('docker NFS shared volume simple creation', function (tt) {
    var containerName;
    var volumeName;

    tt.test('creating a NFS shared volume should succeed', function (t) {
            volumeName =
                common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
            volumesCli.createVolume({
                user: ALICE_USER,
                args: '--name ' + volumeName + ' --driver '
                    + NFS_SHARED_VOLUMES_DRIVER_NAME
            }, function onVolumeCreated(err, stdout, stderr) {
                if (NFS_SHARED_VOLUMES_SUPPORTED) {
                    t.ifErr(err,
                        'volume should have been created successfully');
                    t.equal(stdout, volumeName + '\n',
                        'output should be newly created volume\'s name');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
                }

                t.end();
            });
    });

    tt.test('listing volumes should output newly created volume', function (t) {
        volumesCli.listVolumes({
            user: ALICE_USER
        }, function onVolumesListed(err, stdout, stderr) {
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
                t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
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
            volumesCli.rmVolume({
                user: ALICE_USER,
                args: volumeName
            }, function onVolumeDeleted(err, stdout, stderr) {
                var dockerVolumeOutput = stdout;

                t.ifErr(err,
                    'Removing an existing shared volume should not error');
                t.equal(dockerVolumeOutput, volumeName + '\n',
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
            volumesCli.createVolume({
                user: ALICE_USER,
                args: '--name ' + firstVolumeName + ' --driver '
                    + NFS_SHARED_VOLUMES_DRIVER_NAME
            }, function onVolumeCreated(err, stdout, stderr) {
                if (NFS_SHARED_VOLUMES_SUPPORTED) {
                    t.ifErr(err,
                        'volume should have been created successfully');
                    t.equal(stdout, firstVolumeName + '\n',
                        'output should be newly created volume\'s name');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
                }

                t.end();
            });
    });

    tt.test('creating second NFS shared volume should succeed', function (t) {
            secondVolumeName =
                common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
            volumesCli.createVolume({
                user: ALICE_USER,
                args: '--name ' + secondVolumeName + ' --driver '
                    + NFS_SHARED_VOLUMES_DRIVER_NAME
            }, function onVolumeCreated(err, stdout, stderr) {
                if (NFS_SHARED_VOLUMES_SUPPORTED) {
                    t.ifErr(err,
                        'volume should have been created successfully');
                    t.equal(stdout, secondVolumeName + '\n',
                        'output should be newly created volume\'s name');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
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

    tt.test('deleting mounting container should succeed', function (t) {
            cli.rm(t, {args: containerName},
            function onContainerDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'deleting container mounting NFS shared volume '
                        + 'should succeed');
                t.end();
            });
    });

    tt.test('deleting first shared volume should succeed', function (t) {
        volumesCli.rmVolume({
            user: ALICE_USER,
            args: firstVolumeName
        }, function onVolumeDeleted(err, stdout, stderr) {
                var dockerVolumeOutput = stdout;

                t.ifErr(err,
                    'Removing first shared volume should not error');
                t.equal(dockerVolumeOutput, firstVolumeName + '\n',
                    'Output should be first shared volume\'s name');
                t.end();
            });
    });

    tt.test('deleting second shared volume should succeed', function (t) {
        volumesCli.rmVolume({
            user: ALICE_USER,
            args: secondVolumeName
        }, function onVolumeDeleted(err, stdout, stderr) {
                var dockerVolumeOutput = stdout;

                t.ifErr(err,
                    'Removing second shared volume should not error');
                t.equal(dockerVolumeOutput, secondVolumeName + '\n',
                    'Output should be secondVolumeName shared volume\'s name');
                t.end();
            });
    });
});

test('docker run mounting non-existent volume', function (tt) {
    var nonExistingVolumeName = 'non-existent-volume';
    var containerName =
                common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);

    tt.test('mounting a non-existent NFS shared volume should succeed',
        function (t) {
            cli.run(t, {
                args: '--name ' + containerName
                    + ' -v ' + nonExistingVolumeName + ':/data busybox:latest'
                    + ' /bin/sh -c "touch /data/foo.txt && ls /data"'
            }, function onContainerRun(err, output) {
                if (NFS_SHARED_VOLUMES_SUPPORTED) {
                    t.ifErr(err, 'Mounting a non-existent volume should not '
                        + 'error');
                    t.equal(output.stdout, 'foo.txt\n', 'Output should include '
                        + 'newly created file\'s name');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, output));
                }

                t.end();
            });
        });

    tt.test('listing volumes should output newly created volume', function (t) {
        volumesCli.listVolumes({
            user: ALICE_USER
        }, function onVolumesListed(err, stdout, stderr) {
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
                    if (driverAndName[1] === nonExistingVolumeName) {
                        foundNewlyCreatedVolume = true;
                    }
                });

                t.ok(foundNewlyCreatedVolume, 'newly created volume should be '
                    + 'present in volume ls output');
            } else {
                t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
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

    tt.test('deleting mounting container should succeed', function (t) {
            cli.rm(t, {args: containerName},
            function onContainerDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'deleting container mounting NFS shared volume '
                        + 'should succeed');
                t.end();
            });
    });

    tt.test('deleting shared volume should succeed', function (t) {
        volumesCli.rmVolume({
            user: ALICE_USER,
            args: nonExistingVolumeName
        }, function onVolumeDeleted(err, stdout, stderr) {
                var dockerVolumeOutput = stdout;

                t.ifErr(err,
                    'Removing shared volume should not error');
                t.equal(dockerVolumeOutput, nonExistingVolumeName + '\n',
                    'Output should be shared volume\'s name');
                t.end();
            });
    });
});

test('list docker volumes', function (tt) {

    tt.test('should not output deleted volumes', function (t) {
        volumesCli.listVolumes({
            user: ALICE_USER
        }, function onVolumesListed(err, stdout, stderr) {
            var outputLines;
            var foundDeletedVolume = false;

            if (NFS_SHARED_VOLUMES_SUPPORTED) {
                t.ifErr(err, 'listing volumes should not error');
                outputLines = stdout.trim().split(/\n/);
                // Remove header from docker volume ls' output.
                outputLines = outputLines.slice(1);

                outputLines.forEach(function checkVolumeLsOutputLine(line) {
                    var driverAndName = line.trim().split(/\s+/);
                    var volumeDriver = driverAndName[0];
                    var volumeName = driverAndName[1];

                    t.equal(volumeDriver, NFS_SHARED_VOLUMES_DRIVER_NAME,
                        'driver should be ' + NFS_SHARED_VOLUMES_DRIVER_NAME);
                    if (volumeName.match(NFS_SHARED_VOLUME_NAMES_PREFIX)) {
                        foundDeletedVolume = true;
                    }
                });

                t.equal(foundDeletedVolume, false,
                    'volumes created and deleted by this tests suite should '
                        + 'not be listed in volume ls output');
            } else {
                t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
            }

            t.end();
        });
    });
});