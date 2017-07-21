/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Integration tests for docker image tags.
 */

var cli = require('../lib/cli');
var vm = require('../lib/vm');
var test = require('tape');
var vasync = require('vasync');



// --- Globals


var CLIENTS = {};
var TAG_PREFIX = 'sdcdockertest_tag_';
var IMAGE_NAME = 'busybox';

// --- Helpers

function cleanupTags(tt) {
    tt.test('image tag cleanup', function (t) {
        cli.docker('images | grep ' + TAG_PREFIX
            + ' | grep -v "<none>" | awk "{ print \\$1 }"',
            {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err);
            var ids = stdout.split(/\r?\n/g).join(' ').trim();
            if (!ids) {
                t.end();
                return;
            }
            cli.docker('rmi ' + ids, {}, onRemove);
        }
        function onRemove(err, stdout, stderr) {
            t.ifErr(err);
            t.end();
        }
    });
}

// --- Tests


test('setup', function (tt) {
    tt.test('DockerEnv: alice init', cli.init);
    cleanupTags(tt);
});


test('tag image', function (tt) {

    var tagName = TAG_PREFIX + 'altbox';

    tt.test('pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });


    tt.test('inspect busybox image', function (t) {
        cli.inspect(t, {
            id: 'busybox:latest'
        }, function (err, img) {
            t.end();
        });
    });


    // Tag the image.
    tt.test('tag busybox image', function (t) {
        cli.docker('tag busybox ' + tagName, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err);
            t.end();
        }
    });


    // Check that the tagged image is available.
    tt.test('inspect tagged image', function (t) {
        cli.inspect(t, {
            id: tagName + ':latest'
        }, function (err, img) {
            t.ifErr(err, 'Found tagged image');
            t.end();
        });
    });


    cleanupTags(tt);


    // Check that the original busybox image is *still* available after deleting
    // the `altbox` tag.
    tt.test('inspect busybox image again', function (t) {
        cli.inspect(t, {
            id: 'busybox:latest'
        }, function (err, img) {
            t.end();
        });
    });
});


/**
 * DOCKER-756: Check can tag an image that references multiple registries.
 */
test('DOCKER-756: tag between different registries', function (tt) {

    var tagName = 'quay.io/joyent/' + TAG_PREFIX + 'altbox';

    tt.test('pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });

    // Tag the image.
    tt.test('tag busybox image', function (t) {
        cli.docker('tag busybox ' + tagName, {}, function onComplete(err) {
            t.ifErr(err);
            t.end();
        });
    });
});
