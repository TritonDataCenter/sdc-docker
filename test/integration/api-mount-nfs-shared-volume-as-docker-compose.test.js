/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Integration test for https://smartos.org/bugview/DOCKER-911. Ideally, this
 * should be a CLI integration test using the real docker-compose CLI program,
 * but at the time this test was written, using docker-compose in integration
 * tests wasn't supported (see https://smartos.org/bugview/DOCKER-916). As a
 * result, this test was written to use Docker's engine's API the same way that
 * the docker-compose CLI uses it when mounting NFS shared volumes. Hopefully,
 * when support for using docker-compose in integration tests lands, this can be
 * rewritten as a CLI integration test.
 */


var mod_testVolumes = require('../lib/volumes');
if (!mod_testVolumes.nfsSharedVolumesSupported()) {
    console.log('Skipping test since docker volumes are not supported by this '
        + 'installation of Triton');
    process.exit(0);
}

var jsprim = require('jsprim');
var test = require('tape');

var common = require('../lib/common');
var dockerTestHelpers = require('./helpers');
var volumesApi = require('../lib/volumes-api');

var ALICE_ACCOUNT;
var ALICE_DOCKER_API_CLIENT;
var VMAPI_CLIENT;

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

});

test('mounting volume as docker-compose', function (tt) {
    var testVolumeName =
        common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);
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

                t.end();
            });
        }
    );

    tt.test('mounting volume ' + testVolumeName + ' with payload similar to '
        + 'docker-compose should succeed', function (t) {
        var volumesPayload = {};
        var volumeMountPoint = '/data';

        volumesPayload[volumeMountPoint] = {};

        dockerTestHelpers.createDockerContainer({
            imageName: 'busybox:latest',
            dockerClient: ALICE_DOCKER_API_CLIENT,
            vmapiClient: VMAPI_CLIENT,
            test: t,
            extra: {
                Volumes: volumesPayload,
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
