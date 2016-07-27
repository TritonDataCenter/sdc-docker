/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Regression test for DOCKER-880: https://smartos.org/bugview/DOCKER-880.
 *
 * This test makes sure that when deleting a volume in state === 'ready' that
 * has the same name as at least one volume in a state !== 'ready', the "docker
 * volume rm" command will actually delete the volume in state === 'ready'.
 *
 * Put differently, if there's no exiting volume for a given sdc-docker account,
 * the following sequence of commands:
 *
 * 1. docker volume create --name foo
 * 2. docker volume rm foo
 * 3. docker volume create --name foo
 * 4. docker volume rm foo
 * 5. docker volume ls
 *
 * will produce no output for the last command.
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
var mod_testVolumes = require('../lib/volumes');

var createTestVolume = mod_testVolumes.createTestVolume;
var errorMeansNFSSharedVolumeSupportDisabled =
    mod_testVolumes.errorMeansNFSSharedVolumeSupportDisabled;
var VOLAPI_CLIENT = mod_testVolumes.getVolapiClient();

var NFS_SHARED_VOLUMES_DRIVER_NAME =
    mod_testVolumes.getNfsSharedVolumesDriverName();
var NFS_SHARED_VOLUME_NAMES_PREFIX =
    mod_testVolumes.getNfsSharedVolumesNamePrefix();

function makeKeepVolumeWithNameFn(volumeName) {
    assert.string(volumeName, 'volumeName');

    return function keepVolumeWithName(dockerVolumeLsOutputLine) {
        assert.string(dockerVolumeLsOutputLine, 'dockerVolumeLsOutputLine');

        var driverAndName = dockerVolumeLsOutputLine.trim().split(/\s+/);
        var name = driverAndName[1];

        if (name === volumeName) {
            return true;
        }

        return false;
    };
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


test('cleanup leftover resources from previous tests run', function (tt) {

    tt.test('leftover volumes should be cleaned up', function (t) {
        mod_testVolumes.deleteLeftoverVolumes(function done(err, errMsg) {
            if (mod_testVolumes.nfsSharedVolumesSupported()) {
                t.ifErr(err, 'deleting leftover volumes should succeed');
            } else {
                t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, errMsg));
            }

            t.end();
        });
    });
});

