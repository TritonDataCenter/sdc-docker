/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for docker labels.
 */

var cli = require('../lib/cli');
var vm = require('../lib/vm');
var test = require('tape');
var vasync = require('vasync');



// --- Globals


var CLIENTS = {};
var CONTAINER_PREFIX = 'sdcdockertest_labels_';


// --- Helpers


// --- Tests


test('setup', function (tt) {

    tt.test('DockerEnv: alice init', cli.init);

    tt.test('vmapi client', vm.init);
});


test('labels', function (tt) {
    var containerId;

    tt.test('simple label', function (t) {
        cli.run(t, { args: '-d --label foo=bar '
                        + '--label "elem=something with a space" '
                        + 'busybox sleep 3600' }, function (err, id)
        {
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
        'foo': 'bar',  // from the command line
        'todd': 'cool' // from the image
    };

    tt.test('container label', function (t) {
        cli.run(t, { args: '-d --label foo=bar '
                        + 'toddw/mybusybox sleep 3600' }, function (err, id)
        {
            t.ifErr(err, 'docker run --label foo=bar toddw/mybusybox');
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


test('labels conflict', function (tt) {

    var containerId;

    tt.test('conflicting label', function (t) {
        cli.run(t, { args: '-d --label todd=notcool '
                        + 'toddw/mybusybox sleep 3600' }, function (err, id)
        {
            t.ifErr(err, 'docker run --label todd=notcool toddw/mybusybox');
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
        cli.run(t, { args: '-d toddw/mybusybox sleep 3600' },
            function (err, id)
        {
            t.ifErr(err, 'docker run toddw/mybusybox');
            t.end();
        });
    });


    tt.test('filter on image label', function (t) {
        cli.docker('images --filter label=todd=cool',
                    function (err, stdout, stderr)
        {
            t.ifErr(err, 'docker images --filter');
            var lines = stdout.split('\n');
            var imageName = 'toddw/mybusybox';

            if (lines.filter(function (line) {
                return line.substr(0, imageName.length) === imageName;
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
            var imageName = 'toddw/mybusybox';

            if (lines.filter(function (line) {
                return line.substr(0, imageName.length) === imageName;
                }).length !== 0)
            {
                t.fail('Filter returned an expected image: ' + stdout);
            }
            t.end();
        });
    });
});


test('teardown', cli.rmAllCreated);
