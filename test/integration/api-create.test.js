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

var test = require('tape');
var util = require('util');

var h = require('./helpers');



// --- Globals

var ALICE;
var DOCKER;
var STATE = {
    log: require('../lib/log')
};
var VMAPI;


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.getDockerEnv(t, STATE, {account: 'sdcdockertest_alice'},
                function (err, env) {
            t.ifErr(err, 'docker env: alice');
            t.ok(env, 'have a DockerEnv for alice');
            ALICE = env;

            t.end();
        });
    });


    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient(ALICE, function (err, client) {
            DOCKER = client;
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

});


test('api: create', function (tt) {

    var created;

    tt.test('docker create', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER,
            test: t
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.end();
        }
    });


    tt.test('docker rm', function (t) {
        DOCKER.del('/v1.15/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

});
