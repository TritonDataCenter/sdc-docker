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
                    Labels: {
                        'foo': 'bar',
                        'todd': 'cool'
                    }
                }
            }
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
