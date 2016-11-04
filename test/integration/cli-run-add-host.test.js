/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Integration tests for 'docker run --add-host ...' (aka "ExtraHosts").
 */

var format = require('util').format;
var libuuid = require('libuuid');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var vm = require('../lib/vm');


// --- Globals

var CONTAINER_PREFIX = 'sdcdockertest_runaddhost_';


// --- Tests

test('setup', function (tt) {
    tt.test('  test CLI init', cli.init);
    tt.test('  vmapi client init', vm.init);
});


test('docker run --add-host foo:1.2.3.4', function (tt) {
    var containerId;

    var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
    tt.ok(containerName, 'containerName: ' + containerName);

    tt.test('  docker run --add-host foo:1.2.3.4 ...', function (t) {
        var args = format(
            '--add-host foo:1.2.3.4 -d --name %s alpine sleep 3600',
            containerName);
        cli.run(t, {args: args}, function (err, id) {
            t.ifErr(err, 'docker run --add-host foo:1.2.3.4 ...');
            containerId = id;
            t.end();
        });
    });

    tt.test('  check VM.internal_metadata["docker:extraHosts"]', function (t) {
        vm.get(t, {
            id: containerId,
            partialExp: {
                internal_metadata: {
                    'docker:extraHosts': '["foo:1.2.3.4"]'
                }
            }
        });
    });

    tt.test('  check that /etc/hosts has the "foo" entry', function (t) {
        var cmd = 'exec ' + containerName + ' grep foo /etc/hosts';
        cli.docker(cmd, function (err, stdout, stderr) {
            t.ifErr(err, 'docker CONTAINER grep foo /etc/hosts');
            t.equal(stdout, '1.2.3.4\tfoo\n');
            t.end();
        });
    });

    tt.test('  check that ExtraHosts is set in inspect output', function (t) {
        cli.inspect(t, {
            id: containerId,
            partialExp: {
                HostConfig: {
                    ExtraHosts: ['foo:1.2.3.4']
                }
            }
        });
    });
});


test('teardown', cli.rmAllCreated);
