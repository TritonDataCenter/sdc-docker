/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker search`
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

test('docker search', function (tt) {

    tt.test(' setup', function (t) {
        h.getDockerEnv(t, state, {account: 'sdcdockertest_alice'},
                function (err, env) {
            t.ifErr(err);
            t.ok(env, 'have a DockerEnv for alice');
            alice = env;
            t.end();
        });
    });

    tt.test(' docker search busybox', function (t) {
        alice.docker('search busybox', function (err, stdout, stderr) {
            t.ifErr(err);
            t.ok(/^busybox /m.test(stdout), 'official busybox image');
            t.end();
        });
    });

    // DOCKER-604 skip this test for now, quay.io search is busted.
    tt.skip(' docker search quay.io/quay/elasticsearch', function (t) {
        alice.docker('search quay.io/quay/elasticsearch',
                function (err, stdout, stderr) {
            t.ifErr(err);
            t.ok(/^quay\/elasticsearch /m.test(stdout),
                'quay user elasticsearch');
            t.end();
        });
    });

    /*
     * This should fail, we don't expect to have any.
     *
     * It would be nice to fail quickly. E.g. on Docker-docker:
     *
     *  $ time docker search localhost:4321/foo
     *  FATA[0000] Error response from daemon: v1 \
     *    ping attempt failed with error: Get \
     *    http://localhost:4321/v1/_ping: dial tcp 127.0.0.1:5000: \
     *    connection refused
     *
     *  real    0m0.192s
     *  user    0m0.150s
     *  sys     0m0.005s
     *
     * However, sdc-docker currently takes ~15s to fail here.
     */
    tt.test(' docker search localhost:4321/foo', function (t) {
        alice.docker('search localhost:4321/foo',
                function (err, stdout, stderr) {
            t.ok(err);
            t.end();
        });
    });


});
