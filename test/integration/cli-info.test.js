/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker info`
 */

var h = require('./helpers');
var test = require('tape');



// --- Globals

var log = require('../lib/log');
var state = {
    log: log
};
var alice;



// --- Tests

test('docker info', function (tt) {

    tt.test('setup', function (t) {
        h.getDockerEnv(t, state, {account: 'sdcdockertest_alice'},
                function (err, env) {
            t.ifErr(err);
            t.ok(env, 'have a DockerEnv for alice');
            alice = env;
            t.end();
        });
    });

    tt.test('docker info (alice)', function (t) {
        alice.docker('info', function (err, stdout, stderr) {
            t.ifErr(err, 'docker info');
            t.ok(/^Storage Driver: sdc$/m.test(stdout), 'Storage Driver: sdc');
            t.ok(/SDCAccount: sdcdockertest_alice$/m.test(stdout),
                'SDCAccount: sdcdockertest_alice');
            t.ok(/Operating System: SmartDataCenter$/m.test(stdout),
                'Operating System');
            t.end();
        });
    });

});
