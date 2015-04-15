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
var DOCKER;
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
        });
    });


    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient(ALICE, function (err, client) {
            DOCKER = client;
            t.end();
        });
    });

});


test('docker images', function (tt) {

    tt.test('list images', function (t) {
        DOCKER.get('/v1.15/images/json', function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            // check for nginx image

            t.ok(images.length, 'images array should not be empty');
            t.ok(images.map(function (image) {
                return -1 !== image.RepoTags.indexOf('nginx:latest');
            }).length, 'should be able to find image');

            t.end();
        });
    });


    tt.test('pull ubuntu image', function (t) {
        var url = '/v1.15/images/create?fromImage=ubuntu%3Alatest';
        DOCKER.post(url, function (err, req, res) {
            t.error(err, 'should be no error posting image create request');

            t.end();
        });
    });


    tt.test('ensure ubuntu image is in the list', function (t) {
        DOCKER.get('/v1.15/images/json', function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            t.ok(images.length, 'images array should not be empty');
            t.ok(images.map(function (image) {
                return -1 !== image.RepoTags.indexOf('ubuntu:latest');
            }).length, 'should be able to find image');

            t.end();
        });
    });


    tt.test('delete image', function (t) {
        DOCKER.del('/v1.15/images/ubuntu', ondel);
        function ondel(err, req, res) {
            t.error(err, 'should be no error retrieving images');
            t.end();
        }
    });


    tt.test('ensure image is gone', function (t) {
        DOCKER.get('/v1.15/images/json', function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');

            t.ok(images.length, 'images array should not be empty');
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

});
