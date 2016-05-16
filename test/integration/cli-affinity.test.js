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
    // This should fail: no container with name 'sdcdockertest_affinity_*'.
    tt.test('  docker run -e "affinity:container==' + CONTAINER_PREFIX
            + '*" ... (container, ==, fail)', function (t) {
        var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        t.ok(containerName, 'containerName: ' + containerName);
        var args = format('-e \'affinity:container==' + CONTAINER_PREFIX
            + '*\' -d --name %s alpine sleep 3600', containerName);
        cli.run(t, {
            args: args,
            // JSSTYLED
            expectedErr: /\(ResourceNotFound\) no active containers found matching "sdcdockertest_affinity_\*" for affinity "container==sdcdockertest_affinity_\*"/
        }, function (err) {
            t.end();
        });
    });

    // This should work: no container with name 'sdcdockertest_affinity_*'.
    // This behaviour was changed in DAPI-306.
    tt.test('  docker run -e "affinity:container!=' + CONTAINER_PREFIX
            + '*" ... (container, !=)', function (t) {
        var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        t.ok(containerName, 'containerName: ' + containerName);
        var args = format('-e \'affinity:container!=' + CONTAINER_PREFIX
            + '*\' -d --name %s alpine sleep 3600', containerName);
        cli.run(t, {args: args}, function (err, id) {
            t.ifErr(err, 'docker run error');
            t.ok(id, 'id');
            t.end();
        });
    });

    // This should fail: no container with label foo=bar2.
    tt.test('  docker run -e "affinity:foo==bar2" ... (label, ==, fail)',
            function (t) {
        var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        t.ok(containerName, 'containerName: ' + containerName);
        var args = format(
            '-e \'affinity:foo==bar2\' -d --name %s alpine sleep 3600',
            containerName);
        cli.run(t, {
            args: args,
            expectedErr: 'Error response from daemon: (ResourceNotFound) '
                + 'no active containers found matching tag "foo=bar2" for '
                + 'affinity "foo==bar2"'
        }, function (err) {
            t.end();
        });
    });

    // This should work: no container with label foo=bar2, but *soft* affinity.
    tt.test('  docker run -e "affinity:foo==~bar2" ... (label, ==~)',
            function (t) {
        var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        t.ok(containerName, 'containerName: ' + containerName);
        var args = format(
            '-e \'affinity:foo==~bar2\' -d --name %s alpine sleep 3600',
            containerName);
        cli.run(t, {args: args}, function (err, id) {
            t.ifErr(err, 'docker run error');
            t.ok(id, 'id');
            t.end();
        });
    });

    // This should work: no container with label foo=bar1.
    var containerId;
    tt.test('  docker run -e "affinity:foo!=bar1" ... (label, !=)',
            function (t) {
        var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        t.ok(containerName, 'containerName: ' + containerName);
        var args = format(
            '-e \'affinity:foo!=bar1\' --label foo=bar2 -d '
                + '--name %s alpine sleep 3600',
            containerName);
        cli.run(t, {args: args}, function (err, id) {
            t.ifErr(err, 'docker run error');
            t.ok(id, 'id');
            containerId = id;
            t.end();
        });
    });
    tt.test('  have "com.docker.swarm.affinities" label', function (t) {
        cli.inspect(t, {
            id: containerId,
            partialExp: {
                Config: {
                    Labels: {
                        'com.joyent.package': '*',
                        'com.docker.swarm.affinities': '["foo!=bar1"]',
                        'foo': 'bar2'
                    }
                }
            }
        });
    });

    // Now this one should work: we *do* have a container with label foo=bar2
    // (created in previous step).
    tt.test('  docker run -e "affinity:foo==bar2" ... (label, ==)',
            function (t) {
        var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        t.ok(containerName, 'containerName: ' + containerName);
        var args = format(
            '-e \'affinity:foo==bar2\' -d --name %s alpine sleep 3600',
            containerName);
        cli.run(t, {args: args}, function (err, id) {
            t.ifErr(err, 'docker run error');
            t.ok(id, 'id');
            t.end();
        });
    });
});


test('teardown', cli.rmAllCreated);
