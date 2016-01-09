/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for `docker build` using the Remote API directly.
 *
 * Note: There are only limited tests here, as we rely on the docker/docker
 *       integration-cli tests to perform most of the sdc-docker build testing,
 *       which are run separately (e.g. in nightly).
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
        var dockerImageId = null;
        var tarballPath = path.join(__dirname, 'fixtures',
            'busybox-build-context.tar');

        vasync.waterfall([

            function buildContainer(next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    test: t,
                    tarballPath: tarballPath
                }, onbuild);

                function onbuild(err, result) {
                    t.ifError(err, 'built successfully');
                    next(err, result);
                }
            },

            function checkResults(result, next) {
                if (!result || !result.body) {
                    next(new Error('build generated no output!?'));
                    return;
                }

                var output = result.body;
                var hasLabel = output.indexOf('LABEL sdcdocker=true') >= 0;
                t.ok(hasLabel, 'output contains LABEL sdcdocker=true');

                var hasSuccess = output.indexOf('Successfully built') >= 0;
                t.ok(hasSuccess, 'output contains Successfully built');

                if (hasSuccess) {
                    var reg = new RegExp('Successfully built (\\w+)');
                    dockerImageId = output.match(reg)[1];
                }

                next();
            },

            function removeBuiltImage(next) {
                t.ok(dockerImageId, 'Got the docker image id');
                DOCKER_ALICE_HTTP.del('/images/' + dockerImageId, next);
            }

        ], function allDone(err) {
            t.ifErr(err);

            t.end();
        });

    });
});
