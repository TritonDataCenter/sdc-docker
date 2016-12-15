/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
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
var IMAGE_WITH_LOCAL_VOLUME_NAME = 'joyentunsupported/image-with-local-volume';

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
    tt.test('pull ' + IMAGE_WITH_LOCAL_VOLUME_NAME + ' image', function (t) {
        cli.pull(t, {
            image: IMAGE_WITH_LOCAL_VOLUME_NAME
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

test('mounting NFS shared volume at same mountpoint as local volume should '
    + 'override it', function (tt) {
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
                    + ':/data/some-volume ' + IMAGE_WITH_LOCAL_VOLUME_NAME
                    + ' /bin/sh -c '
                    + '"touch /data/some-volume/foo.txt && ls '
                    + '/data/some-volume"'
            }, function onContainerRun(err, output) {
                t.ifErr(err, 'Mounting a valid volume should not error');
                t.equal(output.stdout, 'foo.txt\n', 'Output should equal '
                    + 'file name from volume, not from image');
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
