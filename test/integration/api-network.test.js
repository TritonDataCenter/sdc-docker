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

var test = require('tape');

var h = require('./helpers');


// --- Globals
var ALICE;
var DOCKER_ALICE;
var FABRICS_ENABLED;
var NAPI;
var STATE = {
    log: require('../lib/log')
};


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);
            ALICE = accounts.alice;
            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient({user: ALICE},
            function (err, client) {
                t.ifErr(err, 'docker client init for alice');
                DOCKER_ALICE = client;
                t.end();
            }
        );
    });

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
                FABRICS_ENABLED = enabled;
                t.end();
            }
        );
    });
});


test('docker network ls', function (tt) {
    tt.test('list networks', function (t) {
        DOCKER_ALICE.get('/networks', function (err, res, req, networks) {
            t.ifErr(err, 'check /networks err');
            t.ok(Array.isArray(networks), 'check /networks returned an array');
            t.ok(networks.length >= 1, 'array contains at least one network');
            networks.forEach(function (net) {
                t.ok(net.Id.match(/^[0-9a-f]{64}$/),
                    'checking net.Id is hex-char string of 64 length');
                t.equal(net.Driver, 'Triton', 'checking net.Driver');
                t.ok(net.IPAM, 'checking net.IPAM existance');
                t.ok(net.Options, 'checking net.Options existance');
                t.ok(net.Scope, 'checking net.Scope existance');
                if (net.Scope === 'pool') {
                    t.equal(Object.keys(net.Options).length, 0,
                        'net.Options object should be empty');
                } else {
                    t.ok(net.Scope === 'overlay' || net.Scope === 'external',
                        'checking net.Scope is overlay or external');
                    t.equal(Object.keys(net.Options).length, 1,
                        'net.Options object should have one entry');
                    t.ok(net.Options['com.docker.network.driver.mtu'],
                        'checking net.Options mtu existance');
                    t.ok(net.Config, 'checking net.Config existance');
                    t.ok(net.Config[0], 'checking net.Config[0] existance');
                    t.ok(net.Config[0].Subnet,
                        'checking net.Config[0].Subnet existance');
                    // Some networks don't have a gateway (at least in
                    // nightly-1 test rig), so we don't do a test for the
                    // `Gateway` field
                }
            });
            if (FABRICS_ENABLED) {
                var aliceMyFabricNetworks = networks.filter(function (net) {
                    return net.Name === 'My-Fabric-Network';
                });

                t.equal(aliceMyFabricNetworks.length, 1,
                    'expect 1 My-Fabric-Network');
                t.equal(aliceMyFabricNetworks[0].Scope, 'overlay',
                    'Ensure Scope === overlay');
            }
            t.end();
        });
    });
});

test('docker network inspect', function (tt) {
    tt.test('inspect external network', function (t) {
        DOCKER_ALICE.get('/networks/external',
            function (err, res, req, net)
        {
            t.ifErr(err, 'check /networks/external err');
            t.equal(net.Driver, 'Triton', 'checking net.Driver');
            t.ok(net.IPAM, 'checking net.IPAM existance');
            t.ok(net.Options, 'checking net.Options existance');
            t.equal(net.Scope, 'external', 'checking net.Scope is external');
            t.end();
        });
    });
});
