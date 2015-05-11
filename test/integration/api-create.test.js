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
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;
            BOB   = accounts.bob;

            t.end();
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

            var expected = BOB.login + ' does not have permission to pull or '
                + 'provision';
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
