/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for images endpoints using the Remote API directly.
 */

var p = console.log;

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
        h.createDockerRemoteClient({user: ALICE}, function (err, client) {
            t.ifErr(err, 'docker client init');
            DOCKER_ALICE = client;

            h.createDockerRemoteClient({user: BOB}, function (err2, client2) {
                t.ifErr(err2, 'docker client init for bob');
                DOCKER_BOB = client2;

                t.end();
            });
        });
    });

});


test('docker images', function (tt) {

    tt.test('list images', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.ok(images, 'images array');
            t.end();
        });
    });


    tt.test('pull ubuntu image', function (t) {
        h.ensureImage({
            name: 'ubuntu:latest',
            user: ALICE
        }, function (err) {
            console.log('ubuntu pull err: ', err);
            t.error(err, 'should be no error pulling image');
            t.end();
        });
    });


    tt.test('ensure ubuntu image is in the list', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            t.ok(images.length, 'images array should not be empty');
            t.ok(images.map(function (image) {
                return -1 !== image.RepoTags.indexOf('ubuntu:latest');
            }).length, 'should be able to find image');

            t.end();
        });
    });


    // Ensure an image can be inspected when the name is uri decoded/encoded.
    tt.test('inspect ubuntu image', function (t) {
        var url = '/images/ubuntu:latest/json';
        DOCKER_ALICE.get(url, function (err, req, res) {
            t.error(err, 'get ubuntu:latest image');
            url = url.replace(':', '%3A');
            DOCKER_ALICE.get(url, function (err2, req2, res2) {
                t.error(err2, 'get encoded ubuntu%3Alatest image');
                t.end();
            });
        });
    });


    tt.test('delete image', function (t) {
        DOCKER_ALICE.del('/images/ubuntu', ondel);
        function ondel(err, req, res) {
            t.error(err, 'should be no error retrieving images');
            t.end();
        }
    });


    tt.test('ensure image is gone', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');

            t.ok(images, 'images array');
            var found = images.map(function (image) {
                return -1 !== image.RepoTags.indexOf('ubuntu:latest');
            });

            t.deepEqual(
                found.filter(function (i) { return i; }),
                [],
                'ubuntu image should have been deleted');
            t.end();
        });
    });

    tt.test('pull image without approved_for_provisioning', function (t) {
        var url = '/images/create?fromImage=ubuntu%3Alatest';
        DOCKER_BOB.post(url, function (err, req, res) {
            t.ok(err, 'should not pull without approved_for_provisioning');

            t.equal(err.statusCode, 403);

            var expected = BOB.login + ' does not have permission to pull or '
                + 'provision';
            t.ok(err.message.match(expected));

            t.end();
        });
    });

});
