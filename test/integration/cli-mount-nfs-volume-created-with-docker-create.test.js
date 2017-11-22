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

var cli = require('../lib/cli');
var common = require('../lib/common');
var testVolumes = require('../lib/volumes');
var volumesCli = require('../lib/volumes-cli');

var test = testVolumes.createTestFunc({
    checkTritonSupportsNfsVols: true,
    checkDockerClientSupportsNfsVols: true
});

var NFS_SHARED_VOLUME_NAMES_PREFIX =
    testVolumes.getNfsSharedVolumesNamePrefix();

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

test('docker volume created with docker create', function (tt) {
    var containerName;
    var volumeName;

    tt.test('creating volume should succeed', function (t) {
        volumeName =
            common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
        containerName =
            common.makeResourceName(MOUNTING_CONTAINER_NAMES_PREFIX);

        vasync.pipeline({arg: {}, funcs: [
            function createVolume(ctx, next) {
                cli.create(t, {
                    args: '--name ' + containerName + ' -v ' + volumeName
                        + ':/data busybox:latest /bin/sh -c '
                        + '"touch /data/foo.txt && ls /data"'
                }, function onContainerRun(err, output) {
                    t.ifErr(err,
                        'Creating a volume via docker create -v should not '
                            + 'error');
                    next();
                });
            },
            function checkVolumeExists(ctx, next) {
                var volumes;

                volumesCli.inspectVolume({
                    user: ALICE_USER,
                    args: volumeName
                }, function onInspectedVol(inspectErr, stdout, stderr) {
                    t.ifErr(inspectErr, 'volume inspect should not error');

                    if (!inspectErr) {
                        try {
                            volumes = JSON.parse(stdout);
                        } catch (volParseErr) {
                            t.ifErr(volParseErr,
                                'volume inspect\'s output should be valid '
                                    + 'JSON');
                        }
                    }

                    if (volumes) {
                        t.equal(volumes.length, 1,
                            'volume inspect should return only 1 volume');
                        t.equal(volumes[0].Name, volumeName,
                            'inspected volume\'s name should be: '
                                + volumeName);
                    } else {
                        t.ok(false, 'volume inspect should return 1 volume');
                    }

                    next();
                });
            }
        ]}, function onDone(err) {
            t.end();
        });
    });

    tt.test('starting container should mount volume successfully',
        function (t) {
        cli.start(t, {
                args: '-a -i ' + containerName
            }, function onContainerStart(err, stdout, stderr) {
                t.ifErr(err,
                    'Mounting a valid volume via docker start should not '
                        + 'error');
                t.equal(stdout, 'foo.txt\n', 'Output should equal '
                    + 'file name created in mounted volume');
                t.end();
            });
    });

    tt.test('deleting mounting container', function (t) {
        cli.rm(t, {args: containerName}, function onContainerDeleted(err) {
            t.ifErr(err, 'deleting container ' + containerName
                + ' should not error');
            t.end();
        });
    });

    tt.test('deleting volume', function (t) {
        volumesCli.rmVolume({
            user: ALICE_USER,
            t: t,
            args: volumeName
        }, function onVolumeDeleted(err, stdout, stderr) {
            t.ifErr(err, 'deleting volume ' + volumeName + ' should not error');
            t.end();
        });
    });
});
