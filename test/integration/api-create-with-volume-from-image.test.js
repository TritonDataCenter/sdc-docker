/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

var test = require('tape');

var h = require('./helpers');

var ALICE;
var DOCKER_ALICE;
var STATE = {
    log: require('../lib/log')
};
var TEST_IMAGE = 'joyentunsupported/test-image-with-volume:latest';
var VMAPI;

test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient({user: ALICE}, function (err, client) {
            t.ifErr(err, 'docker client init for alice');

            DOCKER_ALICE = client;

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
            start: true,
            wait: true,
            imageName: TEST_IMAGE,
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t
        }, oncreate);

        function oncreate(err, result) {
            var expectedExitCode = 0;

            t.ifErr(err, 'create container');
            t.ok(result, 'result should not be empty');
            t.ok(result.inspect, 'inspect info should not be empty');
            t.ok(result.inspect.State,
                'inspect info should have a State property');
            if (result && result.inspect && result.inspect.State) {
                t.equal(result.inspect.State.ExitCode, expectedExitCode,
                    'exit code should be ' + expectedExitCode + ', got: '
                        + result.inspect.State.ExitCode);
            }

            created = result;
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });
});