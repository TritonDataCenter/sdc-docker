/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests which incorporate the Docker CLI integration tests.
 * For now these are only the tests which are not easily exercised by the HTTP
 * API. It may be desirable to add the full test suite at some future date, but
 * doing so will dramatically increase the duration of make test, etc.
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

test('docker-integration-cli', function (tt) {

    tt.test(' setup', function (t) {
        h.getDockerEnv(t, state, {account: 'sdcdockertest_alice'},
                function (err, env) {
            t.ifErr(err);
            t.ok(env, 'have a DockerEnv for alice');
            alice = env;
            t.end();
        });
    });

    tt.test('TestAttachTtyWithoutStdin', function (t) {
        alice.dockerTest('TestAttachTtyWithoutStdin',
            function (err, stdout, stderr) {
                t.ifErr(err);
                t.ok(/PASS/m.test(stdout), stdout);
                t.end();
        });
    });

    tt.test('TestRunWorkingDirectory', function (t) {
        alice.dockerTest('TestRunWorkingDirectory',
            function (err, stdout, stderr) {
                t.ifErr(err);
                t.ok(/PASS/m.test(stdout), stdout);
                t.end();
        });
    });

    tt.test('TestRunAttachStdOutAndErrTTYMode', function (t) {
        alice.dockerTest('TestRunAttachStdOutAndErrTTYMode',
            function (err, stdout, stderr) {
                t.ifErr(err);
                t.ok(/PASS/m.test(stdout), stdout);
                t.end();
        });
    });

    tt.test('TestRunAttachWithDetach', function (t) {
        alice.dockerTest('TestRunAttachWithDetach',
            function (err, stdout, stderr) {
                t.ifErr(err);
                t.ok(/PASS/m.test(stdout), stdout);
                t.end();
        });
    });

});
