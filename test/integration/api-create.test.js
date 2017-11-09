/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

/*
 * Integration tests for `docker create` using the Remote API directly.
 */

var assert = require('assert-plus');
var exec = require('child_process').exec;
var format = require('util').format;
var libuuid = require('libuuid');
var test = require('tape');
var util = require('util');
var vasync = require('vasync');

var configLoader = require('../../lib/config-loader.js');
var constants = require('../../lib/constants');

var h = require('./helpers');



// --- Globals
var BYTES_IN_MB = 1024 * 1024;
var ALICE;
var BOB;
var DOCKER_ALICE;
var DOCKER_ALICE_HTTP; // For sending non-JSON payload
var DOCKER_BOB;
var STATE = {
    log: require('../lib/log')
};
var CONFIG = configLoader.loadConfigSync({log: STATE.log});
var VMAPI;
var NAPI;
var FABRICS = false;


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;
            BOB   = accounts.bob;

            t.end();
        });
    });


    tt.test('docker client init', function (t) {
        vasync.parallel({ funcs: [
            function createAliceJson(done) {
                h.createDockerRemoteClient({user: ALICE},
                    function (err, client) {
                        t.ifErr(err, 'docker client init for alice');
                        done(err, client);
                    }
                );
            },
            function createBobJson(done) {
                h.createDockerRemoteClient({user: BOB},
                    function (err, client) {
                        t.ifErr(err, 'docker client init for bob');
                        return done(err, client);
                    }
                );
            },
            function createAliceHttp(done) {
                h.createDockerRemoteClient({user: ALICE, clientType: 'http'},
                    function (err, client) {
                        t.ifErr(err, 'docker client init for alice/http');
                        done(err, client);
                    }
                );
            }
        ]}, function allDone(err, results) {
            t.ifError(err, 'docker client init should be successful');
            DOCKER_ALICE = results.operations[0].result;
            DOCKER_BOB = results.operations[1].result;
            DOCKER_ALICE_HTTP = results.operations[2].result;
            t.end();
        });
    });


    tt.test('vmapi client init', function (t) {
        h.createVmapiClient(function (err, client) {
            t.ifErr(err, 'vmapi client');
            VMAPI = client;
            t.end();
        });
    });

    // init the napi client to create a fabric to test against.
    tt.test('napi client init', function (t) {
        h.createNapiClient(function (err, client) {
            t.ifErr(err, 'napi client');
            NAPI = client;
            t.end();
        });
    });

    tt.test('check if fabrics are enabled', function (t) {
        h.isFabricNetworkingEnabled(NAPI, ALICE.account,
            function (err, enabled) {
                t.ifErr(err, 'check isFabricNetworkingEnabled');
                FABRICS = enabled;
                t.end();
            }
        );
    });

    tt.test('pull nginx image', function (t) {
        h.ensureImage({
            name: 'nginx:latest',
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling image');
            t.end();
        });
    });
});

test('api: create with non-string label values (DOCKER-737)', function (t) {
    var payload = {
        // Boilerplate
        'Hostname': '',
        'Domainname': '',
        'User': '',
        'Memory': 0,
        'MemorySwap': 0,
        'CpuShares': 0,
        'Cpuset': '',
        'AttachStdin': false,
        'AttachStdout': false,
        'AttachStderr': false,
        'PortSpecs': null,
        'ExposedPorts': {},
        'Tty': false,
        'OpenStdin': false,
        'StdinOnce': false,
        'Env': [],
        'Cmd': null,
        'Image': 'nginx',
        'Volumes': {},
        'WorkingDir': '',
        'Entrypoint': null,
        'NetworkDisabled': false,
        'OnBuild': null,
        'SecurityOpt': null,
        'HostConfig': {
            'Binds': null,
            'ContainerIDFile': '',
            'LxcConf': [],
            'Privileged': false,
            'PortBindings': {},
            'Links': null,
            'PublishAllPorts': false,
            'Dns': null,
            'DnsSearch': null,
            'ExtraHosts': null,
            'VolumesFrom': null,
            'Devices': [],
            'NetworkMode': 'bridge',
            'CapAdd': null,
            'CapDrop': null,
            'RestartPolicy': {
                'Name': '',
                'MaximumRetryCount': 0
            }
        },

        // The interesting data we are actually testing in this test case:
        Labels: {
            foo: true,
            anum: 3.14
        }
    };
    var apiVersion = 'v' + constants.API_VERSION;
    DOCKER_ALICE.post(
        '/' + apiVersion + '/containers/create',
        payload,
        function (err, req, res) {
            t.ok(err, 'expect err from container create');
            /* JSSTYLED */
            var errRe = /^\(Validation\) invalid labels: label "foo" value is not a string: true; label "anum" value is not a string: 3.14/;
            t.ok(errRe.exec(err.message), format('err.message matches %s: %j',
                errRe, err.message));
            t.end();
        });
});


