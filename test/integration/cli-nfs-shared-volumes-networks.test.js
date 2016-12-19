/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var configLoader = require('../../lib/config-loader');
var helpers = require('./helpers');
var testVolumes = require('../lib/volumes');
var ufds = require('../../lib/ufds');
var volumesCli = require('../lib/volumes-cli');

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

var ALICE_USER;
var DEFAULT_FABRIC_NETWORK_UUID;

var LOG = bunyan.createLogger({
    name: 'test-volumes-networks',
    level: 'error'
});

var CONFIG = configLoader.loadConfigSync({log: LOG});

var DC = CONFIG.datacenterName;

var NAPI;
var UFDS;
var VMAPI;
var VOLAPI;

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, function onCliInit(err, env) {
            t.ifErr(err, 'Docker environment initialization should not err');
            if (env) {
                ALICE_USER = env.user;
            }
        });
    });

    tt.test('vmapi client init', function (t) {
        helpers.createVmapiClient(function (err, client) {
            t.ifErr(err, 'vmapi client');
            VMAPI = client;
            t.end();
        });
    });

    tt.test('napi client init', function (t) {
        helpers.createNapiClient(function (err, client) {
            t.ifErr(err, 'napi client');
            NAPI = client;
            t.end();
        });
    });

    tt.test('volapi client init', function (t) {
        helpers.createVolapiClient(function (err, client) {
            t.ifErr(err, 'volapi client');
            VOLAPI = client;
            t.end();
        });
    });

    tt.test('ufds client init', function (t) {
        var ufdsOptions = jsprim.deepCopy(CONFIG.ufds);
        ufdsOptions.log = LOG;

        ufds.createUfdsClient(ufdsOptions, function (err, ufdsClient) {
            UFDS = ufdsClient;

            t.ifErr(err, 'creating UFDS client should succeed');
            t.end();
        });
    });

    tt.test('retrieving default fabric network should be successful',
        function (t) {
        UFDS.getDcLocalConfig(ALICE_USER.account.uuid, DC,
            function (getDcConfigErr, conf) {
                if (getDcConfigErr || !conf || !conf.defaultnetwork) {
                    t.ok(false, 'Networks: could not get default network, err: '
                        + getDcConfigErr + ', config: ' + conf);
                } else {
                    DEFAULT_FABRIC_NETWORK_UUID = conf.defaultnetwork;
                    t.ok(true, 'Got default network');
                }

                t.end();
            });
    });

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

test('docker volume create uses default fabric network by default',
    function (tt) {
    var volumeName;
    var storageVmUuid;
    var storageVmNics;

    tt.test('creating volume with default network should succeed',
        function (t) {
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
                            'volume with name ' + volumeName + ' should have '
                                + 'been created successfully');
                        t.equal(stdout, volumeName + '\n',
                            'output is newly created volume\'s name ('
                                + volumeName + ')');
                    } else {
                        t.ok(errorMeansNFSSharedVolumeSupportDisabled(err,
                            stderr));
                    }

                    next(err);
                });
            },
            function getVolumeStorageVm(_, next) {
                if (!NFS_SHARED_VOLUMES_SUPPORTED) {
                    next();
                    return;
                }

                VOLAPI.listVolumes({
                    owner_uuid: ALICE_USER.account.uuid,
                    name: volumeName
                }, function onListVolumes(listVolumesErr, volumes) {
                    t.ifErr(listVolumesErr, 'listing volumes should not error');
                    t.ok(volumes,
                        'found volumes matching name of newly created volume');
                    t.equal(volumes.length, 1,
                        'found only one volume matching name of newly created '
                            + 'volume');

                    if (volumes) {
                        storageVmUuid = volumes[0].vm_uuid;
                    }

                    next(listVolumesErr);
                });
            },
            function getStorageVmNetwork(_, next) {
                if (!NFS_SHARED_VOLUMES_SUPPORTED) {
                    next();
                    return;
                }

                if (!storageVmUuid) {
                    next();
                    return;
                }

                assert.string(storageVmUuid, 'storageVmUuid');

                VMAPI.getVm({
                    uuid: storageVmUuid
                }, function onGetStorageVm(getVmErr, storageVm) {
                    var vmUsesDefaultFabricNetwork = false;

                    if (storageVm) {
                        storageVmNics = storageVm.nics;
                    }

                    if (storageVmNics) {
                        storageVmNics.forEach(function isDefaultFabricNet(nic) {
                            if (nic.network_uuid ===
                                DEFAULT_FABRIC_NETWORK_UUID) {
                                vmUsesDefaultFabricNetwork = true;
                            }
                        });
                    }

                    t.ok(vmUsesDefaultFabricNetwork,
                        'storage VM should use default fabric network');
                    next(getVmErr);
                });
            }
        ]}, function allDone(err) {
            volumesCli.rmVolume({
                user: ALICE_USER,
                args: volumeName
            }, function onVolumeDeleted(delVolumeErr, stdout, stderr) {
                var dockerVolumeOutput = stdout;

                t.ifErr(delVolumeErr,
                    'Removing an existing shared volume should not error');
                t.equal(dockerVolumeOutput, volumeName + '\n',
                    'Output should be shared volume\'s name');
                t.end();
            });
        });
    });
});

