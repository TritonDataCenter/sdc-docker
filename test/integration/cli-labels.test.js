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
var CONTAINER_PREFIX = 'sdcdockertest_labels_';
var IMAGE_NAME = 'joyentunsupported/busybox_with_label_test';



// --- Tests

test('setup', function (tt) {

    tt.test('DockerEnv: alice init', cli.init);

    tt.test('vmapi client', vm.init);
});


test('labels', function (tt) {
    var containerId;

    tt.test('simple label', function (t) {
        var runArgs = format('-d --label foo=bar --name %s '
            + '--label "elem=something with a space" busybox sleep 3600',
            common.makeResourceName(CONTAINER_PREFIX));
        cli.run(t, {args: runArgs}, function (err, id) {
            t.ifErr(err, 'docker run --label foo=bar busybox');
            containerId = id;
            t.end();
        });
    });


    tt.test('simple label check', function (t) {
        cli.inspect(t, {
            id: containerId,
            partialExp: {
                Config: {
                    Labels: {
                        'com.joyent.package': '*',
                        'foo': 'bar',
                        'elem': 'something with a space'
                    }
                }
            }
        });
    });
});


test('labels on container', function (tt) {

    var containerId;
    var expectedLabels = {
        'com.joyent.package': '*',
        'foo': 'bar',  // from the command line
        'todd': 'cool' // from the image
    };

    tt.test('container label', function (t) {
        var runArgs = format('-d --name %s --label foo=bar %s sleep 3600',
            common.makeResourceName(CONTAINER_PREFIX), IMAGE_NAME);
        cli.run(t, {args: runArgs}, function (err, id) {
            t.ifErr(err, 'docker run --label foo=bar ' + IMAGE_NAME);
            containerId = id;
            t.end();
        });
    });


    tt.test('container label check', function (t) {
        cli.inspect(t, {
            id: containerId,
            partialExp: {
                Config: {
                    Labels: expectedLabels
                }
            }
        });
    });


    tt.test('label ps check', function (t) {
        cli.ps(t, {args: '-a'}, function (err, entries) {
            t.ifErr(err, 'docker ps');
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].Id === containerId) {
                    t.deepEqual(entries[i], expectedLabels);
                    break;
                }
            }
            t.end();
        });
    });
});


/**
 * Test adding a label with the same name as one on the image, 'todd', and
 * ensure the one added on the container "wins".
 */
test('labels conflict', function (tt) {

    var containerId;

    tt.test('conflicting label', function (t) {
        var runArgs = format('-d --name %s --label todd=notcool %s sleep 3600',
            common.makeResourceName(CONTAINER_PREFIX), IMAGE_NAME);
        cli.run(t, {args: runArgs}, function (err, id) {
            t.ifErr(err, 'docker run --label todd=notcool ' + IMAGE_NAME);
            containerId = id;
            t.end();
        });
    });


    tt.test('conflicting label check', function (t) {
        cli.inspect(t, {
            id: containerId,
            partialExp: {
                Config: {
                    Labels: {
                        'com.joyent.package': '*',
                        'todd': 'notcool'
                    }
                }
            }
        });
    });
});


test('teardown', cli.rmAllCreated);