test('api: create', function (tt) {

    var created;

    tt.test('docker create', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

    tt.test('docker create without approved_for_provisioning', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_BOB,
            // we expect errors here, so stub this out
            test: {
                deepEqual: stub,
                equal: stub,
                error: stub,
                ok: stub
            }
        }, oncreate);

        function oncreate(err, result) {
            t.ok(err, 'should not create without approved_for_provisioning');
            t.equal(err.statusCode, 403);

            var expected = BOB.login + ' does not have permission to pull or '
                + 'provision';
            t.ok(err.message.match(expected));

            t.end();
        }

        function stub() {}
    });

    tt.test('docker create without memory override', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.equal(created.vm.ram, CONFIG.defaultMemory,
                    'VM with default memory specs should be created with '
                    + CONFIG.defaultMemory + ' MBs of RAM');
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

    tt.test('docker create with 2GB memory', function (t) {
        var MEMORY_IN_MBS = CONFIG.defaultMemory * 2;
        var memory = MEMORY_IN_MBS * BYTES_IN_MB;

        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.Memory': memory }
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.equal(created.vm.ram, MEMORY_IN_MBS,
                    'VM should be created with ' + MEMORY_IN_MBS
                    + 'MBs of RAM');
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

    tt.test('docker create with invalid memory',
            function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.Memory': 'Foo' }
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.equal(created.vm.ram, CONFIG.defaultMemory,
                    'VM should be created with ' + CONFIG.defaultMemory
                    + 'MBs of RAM');
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });
});


test('api: test DOCKER-741 and DOCKER-898', function (tt) {
    tt.test('create empty-env-var container', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'Env': ['ENV_NO_VALUE'] },
            start: true  // Will start the container after creating.
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create empty-env-var container');
            t.equal(result.vm.state, 'running', 'Check container running');

            if (err) {
                t.end();
                return;
            }

            checkForCnsDnsEntries(result);
        }

        function checkForCnsDnsEntries(result) {
            // Get the resolv.conf from the container.
            var opts = {
                dockerHttpClient: DOCKER_ALICE_HTTP,
                path: '/etc/resolv.conf',
                vmId: result.id
            };
            h.getFileContentFromContainer(opts, function (err, contents) {
                t.ifErr(err, 'Unable to fetch /etc/resolv.conf file');

                if (err) {
                    t.end();
                    return;
                }

                var hasCnsSearch = contents.match(/^search\s.*?\.cns\./m);
                t.ok(hasCnsSearch, 'find cns entry in /etc/resolv.conf');
                if (!hasCnsSearch) {
                    t.fail('cns not found in /etc/resolv.conf file contents: '
                        + contents);
                }

                DOCKER_ALICE.del('/containers/' + result.id + '?force=1',
                    ondelete);
            });
        }

        function ondelete(err) {
            t.ifErr(err, 'delete empty-env-var container');
            t.end();
        }
    });
});

/*
 * Tests for `docker run --net`
 *
 * Of particular interest is whether we can appropriately disambiguate the
 * user-supplied network name/id. The docker heuristic appears to be:
 * 1. exact id match
 * 2. exact name match
 * 3. any partial id match
 * See lib/backends/sdc/containers.js for implementation.
 */
/*
 * XXX - pending NAPI-258, we are creating NAT zones, a fabric vlan, and
 * several fabric networks that can't be easily cleaned up. They should
 * still be re-usable for repeated test runs, but particularly unlucky
 * partial failures in the tests *may* require some manual cleanup:
 * - delete NAT zones for ALICE & the fabric networks
 * - delete fabric networks
 * - delete fabric vlan
 */
