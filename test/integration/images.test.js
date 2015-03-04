/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker create`.
 */

var p = console.log;

var test = require('tape');
var util = require('util');
var exec = require('child_process').exec;
var vasync = require('vasync');

var h = require('./helpers');



// --- Globals

var docker;


// --- Tests

test('docker images', function (t) {
    t.plan(13);

    vasync.waterfall([
        function (next) {
            // Create Docker client
            h.createDockerRemoteClient(function (err, client) {
                t.error(err, 'no error getting docker client');
                docker = client;
                next(err);
            });
        },
        // Check that the nginx image exists
        function (next) {
            docker.get('/v1.15/images/json', function (err, req, res, images) {
                t.error(err, 'should be no error retrieving images');
                // check for nginx image

                t.ok(images.length, 'images array should not be empty');
                t.ok(images.map(function (image) {
                    return -1 !== image.RepoTags.indexOf('nginx:latest');
                }).length, 'should be able to find image');

                next();
            });
        },
        // Pull ubuntu image...
        function (next) {
            var url = '/v1.15/images/create?fromImage=ubuntu%3Alatest';
            docker.post(url, function (err, req, res) {
                t.error(
                    err, 'should be no error posting image create request');

                next();
            });
        },
        // ...and make sure it shows up in the list
        function (next) {
            docker.get('/v1.15/images/json', function (err, req, res, images) {
                t.error(err, 'should be no error retrieving images');
                t.ok(images.length, 'images array should not be empty');
                t.ok(images.map(function (image) {
                    return -1 !== image.RepoTags.indexOf('ubuntu:latest');
                }).length, 'should be able to find image');

                next();
            });
        },
        // Delete the image...
        function (next) {
            docker.del('/v1.15/images/ubuntu', ondel);
            function ondel(err, req, res) {
                t.error(err, 'should be no error retrieving images');
                next();
            }
        },
        // ...and make sure it's gone
        function (next) {
            docker.get('/v1.15/images/json', function (err, req, res, images) {
                t.error(err, 'should be no error retrieving images');

                t.ok(images.length, 'images array should not be empty');
                var found = images.map(function (image) {
                    return -1 !== image.RepoTags.indexOf('ubuntu:latest');
                });

                t.deepEqual(
                    found.filter(function (i) { return i; }),
                    [],
                    'ubuntu image should have been deleted');
                next();
            });
        }
    ], function (err) {
        t.error(err);
        t.end();
    });
});
