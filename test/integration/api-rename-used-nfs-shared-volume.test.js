/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

/*
 * Integration test for https://smartos.org/bugview/VOLAPI-42.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../lib/common');
var dockerTestHelpers = require('./helpers');
var mod_testVolumes = require('../lib/volumes');
var volumesApi = require('../lib/volumes-api');

var test = mod_testVolumes.createTestFunc({
    checkTritonSupportsNfs: true
});

var ALICE_ACCOUNT;
var ALICE_DOCKER_API_CLIENT;
var VMAPI_CLIENT;
var VOLAPI_CLIENT;

var STATE = {
    log: require('../lib/log')
};

var NFS_SHARED_VOLUME_NAMES_PREFIX =
    mod_testVolumes.getNfsSharedVolumesNamePrefix();

test('setup', function (tt) {

    tt.test('docker env', function (t) {
        dockerTestHelpers.getDockerEnv(t, STATE, {
            account: 'sdcdockertest_alice'
        }, function (err, env) {
            t.ifErr(err, 'docker env: alice');
            t.ok(env, 'have a DockerEnv for alice');

            ALICE_ACCOUNT = env;

            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        dockerTestHelpers.createDockerRemoteClient({
            user: ALICE_ACCOUNT
        }, function (err, client) {
            t.ifErr(err, 'docker client init');

            ALICE_DOCKER_API_CLIENT = client;

            t.end();
        });
    });

    tt.test('vmapi client init', function (t) {
        dockerTestHelpers.createVmapiClient(function (err, client) {
            t.ifErr(err, 'vmapi client');

            VMAPI_CLIENT = client;

            t.end();
        });
    });

    tt.test('volapi client init', function (t) {
        dockerTestHelpers.createVolapiClient(function (err, client) {
            t.ifErr(err, 'volapi client');

            VOLAPI_CLIENT = client;

            t.end();
        });
    });

});

test('renaming mounted volume', function (tt) {
    var testVolumeName =
        common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
    var testVolume;
    var mountingContainer;

    tt.test('creating volume with name ' + testVolumeName + ' should succeed',
        function (t) {
            volumesApi.createDockerVolume({
                dockerClient: ALICE_DOCKER_API_CLIENT,
                name: testVolumeName
            }, function volumeCreated(err, volume) {
                t.ifErr(err, 'creating volume with name ' + testVolumeName
                    + ' should not error');
                t.equal(volume.Name, testVolumeName,
                    'created volume name should be: ' + testVolumeName);

                testVolume = volume;

                t.end();
            });
        }
    );

    tt.test('mounting volume ' + testVolumeName + ' should succeed',
        function (t) {
        var volumeMountPoint = '/data';

        dockerTestHelpers.createDockerContainer({
            imageName: 'busybox:latest',
            dockerClient: ALICE_DOCKER_API_CLIENT,
            vmapiClient: VMAPI_CLIENT,
            test: t,
            extra: {
                'HostConfig.Binds': [testVolumeName + ':' + volumeMountPoint]
            },
            start: true,
            wait: true
        }, function onContainerCreated(err, response) {
            var expectedExitCode = 0;

            t.ifErr(err,
                'creating and starting mounting container should succeed');
            if (!err) {
                mountingContainer = response.inspect;
                t.equal(mountingContainer.State.ExitCode, expectedExitCode,
                    'exit code of mounting container should be: '
                        + expectedExitCode);
            }

            t.end();
        });
    });

    tt.test('attempting to rename mounted volume should fail', function (t) {
        var context = {};
        vasync.pipeline({funcs: [
            function getVolume(ctx, next) {
                VOLAPI_CLIENT.listVolumes({
                    owner_uuid: ALICE_ACCOUNT.account.uuid,
                    name: testVolumeName
                }, function onListVolumes(listVolumeErr, volumes) {
                    t.ok(!listVolumeErr, 'listing volumes should not error');
                    if (volumes && Array.isArray(volumes)) {
                        t.equal(volumes.length, 1,
                            'only one active volume with name '
                                + testVolumeName + ' should be listed');
                        testVolume = volumes[0];
                    } else {
                        t.ok(false, 'volumes should be an array');
                    }
                    next(listVolumeErr);
                });
            },
            function renameVolume(ctx, next) {
                assert.object(testVolume, 'testVolume');

                VOLAPI_CLIENT.updateVolume({
                    name: testVolumeName + '-renamed',
                    uuid: testVolume.uuid
                }, function onVolUpdated(volUpdateErr) {
                    var expectedErrCode = 'VolumeInUse';
                    var expectedErrMsg = 'Volume with name ' + testVolumeName
                        + ' is used';

                    t.ok(volUpdateErr, 'renaming mounting volume should fail');
                    t.equal(volUpdateErr.body.code, expectedErrCode,
                        'error code should be: ' + expectedErrCode);
                    t.equal(volUpdateErr.body.message, expectedErrMsg,
                        'error message should be: ' + expectedErrMsg);

                    next();
                });
            }
        ], arg: context}, function onVolumeRenamed(err) {
            t.end();
        });
    });

    tt.test('deleting newly created container should succeed', function (t) {
        if (mountingContainer !== undefined) {
            ALICE_DOCKER_API_CLIENT.del('/containers/'
                + mountingContainer.Id,
                function ondel(err, res, req, body) {
                    t.ifErr(err, 'removing container '
                        + mountingContainer.Id + ' should not err');

                    t.end();
                });
        } else {
            t.ok(false, 'no mounting container to delete because it was '
                + 'not created successfully');
            t.end();
        }
    });

    tt.test('attempting to rename mounted volume should succeed', function (t) {
        testVolumeName = testVolumeName + '-renamed';

        if (testVolume) {
            VOLAPI_CLIENT.updateVolume({
                name: testVolumeName,
                uuid: testVolume.uuid
            }, function onVolUpdated(volUpdateErr) {
                t.ok(!volUpdateErr, 'renaming mounting volume should succeed');
                t.end();
            });
        } else {
            t.ok(false, 'failed to get volume object');
            t.end();
        }
    });

    tt.test('deleting test volume with name ' + testVolumeName + 'should '
        + 'succeed', function (t) {
            ALICE_DOCKER_API_CLIENT.del('/volumes/' + testVolumeName,
                function onVolumeDeleted(err) {
                    t.ifErr(err, 'deleting volume with name ' + testVolumeName
                        + ' should not error');

                    t.end();
                });
    });
});
