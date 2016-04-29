/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Integration tests for affinity filters to 'docker run/docker create'.
 * See 'lib/.../affinity.js' for details.
 */

var format = require('util').format;
var libuuid = require('libuuid');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var vm = require('../lib/vm');


// --- Globals

var CONTAINER_PREFIX = 'sdcdockertest_affinity_';


// --- Tests

test('setup', function (tt) {
    tt.test('  test CLI init', cli.init);
    tt.test('  vmapi client init', vm.init);
});


test('affinities a la Swarm', function (tt) {
    var containerId;

    var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
    tt.ok(containerName, 'containerName: ' + containerName);

    /*
     * First test that a given affinity shows up as a label on the created
     * container.
     */
    tt.test('  docker run -e "affinity:foo!=bar" ...', function (t) {
        var args = format(
            '-e \'affinity:foo!=bar\' -d --name %s alpine sleep 3600',
            containerName);
        cli.run(t, {args: args}, function (err, id) {
            t.ifErr(err, 'docker run -e "affinity:foo!=bar" ...');
            containerId = id;
            t.end();
        });
    });

    tt.test('  check affinity label on container', function (t) {
        cli.inspect(t, {
            id: containerId,
            partialExp: {
                Config: {
                    Labels: {
                        'com.joyent.package': '*',
                        'com.docker.swarm.affinities': '["foo!=bar"]'
                    }
                }
            }
        });
    });
});


test('teardown', cli.rmAllCreated);
