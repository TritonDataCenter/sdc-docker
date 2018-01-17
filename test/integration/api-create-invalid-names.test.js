/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Joyent, Inc.
 */

var vasync = require('vasync');

var mod_testVolumes = require('../lib/volumes');
var testHelpers = require('./helpers');
var volumesApi = require('../lib/volumes-api');

var ALICE;
var DOCKER_ALICE;
var STATE = {
    log: require('../lib/log')
};

var test = mod_testVolumes.createTestFunc({
    checkTritonSupportsNfsVols: true
});

test('setup', function (tt) {

    tt.test('docker env', function (t) {
        testHelpers.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        testHelpers.createDockerRemoteClient({
            user: ALICE
        }, function (err, client) {
            t.ifErr(err, 'docker client init for alice');

            DOCKER_ALICE = client;

            t.end();
        });
    });
});

test('api: create volumes with invalid name', function (tt) {

    tt.test('docker volume create with invalid name should fail', function (t) {
        /*
         * 'x'.repeat(257) generates a volume name that is one character too
         * long, as the max length for volume names is 256 characters.
         */
        var INVALID_VOLUME_NAMES = ['-foo', '.foo', 'x'.repeat(257)];

        vasync.forEachParallel({
            func: function createVolume(volumeName, done) {
                volumesApi.createDockerVolume({
                    name: volumeName,
                    dockerClient: DOCKER_ALICE
                }, function onVolCreated(volCreateErr) {
                    t.ok(volCreateErr, 'volume creation with name '
                        + volumeName + ' should fail');
                    done();
                });
            },
            inputs: INVALID_VOLUME_NAMES
        }, function onAllVolsCreated(err) {
            t.end();
        });
    });
});