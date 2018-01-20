/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

var libuuid = require('libuuid');
var vasync = require('vasync');

var mod_testVolumes = require('../lib/volumes');
var testHelpers = require('./helpers');
var volumesApi = require('../lib/volumes-api');

var ALICE;
var DOCKER_ALICE;
var NAPI_CLIENT;
var STATE = {
    log: require('../lib/log')
};
var TEST_VOLUME_NAMES_PREFIX = 'sdc-docker-test-api-volume-networks';
var VMAPI_CLIENT;

var test = mod_testVolumes.createTestFunc({
    checkTritonSupportsNfsVols: true
});

test('setup', function (tt) {

    tt.test('docker env', function (t) {
        testHelpers.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        testHelpers.createDockerRemoteClient({
            user: ALICE
        }, function (err, client) {
            t.ifErr(err, 'docker client init for alice');

            DOCKER_ALICE = client;

            t.end();
        });
    });

    tt.test('vmapi client init', function (t) {
        testHelpers.createVmapiClient(function (err, client) {
            t.ifErr(err, 'vmapi client');
            VMAPI_CLIENT = client;
            t.end();
        });
    });


    tt.test('napi client init', function (t) {
        testHelpers.createNapiClient(function (err, napiClient) {
            t.ifErr(err, 'napi client');
            NAPI_CLIENT = napiClient;
            t.end();
        });
    });
});

