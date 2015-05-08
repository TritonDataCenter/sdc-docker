/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker create` using the Remote API directly.
 */

var p = console.log;

var fmt  = require('util').format;
var exec = require('child_process').exec;
var test = require('tape');
var util = require('util');

var h = require('./helpers');



// --- Globals

var ALICE;
var BOB;
var DOCKER_ALICE;
var DOCKER_BOB;
var STATE = {
    log: require('../lib/log')
};
var VMAPI;


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        function setProvisioning(login, val, cb) {
            var s = '/opt/smartdc/bin/sdc sdc-useradm replace-attr %s \
                approved_for_provisioning %s';
            var cmd = fmt(s, login, val);
            if (BOB.state.runningFrom === 'remote') {
                cmd = 'ssh ' + BOB.state.headnodeSsh + ' ' + cmd;
            }
            exec(cmd, cb);
        }

        h.getDockerEnv(t, STATE, {account: 'sdcdockertest_alice'},
                function (err, env) {
            t.ifErr(err, 'docker env: alice');
            t.ok(env, 'have a DockerEnv for alice');
            ALICE = env;

            // We create Bob here, who is permanently set as unprovisionable
            // below. Docker's ufds client caches account values, so mutating
            // Alice isn't in the cards (nor is Bob -- which is why we don't
            // set Bob provisionable when this test file completes).
            h.getDockerEnv(t, STATE, {account: 'sdcdockertest_bob'},
                    function (err2, env2) {
                t.ifErr(err2, 'docker env: bob');
                t.ok(env2, 'have a DockerEnv for bob');
                BOB = env2;

                setProvisioning(BOB.login, false, function (err3) {
                    t.ifErr(err3, 'set bob unprovisionable');
                    t.end();
                });
            });
        });
    });


    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient(ALICE, function (err, client) {
            t.ifErr(err, 'docker client init for alice');
            DOCKER_ALICE = client;

            h.createDockerRemoteClient(BOB, function (err2, client2) {
                t.ifErr(err2, 'docker client init for bob');
                DOCKER_BOB = client2;

                t.end();
            });
        });
    });


    tt.test('vmapi client init', function (t) {
        h.createVmapiClient(function (err, client) {
            t.ifErr(err, 'vmapi client');
            VMAPI = client;
            t.end();
        });
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

            var expected = BOB.login + ' does not have permission to provision';
            t.ok(err.message.match(expected));

            t.end();
        }

        function stub() {}
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/v1.15/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

});
