/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');

var cli = require('../lib/cli');
var common = require('../lib/common');
var log = require('../lib/log');
var mod_testVolumes = require('../lib/volumes');
var mod_testVolumesCli = require('../lib/volumes-cli');

var createTestVolume = mod_testVolumesCli.createTestVolume;
var test = mod_testVolumes.createTestFunc({
    checkTritonSupportsNfsVols: true,
    checkDockerClientSupportsNfsVols: true
});

var NFS_SHARED_VOLUMES_DRIVER_NAME =
    mod_testVolumes.getNfsSharedVolumesDriverName();
var NFS_SHARED_VOLUME_NAMES_PREFIX =
    mod_testVolumes.getNfsSharedVolumesNamePrefix();

var MOUNTING_CONTAINER_NAMES_PREFIX =
    'test-nfs-mounting-container-volume-in-use';

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

test('Volume ls using dangling filter', function (tt) {
    var testVolumeName =
        common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
    var containerName =
        common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);

    tt.test('creating volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            createTestVolume(ALICE_USER, {
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

    tt.test('mounting the newly created volume from a container should succeed',
        function (t) {
            cli.run(t, {
                args: '--name ' + containerName + ' -v ' + testVolumeName
                    + ':/data busybox:latest /bin/sh -c '
                    + '"touch /data/foo.txt && ls /data"'
            }, function onContainerRun(err, output) {
                t.ifErr(err, 'Mounting a valid volume should not error');
                t.equal(output.stdout, 'foo.txt\n', 'Output should equal '
                    + 'newly created container\'s name');
                t.end();
            });
        });

    tt.test('listing volumes using --filter dangling=true should NOT include '
        + 'the volume', function (t) {
        mod_testVolumesCli.listVolumes({
                user: ALICE_USER,
                args: '--filter dangling=true'
            }, function onVolumesListed(volListErr, stdout, stderr) {
                t.equal(stdout.indexOf(testVolumeName), -1,
                    'newly created and mounted test volume ' + testVolumeName
                        + ' should not be included in docker volume ls '
                        + '--filter dangling=true output, got: ' + stdout);
                t.end();
            });
    });

    tt.test('listing volumes using --filter dangling=false should include the '
        + 'volume', function (t) {
        mod_testVolumesCli.listVolumes({
                user: ALICE_USER,
                args: '--filter dangling=false'
            }, function onVolumesListed(volListErr, stdout, stderr) {
                t.notEqual(stdout.indexOf(testVolumeName), -1,
                    'newly created and mounted test volume ' + testVolumeName
                        + ' should be included in docker volume ls --filter '
                        + 'dangling=false output, got: ' + stdout);
                t.end();
            });
    });

    tt.test('listing volumes using no filter should include the volume',
        function (t) {
        mod_testVolumesCli.listVolumes({
                user: ALICE_USER
            }, function onVolumesListed(volListErr, stdout, stderr) {
                t.notEqual(stdout.indexOf(testVolumeName), -1,
                    'newly created and mounted test volume ' + testVolumeName
                        + ' should be included in docker volume ls output, '
                        + 'got: ' + stdout);
                t.end();
            });
    });

    tt.test('removing container mounting volume should succeed', function (t) {
        cli.rm(t, {args: containerName},
            function onContainerDeleted(err, stdout, stderr) {
                t.ifErr(err,
                    'deleting container mounting NFS shared volume '
                        + 'should succeed');
                t.end();
            });
    });


    tt.test('listing volumes using --filter dangling=true should include the '
        + 'volume', function (t) {
        mod_testVolumesCli.listVolumes({
                user: ALICE_USER,
                args: '--filter dangling=true'
            }, function onVolumesListed(volListErr, stdout, stderr) {
                t.notEqual(stdout.indexOf(testVolumeName), -1,
                    'newly created and mounted test volume ' + testVolumeName
                        + ' should be included in docker volume ls '
                        + '--filter dangling=true output after its last '
                        + 'mounting container was removed, got: ' + stdout);
                t.end();
            });
    });

    tt.test('listing volumes using --filter dangling=false should not include '
        + 'the volume', function (t) {
        mod_testVolumesCli.listVolumes({
                user: ALICE_USER,
                args: '--filter dangling=false'
            }, function onVolumesListed(volListErr, stdout, stderr) {
                t.equal(stdout.indexOf(testVolumeName), -1,
                    'newly created and mounted test volume ' + testVolumeName
                        + ' should NOT be included in docker volume ls '
                        + '--filter  dangling=false output after its last '
                        + 'mounting container was removed, got: ' + stdout);
                t.end();
            });
    });

    tt.test('listing volumes using no filter should include the volume',
        function (t) {
        mod_testVolumesCli.listVolumes({
                user: ALICE_USER
            }, function onVolumesListed(volListErr, stdout, stderr) {
                t.notEqual(stdout.indexOf(testVolumeName), -1,
                    'newly created and mounted test volume ' + testVolumeName
                        + ' should be included in docker volume ls output, '
                        + 'got: ' + stdout);
                t.end();
            });
    });

    tt.test('after deleting mounting container, deleting volume should succeed',
        function (t) {
            mod_testVolumesCli.rmVolume({
                user: ALICE_USER,
                args: testVolumeName
            }, function onVolumeDeleted(err, stdout, stderr) {
                var dockerVolumeOutput = stdout;

                t.ifErr(err,
                    'Removing an existing shared volume not in use should '
                        + 'succeed');
                t.equal(dockerVolumeOutput, testVolumeName + '\n',
                    'Output should be volume\'s name: ' + testVolumeName);

                t.end();
            });
        });
});
