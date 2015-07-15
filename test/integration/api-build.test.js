/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker build` using the Remote API directly.
 */

var path = require('path');

var test = require('tape');
var vasync = require('vasync');

var h = require('./helpers');

var STATE = {
    log: require('../lib/log')
};

var ALICE;
var DOCKER_ALICE_HTTP; // For sending non-JSON payload

test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        vasync.parallel({ funcs: [
            function createAliceHttp(done) {
                h.createDockerRemoteClient({user: ALICE, clientType: 'http'},
                    function (err, client) {
                        t.ifErr(err, 'docker client init for alice/http');
                        done(err, client);
                    });
            }
        ]}, function allDone(err, results) {
            t.ifError(err, 'docker client init should be successful');
            DOCKER_ALICE_HTTP = results.operations[0].result;
            t.end();
        });
    });
});

test('api: build', function (tt) {
    tt.test('docker build with nginx build context', function (t) {
        // Use an arbitrary request ID that we can use to track it
        // in log files to extract some information about how it
        // ran
        var REQ_ID = '42';
        var tarballPath = path.join(__dirname, 'fixtures',
            'nginx-build-context.tar');

        vasync.waterfall([
            function buildContainer(next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    test: t,
                    tarballPath: tarballPath,
                    extraHeaders: {
                        'x-request-id': REQ_ID
                    }
                }, onbuild);

                function onbuild(err, result) {
                    t.ok(err, 'should not build');
                    t.ok(result.body.match(/\(NotImplemented\)/),
                        'build should not be implemented');

                    // Swallow previous error, because we're expecting that
                    // error to happen
                    return next();
                }
            },
            function checkHandlerDidNotRun(next) {
                // Now make sure that the bodyParser handler did not run
                h.didRestifyHandlerRun(REQ_ID, 'parseBody', onResult);
                function onResult(err, handlerDidRun) {
                    t.ifErr(err);
                    t.ok(handlerDidRun === false,
                        'body parser handler should not run');

                    return next(err);
                }
            }
        ], function allDone(err) {
            t.ifErr(err);

            t.end();
        });

    });
});
