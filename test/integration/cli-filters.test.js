/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for docker labels.
 */

var format = require('util').format;
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var vm = require('../lib/vm');


// --- Globals

var CLIENTS = {};
var CONTAINER_PREFIX = 'sdcdockertest_filters_';
var IMAGE_NAME = 'joyent/busybox_with_label_test';



// --- Tests

test('setup', function (tt) {

    tt.test('DockerEnv: alice init', cli.init);

    tt.test('vmapi client', vm.init);
});


function checkContainerFiltering(tt, args, expectedNames) {
    tt.test('container filtering', function (t) {
        cli.ps(t, {args: args}, function (err, containers) {
            console.log('containers: ', containers);
            t.ifErr(err, 'docker ps ' + args);
            t.equal(containers.length, expectedNames.length, 'Container count');
            var gotNames = containers.map(function (c) { return c.names; });
            t.deepEqual(gotNames.sort(), expectedNames.sort(),
                'Container names');
            t.end();
        });
    });
}


test('container filters', function (tt) {
    var containerName1 = common.makeContainerName(CONTAINER_PREFIX);
    var containerName2 = common.makeContainerName(CONTAINER_PREFIX);

    tt.test('create container 1', function (t) {
        var runArgs = format('-d --name %s --label fishing=true %s sleep 3600',
            containerName1, IMAGE_NAME);
        cli.run(t, {args: runArgs}, function (err, id) {
            t.ifErr(err, 'docker run ' + IMAGE_NAME);
            t.end();
        });
    });

    tt.test('create container 2', function (t) {
        var runArgs = format('-d --name %s --label fishing=fun %s sleep 3600',
            containerName2, IMAGE_NAME);
        cli.run(t, {args: runArgs}, function (err, id) {
            t.ifErr(err, 'docker run ' + IMAGE_NAME);
            t.end();
        });
    });

    // Filtering on the container label that comes from the image.
    checkContainerFiltering(tt, '--filter label=todd=cool',
        [containerName1, containerName2]);

    // Filtering on just the label name.
    checkContainerFiltering(tt, '--filter label=fishing',
        [containerName1, containerName2]);

    // Filtering on just the label name and value, which exists.
    checkContainerFiltering(tt, '--filter label=fishing=fun', [containerName2]);

    // Filtering on just the label name and value, which doesn't exist.
    checkContainerFiltering(tt, '--filter label=fishing=notfun', []);

    // Filtering on the container name prefix.
    checkContainerFiltering(tt, '--filter name=' + CONTAINER_PREFIX,
        [containerName1, containerName2]);

    // Filtering on the full container name.
    checkContainerFiltering(tt, '--filter name=' + containerName1,
        [containerName1]);

    // Filtering using multiple filters matching both containers.
    checkContainerFiltering(tt, '--filter name=' + CONTAINER_PREFIX
        + ' --filter label=fishing'
        + ' --filter label=todd=cool',
        [containerName1, containerName2]);

    // Filtering using multiple filters matching just one container.
    checkContainerFiltering(tt, '--filter name=' + CONTAINER_PREFIX
        + ' --filter label=fishing=fun'
        + ' --filter label=todd=cool',
        [containerName2]);
});


test('image filters', function (tt) {
    tt.test('filter on image label', function (t) {
        cli.images(t, {args: '--filter label=todd=cool'},
            function (err, images)
        {
            t.ifErr(err, 'docker images --filter');
            t.equal(images.length, 1, 'Check one image returned');
            t.equal(images[0].repository, IMAGE_NAME, 'Check image name');
            t.end();
        });
    });

    tt.test('filter on nonexistant image label', function (t) {
        cli.images(t, {args: '--filter label=todd=notcool'},
            function (err, images)
        {
            t.ifErr(err, 'docker images nonexistant --filter');
            t.deepEqual(images, []);
            t.end();
        });
    });
});


test('teardown', cli.rmAllCreated);
