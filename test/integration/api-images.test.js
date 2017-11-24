/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
var IMAGE_NAME_WITH_PORT = 'registry-1.docker.io:443/'
    + 'joyentunsupported/test-nginx:latest';
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

    var img;

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
        DOCKER_ALICE.get(url, function (err, req, res, _img) {
            t.error(err, 'get ubuntu:latest image');
            img = _img;
            url = url.replace(':', '%3A');
            DOCKER_ALICE.get(url, function (err2, req2, res2) {
                t.error(err2, 'get encoded ubuntu%3Alatest image');
                t.end();
            });
        });
    });


    // Ensure an image can be found using the config digest.
    tt.test('inspect ubuntu image by config digest', function (t) {
        t.equal(img.Id.substr(0, 7), 'sha256:', 'id should be a digest');
        var url = '/images/' + img.Id + '/json';
        DOCKER_ALICE.get(url, function (err, req, res, _img) {
            t.error(err, 'get image by digest');
            t.equal(img.Id, _img.Id, 'images should have same digest');
            t.end();
        });
    });


    // Ensure an image can be found using the repo (manifest) digest.
    tt.test('inspect ubuntu image by repo digest', function (t) {
        var repoDigest = img.RepoDigests[0];
        var url = '/images/' + repoDigest + '/json';
        DOCKER_ALICE.get(url, function (err, req, res, _img) {
            t.error(err, 'get image by repo digest');
            t.equal(img.Id, _img.Id, 'images should have same digest');
            t.end();
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

    // Ensure an image can be pulled using the manifest digest.
    tt.test('pull ubuntu image by manifest digest', function (t) {
        var repoDigest = img.RepoDigests[0];
        h.ensureImage({
            name: repoDigest,
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling image by digest');
            t.end();
        });
    });

    tt.test('delete image', function (t) {
        DOCKER_ALICE.del('/images/ubuntu', ondel);
        function ondel(err, req, res) {
            t.error(err, 'should be no error retrieving images');
            t.end();
        }
    });

    tt.test('pull image name containing port', function (t) {
        h.ensureImage({
            name: IMAGE_NAME_WITH_PORT,
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling image');
            t.end();
        });
    });

    tt.test('inspect image name containing port', function (t) {
        var url = '/images/' + IMAGE_NAME_WITH_PORT + '/json';
        DOCKER_ALICE.get(url, function (err2, req2, res2) {
            t.error(err2, 'get image name containing port');
            t.end();
        });
    });

    tt.test('delete image name containing port', function (t) {
        DOCKER_ALICE.del('/images/' + IMAGE_NAME_WITH_PORT,
            function ondel(err, req, res) {
                t.error(err, 'should be no error deleting image');
                t.end();
            }
        );
    });
});