test('create with NetworkMode (docker run --net=)', function (tt) {
    // set fabric status

    var fVlan;
    var fNetwork1;
    var fNetwork2;
    var fNetwork3;
    var nonFabricNetwork;

    if (!FABRICS) {
        tt.comment('Fabrics not enabled, skipping tests that require them.');
        tt.end();
        return;
    }

    tt.test('fabric vlan setup', function (t) {
        // create a new one.
        var fabricParams = {
            name: 'sdcdockertest_apicreate_vlan4',
            description: 'integration test fixture',
            vlan_id: 4
        };
        h.getOrCreateFabricVLAN(NAPI, ALICE.account.uuid, fabricParams,
            function (err, vlan) {
                t.ifErr(err, 'create fabric vlan');
                fVlan = vlan;
                t.end();
                return;
            }
        );
    });

    tt.test('fabric network setup', function (t) {
        var nw1uuid = libuuid.create();

        // nw2's name is deliberately ambiguous with a short version of nw1's
        // id. The exact name (nw2) should be preferred to the partial id.
        var nw2name = nw1uuid.replace(/-/g, '').substr(0, 12);

        // nw3's name is identical to nw1's full id. The full exact id should
        // be preferred over a name, so nw1 should be picked.
        var nw3name = (nw1uuid + nw1uuid).replace(/-/g, '');

        var nw1params = {
            name: 'sdcdockertest_apicreate_net1',
            subnet: '10.0.8.0/24',
            provision_start_ip: '10.0.8.2',
            provision_end_ip: '10.0.8.254',
            uuid: nw1uuid,
            gateway: '10.0.8.1',
            resolvers: ['8.8.8.8', '8.8.4.4']
        };

        // name deliberately ambiguous with a short version of nw1's docker id
        var nw2params = {
            name: nw2name,
            subnet: '10.0.9.0/24',
            provision_start_ip: '10.0.9.2',
            provision_end_ip: '10.0.9.254',
            gateway: '10.0.9.1',
            resolvers: ['8.8.8.8', '8.8.4.4']
        };

        // name deliberately identical to nw1's docker id
        var nw3params = {
            name: nw3name,
            subnet: '10.0.10.0/24',
            provision_start_ip: '10.0.10.2',
            provision_end_ip: '10.0.10.254',
            gateway: '10.0.10.1',
            resolvers: ['8.8.8.8', '8.8.4.4']
        };

        vasync.pipeline({
            funcs: [
                function fnw1(_, cb) {
                    h.getOrCreateFabricNetwork(NAPI, ALICE.account.uuid,
                        fVlan.vlan_id, nw1params, function (err, network) {
                            if (err) {
                                return cb(err);
                            }
                            nw2params.name =
                                network.uuid.replace(/-/g, '').substr(0, 12);
                            nw3params.name = (network.uuid + network.uuid)
                                .replace(/-/g, '');
                            return cb(null, network);
                        }
                    );
                },
                function fnw2(_, cb) {
                    h.getOrCreateFabricNetwork(NAPI, ALICE.account.uuid,
                        fVlan.vlan_id, nw2params, cb);
                },
                function fnw3(_, cb) {
                    h.getOrCreateFabricNetwork(NAPI, ALICE.account.uuid,
                        fVlan.vlan_id, nw3params, cb);
                },
                function fnonFabricNet(_, cb) {
                    h.getNetwork(NAPI, {name: 'external'}, cb);
                }
            ]
        }, function (err, results) {
            t.ifErr(err, 'create networks');
            if (err) {
                t.end();
                return;
            }
            fNetwork1 = results.operations[0].result;
            fNetwork2 = results.operations[1].result;
            fNetwork3 = results.operations[2].result;
            nonFabricNetwork = results.operations[3].result;

            t.test('create pool', function (t2) {
                h.getOrCreateNetworkPool(NAPI, 'sdcdockertest_apicreate_netp', {
                    networks: [ nonFabricNetwork.uuid ]
                }, function (err2) {
                    t2.ifErr(err2, 'create pool failed');
                    t2.end();
                });
            });

            t.end();
        });
    });

    // attempt a create with a name.
    tt.test('create with a network name', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.NetworkMode': fNetwork1.name },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create NetworkMode: networkName');
            var nics = result.vm.nics;
            t.equal(nics[0].network_uuid, fNetwork1.uuid, 'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    // create with networkPool name
    tt.test('create with a networkPool name', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.NetworkMode': 'sdcdockertest_apicreate_netp' },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create NetworkPool: networkName');
            var nics = result.vm.nics;
            t.equal(nics[0].network_uuid, nonFabricNetwork.uuid,
                'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('create with a complete network id', function (t) {
        var fullId = (fNetwork1.uuid + fNetwork1.uuid).replace(/-/g, '');

        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.NetworkMode': fullId },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create network testing container');
            var nics = result.vm.nics;
            t.equal(nics.length, 1, 'only one nic');
            t.equal(nics[0].network_uuid, fNetwork1.uuid, 'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('create with partial network id', function (t) {
        var partialId = (fNetwork1.uuid + fNetwork1.uuid).replace(/-/g, '');
        partialId = partialId.substr(0, 10);

        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.NetworkMode': partialId },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create network testing container');
            var nics = result.vm.nics;
            t.equal(nics.length, 1, 'only one nic');
            t.equal(nics[0].network_uuid, fNetwork1.uuid, 'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('create with partial network id, publish ports', function (t) {
        var partialId = (fNetwork1.uuid + fNetwork1.uuid).replace(/-/g, '');
        partialId = partialId.substr(0, 10);

        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: {
                'HostConfig.NetworkMode': partialId,
                'HostConfig.PublishAllPorts': true
            },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            var nics = result.vm.nics;
            t.equal(nics.length, 2, 'two nics');
            t.equal(nics[0].network_uuid, fNetwork1.uuid, 'correct network');
            t.equal(nics[1].network_uuid, nonFabricNetwork.uuid,
                'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('prefer name over partial id', function (t) {
        // fNetwork2 is named using a partial id from fNetwork1.

        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.NetworkMode': fNetwork2.name },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            var nics = result.vm.nics;
            t.equal(nics.length, 1, 'only one nic');
            t.equal(nics[0].network_uuid, fNetwork2.uuid, 'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('prefer full id over name', function (t) {
        // fNetwork3 is named with the full dockerId of fNetwork1.

        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.NetworkMode': fNetwork3.name },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            var nics = result.vm.nics;
            t.equal(nics.length, 1, 'only one nic');
            t.equal(nics[0].network_uuid, fNetwork1.uuid, 'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }

    });

    tt.test('create with a network that doesn\'t exist', function (t) {
        var uuid = libuuid.create();
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.NetworkMode': uuid },
            expectedErr: '(Error) network ' + uuid + ' not found',
            start: true
        }, oncreate);

        function oncreate(err, result) {
            t.ok(err, 'should err on create');
            t.end();
        }
    });

    tt.test('create without specifying network', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            start: true
        }, oncreate);

        function oncreate(err, result) {
            var nics = result.vm.nics;
            t.equal(nics.length, 1, 'only one nic');
            h.getNetwork(NAPI, {uuid: nics[0].network_uuid},
                function (err2, net) {

                t.ifErr(err2, 'get network');
                t.ok(net, 'nets exists');
                if (net) {
                    t.equal(net.name, 'My-Fabric-Network', 'correct network');
                }
                DOCKER_ALICE.del('/containers/' + result.id + '?force=1',
                    ondelete);
            });
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('create without specifying network, publish ports', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: {'HostConfig.PublishAllPorts': true},
            start: true
        }, oncreate);

        function oncreate(err, result) {
            var nics = result.vm.nics;
            t.equal(nics.length, 2, 'only two nics');
            t.equal(nics[1].network_uuid, nonFabricNetwork.uuid,
                    'correct network');
            h.getNetwork(NAPI, {uuid: nics[0].network_uuid},
                function (err2, net) {

                t.ifErr(err2, 'get network');
                t.ok(net, 'nets exists');
                if (net) {
                    t.equal(net.name, 'My-Fabric-Network', 'correct network');
                }
                DOCKER_ALICE.del('/containers/' + result.id + '?force=1',
                    ondelete);
            });
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('create with L3 nonFabric network', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.NetworkMode': nonFabricNetwork.name },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            var nics = result.vm.nics;
            t.equal(nics.length, 1, 'only one nic');
            t.equal(nics[0].network_uuid, nonFabricNetwork.uuid,
                'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('create with L3 nonFabric network, publish ports', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: {
                'HostConfig.NetworkMode': nonFabricNetwork.name,
                'HostConfig.PublishAllPorts': true
            },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            var nics = result.vm.nics;
            t.equal(nics.length, 2, 'two nics');
            t.equal(nics[0].network_uuid, nonFabricNetwork.uuid,
                'correct network');
            t.equal(nics[1].network_uuid, nonFabricNetwork.uuid,
                'correct network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete network testing container');
            t.end();
        }
    });

    tt.test('fail to create with a network that doesn\'t exit, publish ports',
        function (t) {

        var uuid = libuuid.create();
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: {
                'HostConfig.NetworkMode': uuid,
                'HostConfig.PublishAllPorts': true
            },
            start: false,
            expectedErr: '(Error) network ' + uuid + ' not found'
        }, oncreate);

        function oncreate(err, result) {
            t.ok(err, 'Expecting error');
            t.end();
        }
    });
});