test('docker volume create using non-default network uses non-default network',
    function (tt) {
    var NEW_FABRIC_NETWORK_NAME =
        common.makeResourceName('sdc-docker-test-volumes');
    var newFabricNetwork;
    var FABRIC_VLAN_ID = 2;
    var fabricNetworkParams = {
        name: NEW_FABRIC_NETWORK_NAME,
        subnet: '192.168.42.0/24',
        provision_start_ip: '192.168.42.1',
        provision_end_ip: '192.168.42.254',
        gateway: '192.168.42.1',
        resolvers: '8.8.8.8,8.8.4.4',
        mtu: 1400,
        /*
         * This avoids creating a NAT zone for the newly created network, and
         * makes cleaning up resources tied to this network easier.
         */
        internet_nat: false
    };
    var volumeName;
    var storageVmUuid;
    var storageVmNics;

    tt.test('creating new fabric network should succeed', function (t) {
        NAPI.createFabricNetwork(ALICE_USER.account.uuid, FABRIC_VLAN_ID,
            fabricNetworkParams,
            function onFabricNetworkCreated(creationErr, fabricNetwork) {
                t.ifErr(creationErr,
                    'creating new fabric network should succeed');
                newFabricNetwork = fabricNetwork;

                t.end();
            });
    });

    tt.test('creating volume with non-default network should succeed',
        function (t) {
        volumeName =
            common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);

        vasync.pipeline({funcs: [
            function createVolume(_, next) {
                volumesCli.createVolume({
                    user: ALICE_USER,
                    args: '--name ' + volumeName + ' --opt network='
                        + NEW_FABRIC_NETWORK_NAME
                }, function onVolumeCreated(err, stdout, stderr) {
                    if (NFS_SHARED_VOLUMES_SUPPORTED) {
                        t.ifErr(err,
                            'volume with name ' + volumeName + ' should have '
                                + 'been created successfully');
                        t.equal(stdout, volumeName + '\n',
                            'output is newly created volume\'s name ('
                                + volumeName + ')');
                    } else {
                        t.ok(errorMeansNFSSharedVolumeSupportDisabled(err,
                            stderr));
                    }

                    next(err);
                });
            },
            function getVolumeStorageVm(_, next) {
                if (!NFS_SHARED_VOLUMES_SUPPORTED) {
                    next();
                    return;
                }

                VOLAPI.listVolumes({
                    owner_uuid: ALICE_USER.account.uuid,
                    name: volumeName
                }, function onListVolumes(listVolumesErr, volumes) {
                    t.ifErr(listVolumesErr, 'listing volumes should not error');
                    t.ok(volumes,
                        'found volumes matching name of newly created volume');
                    t.equal(volumes.length, 1,
                        'found only one volume matching name of newly created '
                            + 'volume');

                    if (volumes) {
                        storageVmUuid = volumes[0].vm_uuid;
                    }

                    next(listVolumesErr);
                });
            },
            function getStorageVmNetwork(_, next) {
                if (!NFS_SHARED_VOLUMES_SUPPORTED) {
                    next();
                    return;
                }

                if (!storageVmUuid) {
                    next();
                    return;
                }

                assert.string(storageVmUuid, 'storageVmUuid');

                VMAPI.getVm({
                    uuid: storageVmUuid
                }, function onGetStorageVm(getVmErr, storageVm) {
                    var vmUsesNewFabricNetwork = false;
                    if (storageVm) {
                        storageVmNics = storageVm.nics;
                    }

                    if (storageVmNics) {
                        storageVmNics.forEach(function isDefaultFabricNet(nic) {
                            if (nic.network_uuid ===
                                newFabricNetwork.uuid) {
                                vmUsesNewFabricNetwork = true;
                            }
                        });
                    }

                    t.ok(vmUsesNewFabricNetwork,
                        'storage VM should use new fabric network');
                    next(getVmErr);
                });
            }
        ]}, function allDone(err) {
            volumesCli.rmVolume({
                user: ALICE_USER,
                args: volumeName
            }, function onVolumeDeleted(delVolumeErr, stdout, stderr) {
                var dockerVolumeOutput = stdout;

                t.ifErr(delVolumeErr,
                    'Removing an existing shared volume should not error');
                t.equal(dockerVolumeOutput, volumeName + '\n',
                    'Output should be shared volume\'s name');
                t.end();
            });
        });
    });

    tt.test('deleting new fabric network should succeed', function (t) {
        NAPI.deleteFabricNetwork(ALICE_USER.account.uuid, FABRIC_VLAN_ID,
            newFabricNetwork.uuid, fabricNetworkParams,
            function onFabricNetworkDeleted(fabricNetworkDelErr) {
                t.ifErr(fabricNetworkDelErr,
                    'deleting new fabric network should succeed');
                t.end();
            });
    });

});

test('docker volume create using non-existent network should fail',
    function (tt) {
        var volumeName;

        tt.test('volume creation should fail', function (t) {
            volumeName =
                common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);

            volumesCli.createVolume({
                user: ALICE_USER,
                args: '--name ' + volumeName
                    + ' --opt network=non-existent-network'
            }, function onVolumeCreated(err, stdout, stderr) {
                if (NFS_SHARED_VOLUMES_SUPPORTED) {
                    t.ok(err,
                        'volume with name ' + volumeName + ' should not have '
                            + 'been created successfully');
                } else {
                    t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr));
                }

                t.end();
            });
        });
    });

test('teardown', function (tt) {
    tt.test('closing UFDS client connection', function (t) {
        UFDS.close(function onClientClosed(clientCloseErr) {
            t.ifErr(clientCloseErr, 'Closing UFDS client should not error');
            t.end();
        });
    });
});