test('DOCKER-880', function (tt) {
    var testVolumeName =
        common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
    var filterTestVolumesFn = makeKeepVolumeWithNameFn(testVolumeName);
    var firstVolumeUuid;

    tt.test('creating volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            createTestVolume({
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

    tt.test('listing volumes should output one volume with name: '
        + testVolumeName, function (t) {
            cli.listVolumes({}, function onVolumesListed(err, stdout, stderr) {
                var outputLines;
                var testVolumes;

                if (mod_testVolumes.nfsSharedVolumesSupported()) {
                    t.ifErr(err, 'listing volumes should not error');
                    outputLines = stdout.trim().split(/\n/);
                    // Remove header from docker volume ls' output.
                    outputLines = outputLines.slice(1);

                    testVolumes = outputLines.filter(filterTestVolumesFn);

                    t.equal(testVolumes.length, 1, 'only one volume with name '
                        + testVolumeName + ' should be listed');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
                }

                t.end();
            });
        });

    if (mod_testVolumes.nfsSharedVolumesSupported() && VOLAPI_CLIENT) {
        tt.test('getting first created volume\'s UUID should succeed',
            function (t) {
                VOLAPI_CLIENT.listVolumes({
                    name: testVolumeName,
                    predicate: JSON.stringify({
                        eq: ['state', 'ready']
                    })
                }, function volumesListed(err, volumes) {
                    t.ifErr(err, 'list volumes should not error');
                    t.equal(volumes.length, 1, 'only one volume with name '
                        + testVolumeName + ' should be in state \'ready\'');
                    firstVolumeUuid = volumes[0].uuid;

                    t.end();
                });
            });
    }

    tt.test('removing volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            cli.rmVolume({args: testVolumeName},
                function onVolumeDeleted(err, stdout, stderr) {
                    var dockerVolumeOutput;
                    if (mod_testVolumes.nfsSharedVolumesSupported()) {
                        dockerVolumeOutput = stdout;
                        if (mod_testVolumes.dockerVolumeRmUsesStderr()) {
                            dockerVolumeOutput = stderr;
                        }

                        t.ifErr(err,
                            'Removing an existing shared volume should not '
                                + 'error');
                        t.equal(dockerVolumeOutput, testVolumeName + '\n',
                            'Output should be shared volume\'s name');
                    } else {
                        t.ok(errorMeansNFSSharedVolumeSupportDisabled(err,
                            stderr));
                    }

                    t.end();
                });
        });

    tt.test('listing volumes should output no volume with name: '
        + testVolumeName, function (t) {
            cli.listVolumes({}, function onVolumesListed(err, stdout, stderr) {
                var outputLines;
                var testVolumes;

                if (mod_testVolumes.nfsSharedVolumesSupported()) {
                    t.ifErr(err, 'listing volumes should not error');
                    outputLines = stdout.trim().split(/\n/);
                    // Remove header from docker volume ls' output.
                    outputLines = outputLines.slice(1);

                    testVolumes = outputLines.filter(filterTestVolumesFn);

                    t.equal(testVolumes.length, 0, 'no volume with name '
                        + testVolumeName + ' should be listed');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
                }

                t.end();
            });
        });

    tt.test('creating second volume with name ' + testVolumeName + ' should '
        + 'succeed', function (t) {
            createTestVolume({
                name: testVolumeName
            }, function volumeCreated(err, stdout, stderr) {
                if (mod_testVolumes.nfsSharedVolumesSupported()) {
                    t.ifErr(err,
                        'volume should have been created successfully');
                    t.equal(stdout, testVolumeName + '\n',
                        'output is newly created volume\'s name');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
                }

                t.end();
            });
        }
    );

    if (mod_testVolumes.nfsSharedVolumesSupported() && VOLAPI_CLIENT) {
        tt.test('getting second created volume\'s UUID should succeed',
            function (t) {
                VOLAPI_CLIENT.listVolumes({
                    name: testVolumeName,
                    predicate: JSON.stringify({
                        eq: ['state', 'ready']
                    })
                }, function volumesListed(err, volumes) {
                    var volumeUuid;

                    t.ifErr(err, 'list volumes should not error');
                    t.equal(volumes.length, 1, 'only one volume with name '
                        + testVolumeName + ' should be in state \'ready\'');

                    volumeUuid = volumes[0].uuid;
                    t.notEqual(volumeUuid, firstVolumeUuid,
                        'UUID of volume with name ' + testVolumeName
                            + ' should be different than the first created '
                            + 'volume ('+ firstVolumeUuid + ')');
                    t.end();
                });
            });
    }

    tt.test('listing volumes with name ' + testVolumeName + ' after second '
        + 'volume created should output only one volume', function (t) {
            cli.listVolumes({}, function onVolumesListed(err, stdout, stderr) {
                var outputLines;
                var testVolumes;

                if (mod_testVolumes.nfsSharedVolumesSupported()) {
                    t.ifErr(err, 'listing volumes should not error');
                    outputLines = stdout.trim().split(/\n/);
                    // Remove header from docker volume ls' output.
                    outputLines = outputLines.slice(1);

                    testVolumes = outputLines.filter(filterTestVolumesFn);

                    t.equal(testVolumes.length, 1, 'only one volume with name '
                        + testVolumeName + ' should be listed');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
                }

                t.end();
            });
        });

    tt.test('removing second volume with name ' + testVolumeName + ' should '
        + 'succeed', function (t) {
            cli.rmVolume({args: testVolumeName},
                function onVolumeDeleted(err, stdout, stderr) {
                    var dockerVolumeOutput;

                    if (mod_testVolumes.nfsSharedVolumesSupported()) {
                        dockerVolumeOutput = stdout;
                        if (mod_testVolumes.dockerVolumeRmUsesStderr()) {
                            dockerVolumeOutput = stderr;
                        }

                        t.ifErr(err,
                            'Removing an existing shared volume should not '
                                + 'error');
                        t.equal(dockerVolumeOutput, testVolumeName + '\n',
                            'Output should be shared volume\'s name');
                    } else {
                        t.ok(errorMeansNFSSharedVolumeSupportDisabled(err,
                            stderr));
                    }

                    t.end();
                });
        });

    tt.test('listing volumes should output no volume with name after second '
        + 'volume with name ' + testVolumeName + ' is deleted: ', function (t) {
            cli.listVolumes({}, function onVolumesListed(err, stdout, stderr) {
                var outputLines;
                var testVolumes;

                if (mod_testVolumes.nfsSharedVolumesSupported()) {
                    t.ifErr(err, 'listing volumes should not error');
                    outputLines = stdout.trim().split(/\n/);
                    // Remove header from docker volume ls' output.
                    outputLines = outputLines.slice(1);

                    testVolumes = outputLines.filter(filterTestVolumesFn);

                    t.equal(testVolumes.length, 0, 'no volume with name '
                        + testVolumeName + ' should be listed');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
                }

                t.end();
            });
        });
});