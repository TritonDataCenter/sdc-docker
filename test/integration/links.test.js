/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for docker links.
 */

var cli = require('../lib/cli');
var vm = require('../lib/vm');
var test = require('tape');



// --- Globals


var CLIENTS = {};


// --- Helpers


// --- Tests


test('setup', function (tt) {

    tt.test('DockerEnv: alice init', cli.init);

    tt.test('vmapi client', vm.init);
});


test('linked env', function (tt) {

    tt.test('linked env: create custom nginx -p 80:80', function (t) {
        cli.run(t, { args: '-d --name nginx_custom -e FOO=BAR -e BAT=BAZZA'
                    + ' -p 80:80 nginx' });
    });


    tt.test('linked env: create busybox with nginx link', function (t) {
        cli.run(t, { args: '-d --name bbx --link nginx_custom:ngx'
                    + ' busybox top' });
    });


    tt.test('linked env: VMAPI tags', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                tags: {
                    sdc_docker: true
                }
            }
        }, function (err, vmobj) {
            if (err) {
                return;
            }

            var im = vmobj.internal_metadata;
            var linkEnv = JSON.parse(im['docker:linkEnv'] || '[]');

            var expectedLinkEnv = [
                'NGX_NAME=/bbx/ngx',
                'NGX_ENV_FOO=BAR',
                'NGX_ENV_BAT=BAZZA'
            ];
            expectedLinkEnv.forEach(function (e) {
                if (linkEnv.indexOf(e) == -1) {
                    t.fail('env var ' + e + ' not found in '
                            + im['docker:linkEnv']);
                }
            });

            // Regular expressions (to cope with the ip address):
            var expectedPortEnvNames = [
                'NGX_PORT_80_TCP=tcp://(.*?):80',
                'NGX_PORT_80_TCP_ADDR=[0-9.]*',
                'NGX_PORT_80_TCP_PORT=80',
                'NGX_PORT_80_TCP_PROTO=tcp',
                'NGX_PORT_443_TCP=tcp://(.*?):443',
                'NGX_PORT_443_TCP_ADDR=[0-9.]*',
                'NGX_PORT_443_TCP_PORT=443',
                'NGX_PORT_443_TCP_PROTO=tcp'
            ];
            expectedPortEnvNames.forEach(function (e) {
                for (var i = 0; i < linkEnv.length; i++) {
                    if (linkEnv[i].match(e)) {
                        return;
                    }
                }
                t.fail('env var ' + e + ' not found in '
                        + im['docker:linkEnv']);
            });

            var linkHosts = im['docker:linkHosts'] || '';
            // Regular expressions:
            var expectedHosts = [
                '\\b' + 'ngx' + '\\b',
                '\\b' + 'nginx_custom' + '\\b'
            ];
            expectedHosts.forEach(function (e) {
                if (!linkHosts.match(e)) {
                    t.fail('host ' + e + ' not found in ' + linkHosts);
                }
            });

            t.end();
        });
    });


    tt.test('link inspect', function (t) {
        cli.inspect(t, {
            id: 'bbx',
            partialExp: {
                HostConfig: {
                    Links: [
                        '/nginx_custom:/bbx/ngx'
                    ]
                }
            }
        });
    });


    tt.test('link removal', function (t) {
        cli.docker('rm --link /bbx/ngx', function (err, stdout, stderr) {
            t.ifErr(err, 'docker rm --link');

            cli.inspect(t, {
                id: 'bbx',
                partialExp: {
                    HostConfig: {
                        Links: null
                    }
                }
            });
        });
    });
});


test('teardown', cli.rmAllCreated);
