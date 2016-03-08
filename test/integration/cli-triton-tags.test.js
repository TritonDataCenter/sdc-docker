/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Integration tests for Triton tags ("triton.*") on Docker containers.
 */

var format = require('util').format;
var libuuid = require('libuuid');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var vm = require('../lib/vm');


// --- Globals

var CONTAINER_PREFIX = 'sdcdockertest_triton_tags_';


// --- Tests

test('setup', function (tt) {
    tt.test('  test CLI init', cli.init);
    tt.test('  vmapi client init', vm.init);
});


test('triton.* tags/labels', function (tt) {
    var containerId;

    var containerName = CONTAINER_PREFIX + libuuid.create().split('-')[0];
    tt.ok(containerName, 'containerName: ' + containerName);

    /*
     * First test that a "triton." label applied as part of `docker run ...`
     * results in a "triton." tag on the VM (without the usual "docker:label:"
     * prefix) and appears in `docker inspect ...`.
     */
    tt.test('  docker run --label triton.cns.disable=true ...', function (t) {
        var args = format(
            '--label triton.cns.disable=true -d --name %s alpine sleep 3600',
            containerName);
        cli.run(t, {args: args}, function (err, id) {
            t.ifErr(err, 'docker run --label triton.cns.disable=true ...');
            containerId = id;
            t.end();
        });
    });

    tt.test('  check triton.cns.disable label on container', function (t) {
        cli.inspect(t, {
            id: containerId,
            partialExp: {
                Config: {
                    Labels: {
                        'com.joyent.package': '*',
                        // Note that Docker labels are *strings*, hence 'true'.
                        'triton.cns.disable': 'true'
                    }
                }
            }
        });
    });

    tt.test('  check triton.cns.disable tag on VM', function (t) {
        vm.get(t, {
            id: containerId,
            partialExp: {
                tags: {
                    'sdc_docker': true,
                    // VMAPI tags can be boolean, hence `true` here.
                    'triton.cns.disable': true
                }
            }
        });
    });


    /*
     * Next, test that we can update "triton.*" tags on the VM (via VMAPI)
     * and have those updates show in `docker inspect ...`.
     */
    tt.test('  add/update triton.* tags via VMAPI', function (t) {
        vm.addTags(t, {
            id: containerId,
            tags: {
                'triton.cns.disable': false,
                'triton.cns.services': 'foo,bar'
            }
        });
    });

    // Updating tags is async, so need to wait for them to propogate.
    tt.test('  wait for VMAPI tag updates', function (t) {
        vm.waitForTagUpdate(t, {
            id: containerId,
            tags: {
                'triton.cns.disable': false,
                'triton.cns.services': 'foo,bar'
            },
            timeout: 30 * 1000 // give it max 30s to update
        });
    });

    tt.test('  check VMAPI tag updates on container labels', function (t) {
        cli.inspect(t, {
            id: containerId,
            partialExp: {
                Config: {
                    Labels: {
                        'com.joyent.package': '*',
                        // Note that Docker labels are *strings*, hence 'true'.
                        'triton.cns.disable': 'false',
                        'triton.cns.services': 'foo,bar'
                    }
                }
            }
        });
    });


    /*
     * Next, sanity check that "triton.*" labels to "docker run" are
     * validated.
     */
    tt.test('  invalid triton tag: triton.cns.disable=nonbool', function (t) {
        var name = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        var args = format(
            '--label triton.cns.disable=nonbool -d --name %s alpine hostname',
            name);
        cli.run(t, {
            args: args,
            /* JSSTYLED */
            expectedErr: 'Error response from daemon: (Validation) invalid label: Triton tag "triton.cns.disable" value must be "true" or "false": "nonbool"'
        });
    });

    tt.test('  invalid triton tag: triton.bogus=foo', function (t) {
        var name = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        var args = format(
            '--label triton.bogus=foo -d --name %s alpine hostname', name);
        cli.run(t, {
            args: args,
            /* JSSTYLED */
            expectedErr: 'Error response from daemon: (Validation) invalid label: Unrecognized special triton tag "triton.bogus"'
        });
    });

    tt.test('  invalid triton tag: triton._test.boolean=nonbool', function (t) {
        var name = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        var args = format(
            '--label triton._test.boolean=nonbool -d --name %s alpine hostname',
            name);
        cli.run(t, {
            args: args,
            /* JSSTYLED */
            expectedErr: 'Error response from daemon: (Validation) invalid label: Triton tag "triton._test.boolean" value must be "true" or "false": "nonbool"'
        });
    });

    tt.test('  invalid triton tag: triton._test.number=nonnum', function (t) {
        var name = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        var args = format(
            '--label triton._test.number=nonnum -d --name %s alpine hostname',
            name);
        cli.run(t, {
            args: args,
            /* JSSTYLED */
            expectedErr: 'Error response from daemon: (Validation) invalid label: Triton tag "triton._test.number" value must be a number: "nonnum"'
        });
    });

    tt.test('  invalid triton tag: triton._test.boolean=<empty>', function (t) {
        var name = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        var args = format(
            '--label triton._test.boolean= -d --name %s alpine hostname',
            name);
        cli.run(t, {
            args: args,
            /* JSSTYLED */
            expectedErr: 'Error response from daemon: (Validation) invalid label: Triton tag "triton._test.boolean" value must be "true" or "false": ""'
        });
    });

    tt.test('  invalid triton tag: triton._test.number=<empty>', function (t) {
        var name = CONTAINER_PREFIX + libuuid.create().split('-')[0];
        var args = format(
            '--label triton._test.number= -d --name %s alpine hostname',
            name);
        cli.run(t, {
            args: args,
            /* JSSTYLED */
            expectedErr: 'Error response from daemon: (Validation) invalid label: Triton tag "triton._test.number" value must be a number: ""'
        });
    });
});


test('teardown', cli.rmAllCreated);
