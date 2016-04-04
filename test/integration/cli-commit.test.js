/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for `docker commit` using the Remote API directly.
 *
 * Note: These are only limited tests here, as we rely on the docker/docker
 *       integration-cli tests to perform most of the sdc-docker build testing,
 *       which are run separately (e.g. in nightly).
 */

var path = require('path');

var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var h = require('./helpers');

var format = require('util').format;

var STATE = {
    log: require('../lib/log')
};

var CONTAINER_PREFIX = 'sdcdockertest_commit_';
var IMAGE_NAME = 'busybox';
var TP = 'api: commit: ';  // Test prefix.

test(TP + 'setup', function (tt) {

    tt.test('DockerEnv: alice init', cli.init);

    // Ensure the busybox image is around.
    tt.test(TP + 'pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });
});


test(TP + 'test add file', function (tt) {

    var commitImageTag = common.makeContainerName(CONTAINER_PREFIX);
    var containerName = common.makeContainerName(CONTAINER_PREFIX);

    tt.test('run ' + IMAGE_NAME + ' container', function (t) {
        var runArgs = format('--name %s %s sh -c "echo hello > '
            + '/newfile.txt"', containerName, IMAGE_NAME);
        cli.run(t, {args: runArgs}, t.end.bind(t)); // Err handled in cli.run
    });

    tt.test('commit ' + IMAGE_NAME + ' container', function (t) {
        var args = format('--author "cli tests" --message "Beer is great" '
            + '--change "LABEL test=1" %s %s', containerName, commitImageTag);
        cli.commit(t, {args: args}, t.end.bind(t)); // Err handled in commit
    });

    // Cleanup out test container and committed image.
    tt.test('delete ' + IMAGE_NAME + ' container', function (t) {
        cli.rm(t, {args: containerName}, t.end.bind(t)); // Err handled in rm
    });

    // Inspect committed image metadata.
    tt.test('inspect committed image', function (t) {
        cli.inspect(t, {
            id: commitImageTag
        }, function (err, img) {
            if (img) {
                t.equal(img.Author, 'cli tests');
                t.equal(img.Comment, 'Beer is great');
                t.deepEqual(img.Config.Labels, {'test': '1'});
            }
            t.end();
        });
    });

    // Run the committed image and verify the 'newfile.txt' contents.
    tt.test('verify created image', function (t) {
        var runArgs = format('--rm --name %s %s sh -c "cat /newfile.txt"',
            common.makeResourceName(CONTAINER_PREFIX + 'verify_'),
            commitImageTag);
        cli.run(t, {args: runArgs}, function (err, result) {
            // err is already tested in cli.run() call
            if (!err) {
                t.ok(result.stdout.indexOf('hello') >= 0,
                    'newfile.txt content is "hello"');
            }
            t.end();
        });
    });

    tt.test('delete committed image', function (t) {
        cli.rmi(t, {args: commitImageTag}, t.end.bind(t)); // Err handled in rmi
    });

    // Ensure base busybox image is still around (and wasn't deleted).
    tt.test('inspect busybox image', function (t) {
        cli.inspect(t, {
            id: IMAGE_NAME
        }, t.end.bind(t) /* err checked by cli.inspect */);
    });
});
