/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker info` using the Remote API directly.
 */

var p = console.log;

var test = require('tape');
var util = require('util');
var vasync = require('vasync');

var h = require('./helpers');



// --- Globals

var ALICE;
var CLIENT;
var STATE = {
    log: require('../lib/log')
};


// --- Tests


test('setup', function (tt) {
    tt.test('docker env', function (t) {
        h.getDockerEnv(t, STATE, {account: 'sdcdockertest_alice'},
                function (err, env) {
            t.ifErr(err, 'docker env: alice');
            t.ok(env, 'have a DockerEnv for alice');
            ALICE = env;

            t.end();
            return;
        });
    });


    tt.test('client init', function (t) {
        h.createDockerRemoteClient(ALICE, function (err, client) {
            CLIENT = client;
            t.end();
        });
    });
});


test('api: info', function (tt) {
    tt.test('/v1.15/info', function (t) {
        CLIENT.get('/v1.15/info', function (err, res, req, body) {
            h.assertInfo(t, body);
            t.end();
        });
    });


    tt.test('/v1.16/info', function (t) {
        CLIENT.get('/v1.16/info', function (err, res, req, body) {
            h.assertInfo(t, body);
            t.end();
        });
    });
});