/*
 * Tests for `docker run --label triton.network.public=foo`
 *
 * DOCKER-1020 Ensure we can provision to the external (public) network of our
 * choice by setting the appropriate triton label.
 */
test('run external network (docker run --label triton.network.public=)',
    function (tt) {

    var externalNetwork;

    tt.test('add external network', function (t) {
        // create a new one.
        var nwUuid = libuuid.create();
        var nwParams = {
            name: 'sdcdockertest_apicreate_external',
            nic_tag: 'external',
            subnet: '10.0.11.0/24',
            provision_start_ip: '10.0.11.2',
            provision_end_ip: '10.0.11.254',
            uuid: nwUuid,
            vlan_id: 5,
            gateway: '10.0.11.1',
            resolvers: ['8.8.8.8', '8.8.4.4']
        };
        h.getOrCreateExternalNetwork(NAPI, nwParams, function (err, network) {
            t.ifErr(err, 'getOrCreateExternalNetwork');
            externalNetwork = network;
            t.end();
        });
    });

    // Attempt a run with the external name, ensure the container is assigned
    // the external network that was asked for.
    tt.test('run with custom external network name', function (t) {
        // DOCKER-1045: when FABRICS are enabled, we expect an error if
        // specifying a specific external network, but are not publishing any
        // ports.
        var expectedErr = (FABRICS ? '(Validation) triton.network.public '
            + 'label requires a container with published ports' : null);

        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            expectedErr: expectedErr,
            extra: { Labels: { 'triton.network.public': externalNetwork.name }},
            start: true
        }, oncreate);

        function oncreate(err, result) {
            if (FABRICS) {
                // Note: Error is already checked in createDockerContainer.
                assert.object(err, 'err');
                t.end();
                return;
            }
            var nics = result.vm.nics;
            t.equal(nics.length, 1, 'only one nic');
            t.equal(nics[0].network_uuid, externalNetwork.uuid,
                'correct external network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete external network testing container');
            t.end();
        }
    });

    // Attempt a run with the external name whilst publishing ports, ensure the
    // container is assigned the external network that was asked for.
    tt.test('run custom external network name, published ports', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: {
                'HostConfig.PublishAllPorts': true,
                Labels: { 'triton.network.public': externalNetwork.name }
            },
            start: true
        }, oncreate);

        function oncreate(err, result) {
            var extNic;
            var nics = result.vm.nics;
            if (FABRICS) {
                // Expect two nics, one fabric and one external.
                t.equal(nics.length, 2, 'two nics');
                extNic = (nics[0].nic_tag === 'external' ? nics[0] : nics[1]);
            } else {
                t.equal(nics.length, 1, 'one nic');
                extNic = nics[0];
            }
            t.equal(extNic.network_uuid, externalNetwork.uuid,
                'correct external network');
            DOCKER_ALICE.del('/containers/' + result.id + '?force=1', ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete external network testing container');
            t.end();
        }
    });

    tt.test('external network cleanup', function (t) {
        if (!externalNetwork) {
            t.end();
            return;
        }
        NAPI.deleteNetwork(externalNetwork.uuid, function (err) {
            t.ifErr(err, 'external network deletion');
            t.end();
        });
    });
});