test('api: attach containers to volumes on different networks', function (tt) {
    var fabricVlanId = 4;
    var fabricNetworkName = 'sdcdockertest_nfsvolumenetworks_net1';

    tt.test('create test VLAN', function (t) {
        var vlanParams = {
            name: 'sdcdockertest_nfsvolumenetworks_vlan4',
            description: 'sdc-docker nfs volume networks test fixture',
            vlan_id: fabricVlanId
        };

        testHelpers.getOrCreateFabricVLAN(NAPI_CLIENT,
            ALICE.account.uuid, vlanParams,
            function vlanCreated(vlanCreateErr, vlan) {
                t.ifErr(vlanCreateErr, 'createing fabric vlan should succeed');
                t.end();
            }
        );
    });

    tt.test('create non-default fabric network', function (t) {
        var fabricParams = {
            name: fabricNetworkName,
            subnet: '10.0.42.0/24',
            provision_start_ip: '10.0.42.2',
            provision_end_ip: '10.0.42.254',
            uuid: libuuid.create(),
            gateway: '10.0.42.1',
            resolvers: ['8.8.8.8']
        };

        testHelpers.getOrCreateFabricNetwork(NAPI_CLIENT,
            ALICE.account.uuid, fabricVlanId, fabricParams,
            function onFabricCreated(fabCreateErr) {
                t.ifErr(fabCreateErr, 'creating fabric network should succeed');
                t.end();
            });
    });

    tt.test('docker container on default fabric, volume on non-default fabric',
        function (t) {
            var volumeName = TEST_VOLUME_NAMES_PREFIX + '-' + libuuid.create();

            vasync.pipeline({funcs: [
                function createVol(_, next) {
                    volumesApi.createDockerVolume({
                        dockerClient: DOCKER_ALICE,
                        name: volumeName,
                        network: fabricNetworkName
                    }, function onVolCreated(volCreateErr) {
                        t.ifErr(volCreateErr, 'volume creation should succeed');
                        next(volCreateErr);
                    });
                },
                function createContainer(_, next) {
                    testHelpers.createDockerContainer({
                        dockerClient: DOCKER_ALICE,
                        expectedErr: /Volumes not reachable from container/,
                        extra: {
                            Binds: [volumeName + ':/data'],
                            Cmd: ['/bin/sh', '-c', 'touch', '/data/foo']
                        },
                        imageName: 'busybox',
                        start: true,
                        test: t,
                        vmapiClient: VMAPI_CLIENT,
                        wait: true
                    }, function onContainerCreated(containerCreateErr) {
                        t.ok(containerCreateErr,
                            'container creation should fail');
                        next();
                    });
                },
                function deleteVolume(ctx, next) {
                    volumesApi.deleteDockerVolume({
                        dockerClient: DOCKER_ALICE,
                        name: volumeName
                    }, function onDelVolume(delErr) {
                        t.ifErr(delErr, 'deleting volume should succeed');
                        next();
                    });
                }
            ]}, function allDone(err) {
                t.end();
            });
    });

    tt.test('docker container on non-default fabric, volume on default fabric',
        function (t) {
            var volumeName = TEST_VOLUME_NAMES_PREFIX + '-' + libuuid.create();

            vasync.pipeline({funcs: [
                function createVol(_, next) {
                    volumesApi.createDockerVolume({
                        dockerClient: DOCKER_ALICE,
                        name: volumeName
                    }, function onVolCreated(volCreateErr) {
                        t.ifErr(volCreateErr, 'volume creation should succeed');
                        next(volCreateErr);
                    });
                },
                function createContainer(_, next) {
                    testHelpers.createDockerContainer({
                        dockerClient: DOCKER_ALICE,
                        expectedErr: /Volumes not reachable from container/,
                        extra: {
                            Binds: [volumeName + ':/data'],
                            Cmd: ['/bin/sh', '-c', 'touch', '/data/foo'],
                            'HostConfig.NetworkMode': fabricNetworkName
                        },
                        imageName: 'busybox',
                        start: true,
                        test: t,
                        vmapiClient: VMAPI_CLIENT,
                        wait: true
                    }, function onContainerCreated(containerCreateErr) {
                        t.ok(containerCreateErr,
                            'container creation should fail');
                        next();
                    });
                },
                function deleteVolume(ctx, next) {
                    volumesApi.deleteDockerVolume({
                        dockerClient: DOCKER_ALICE,
                        name: volumeName
                    }, function onDelVolume(delErr) {
                        t.ifErr(delErr, 'deleting volume should succeed');
                        next();
                    });
                }
            ]}, function allDone(err) {
                t.end();
            });
    });

    tt.test('docker container on non-default fabric, volume on same '
        + 'non-default fabric',
        function (t) {
            var volumeName = TEST_VOLUME_NAMES_PREFIX + '-' + libuuid.create();

            vasync.pipeline({arg: {}, funcs: [
                function createVol(ctx, next) {
                    volumesApi.createDockerVolume({
                        dockerClient: DOCKER_ALICE,
                        name: volumeName,
                        network: fabricNetworkName
                    }, function onVolCreated(volCreateErr) {
                        t.ifErr(volCreateErr, 'volume creation should succeed');
                        next(volCreateErr);
                    });
                },
                function createContainer(ctx, next) {
                    testHelpers.createDockerContainer({
                        dockerClient: DOCKER_ALICE,
                        extra: {
                            Binds: [volumeName + ':/data'],
                            Cmd: ['/bin/sh', '-c', 'touch', '/data/foo'],
                            'HostConfig.NetworkMode': fabricNetworkName
                        },
                        imageName: 'busybox',
                        start: true,
                        test: t,
                        vmapiClient: VMAPI_CLIENT,
                        wait: true
                    }, function onCreated(containerCreateErr, container) {
                        t.ifErr(containerCreateErr,
                            'container creation should succeed');
                        ctx.container = container;
                        next();
                    });
                },
                function deleteContainer(ctx, next) {
                    if (!ctx.container) {
                        next();
                        return;
                    }

                    DOCKER_ALICE.del('/containers/' + ctx.container.id,
                        function onContainerDeleted(delErr) {
                            t.ifErr(delErr,
                                'container should be deleted succesfully');
                            next();
                        });
                },
                function deleteVolume(ctx, next) {
                    volumesApi.deleteDockerVolume({
                        dockerClient: DOCKER_ALICE,
                        name: volumeName
                    }, function onDelVolume(delErr) {
                        t.ifErr(delErr, 'deleting volume should succeed');
                        next();
                    });
                }
            ]}, function allDone(err) {
                t.end();
            });
    });
});