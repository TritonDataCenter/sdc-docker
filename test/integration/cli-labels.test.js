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
var libuuid = require('libuuid');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var vm = require('../lib/vm');


// --- Globals

var CLIENTS = {};
var CONTAINER_PREFIX = 'sdcdockertest_labels_';
var IMAGE_NAME = 'joyent/busybox_with_label_test';



// --- internal support functions

/*
 * Get a prefixed, randomized name for a test container.
 */
function getContainerName() {
    return CONTAINER_PREFIX + libuuid.create().split('-')[0];
}


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
            getContainerName());
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
            getContainerName(), IMAGE_NAME);
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
            getContainerName(), IMAGE_NAME);
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


test('labels image filtering', function (tt) {
    // Ensure the mybusybox image is available.
    tt.test('conflicting label', function (t) {
        var runArgs = format('-d --name %s %s sleep 3600',
            getContainerName(), IMAGE_NAME);
        cli.run(t, {args: runArgs}, function (err, id) {
            t.ifErr(err, 'docker run ' + IMAGE_NAME);
            t.end();
        });
    });


    tt.test('filter on image label', function (t) {
        cli.docker('images --filter label=todd=cool',
                    function (err, stdout, stderr)
        {
            t.ifErr(err, 'docker images --filter');
            var lines = stdout.split('\n');

            if (lines.filter(function (line) {
                return line.substr(0, IMAGE_NAME.length) === IMAGE_NAME;
                }).length === 0)
            {
                t.fail('Filter did not return the expected image: ' + stdout);
            }
            t.end();
        });
    });

    tt.test('filter on bogus image label', function (t) {
        cli.docker('images --filter label=todd=notcool',
                    function (err, stdout, stderr)
        {
            t.ifErr(err, 'docker images --filter');
            var lines = stdout.split('\n');

            if (lines.filter(function (line) {
                return line.substr(0, IMAGE_NAME.length) === IMAGE_NAME;
                }).length !== 0)
            {
                t.fail('Filter returned an expected image: ' + stdout);
            }
            t.end();
        });
    });
});


test('teardown', cli.rmAllCreated);
