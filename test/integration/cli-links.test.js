/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Integration tests for docker links.
 */

var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var h = require('./helpers');
var vm = require('../lib/vm');


// --- Globals

var ALICE;
var CONTAINER_PREFIX = 'sdcdockertest_link_';
var TEST_IMAGE = 'joyentunsupported/test-nginx:1.0.0';
var BUSYBOX_IMAGE = 'busybox';


// --- Tests

test('setup', function (tt) {

    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, function (err, result) {
            // Note that err checking and t.end() are done in cli.init()
            if (!err) {
                ALICE = result.user;
            }
        });
    });

    tt.test('vmapi client', vm.init);

    tt.test('pull test-nginx image', function (t) {
        h.ensureImage({
            name: TEST_IMAGE,
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling test-nginx image');
            t.end();
        });
    });

    tt.test('pull busybox image', function (t) {
        h.ensureImage({
            name: BUSYBOX_IMAGE,
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling busybox image');
            t.end();
        });
    });
});


test('delete old vms', function (tt) {

    tt.test('remove old containers', function (t) {
        cli.ps(t, {args: '-a'}, function (err, entries) {
            t.ifErr(err, 'docker ps');

            var oldContainers = entries.filter(function (entry) {
                return (entry.names.substr(0, CONTAINER_PREFIX.length)
                        === CONTAINER_PREFIX);
            });

            vasync.forEachParallel({
                inputs: oldContainers,
                func: function _delOne(entry, cb) {
                    cli.rm(t, {args: '-f ' + entry.container_id},
                            function (err2)
                    {
                        t.ifErr(err2, 'rm container ' + entry.container_id);
                        cb();
                    });
                }
            }, function () {
                t.end();
            });
        });
    });
});


test('linked env', function (tt) {

    var nginxName = CONTAINER_PREFIX + 'nginx';
    tt.test('linked env: create custom nginx -p 80:80', function (t) {
        cli.run(t, { args: '-d --name ' + nginxName + ' -e FOO=BAR -e BAT=BAZZA'
                    + ' -p 80:80 ' + TEST_IMAGE });
    });


    var bboxName = CONTAINER_PREFIX + 'bbox';
    tt.test('linked env: create busybox with nginx link', function (t) {
        cli.run(t, { args: '-d --name ' + bboxName
                    + ' --link ' + nginxName + ':ngx'
                    + ' ' + BUSYBOX_IMAGE + ' top' });
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
                'NGX_NAME=/' + bboxName + '/ngx',
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
            var privateIpRegex = new RegExp('(^10\\.)'
                                        + '|(^172\\.1[6-9]\\.)'
                                        + '|(^172\\.2[0-9]\\.)'
                                        + '|(^172\\.3[0-1]\\.)'
                                        + '|(^192\\.168\\.)');
            expectedPortEnvNames.forEach(function (e) {
                var match;
                for (var i = 0; i < linkEnv.length; i++) {
                    match = linkEnv[i].match(e);
                    if (match) {
                        // Check that the the tcp address is internal.
                        if ((e.indexOf('tcp://') > 0)
                            && (!match[1].match(privateIpRegex)))
                        {
                            t.fail('linked env is not using a private ip: '
                                    + linkEnv[i]);
                        }
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
                '\\b' + nginxName + '\\b'
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
            id: bboxName,
            partialExp: {
                HostConfig: {
                    Links: [
                        '/' + nginxName + ':/' + bboxName + '/ngx'
                    ]
                }
            }
        });
    });


    tt.test('link removal', function (t) {
        cli.docker('rm --link /' + bboxName + '/ngx',
                    function (err, stdout, stderr)
        {
            t.ifErr(err, 'docker rm --link');

            cli.inspect(t, {
                id: bboxName,
                partialExp: {
                    HostConfig: {
                        Links: null
                    }
                }
            });
        });
    });
});


test('link rename', function (tt) {

    var targName = CONTAINER_PREFIX + 'target';
    var contName = CONTAINER_PREFIX + 'link_container';
    var targNameRenamed = targName + '_r';
    var contNameRenamed = contName + '_r';

    tt.test(' create link_target', function (t) {
        cli.run(t, { args: '-d --name ' + targName
            + ' ' + BUSYBOX_IMAGE + ' top' });
    });


    tt.test(' create link_container', function (t) {
        cli.run(t, { args: '-d --name ' + contName
                    + ' --link ' + targName + ':target'
                    + ' ' + BUSYBOX_IMAGE + ' top' });
    });


    tt.test(' rename target', function (t) {
        cli.docker('rename ' + targName + ' ' + targNameRenamed,
                    function (err, stdout, stderr)
        {
            t.ifErr(err, 'docker rename');

            cli.inspect(t, {
                id: contName,
                partialExp: {
                    HostConfig: {
                        Links: [
                            '/' + targNameRenamed + ':/' + contName + '/target'
                        ]
                    }
                }
            });
        });
    });


    tt.test(' rename container', function (t) {
        cli.docker('rename ' + contName + ' ' + contNameRenamed,
                    function (err, stdout, stderr)
        {
            t.ifErr(err, 'docker rename');

            cli.inspect(t, {
                id: contNameRenamed,
                partialExp: {
                    HostConfig: {
                        Links: [
                            '/' + targNameRenamed + ':'
                            + '/' + contNameRenamed + '/target'
                        ]
                    }
                }
            });
        });
    });


    tt.test(' restart container', function (t) {
        cli.docker('restart ' + contNameRenamed,
                    function (err, stdout, stderr)
        {
            t.ifErr(err, 'docker restart');

            cli.docker('exec ' + contNameRenamed + ' sh -c export',
                        function (err2, stdout2, stderr2)
            {
                t.ifErr(err2, 'docker exec export');

                var envName = 'TARGET_NAME=\'/' + contNameRenamed + '/target\'';
                if (stdout2.indexOf(envName) === -1) {
                    t.fail('env var ' + envName + ' not found in\n' + stdout2);
                }

                cli.docker('exec ' + contNameRenamed + ' cat /etc/hosts',
                            function (err3, stdout3, stderr3)
                {
                    t.ifErr(err3, 'docker exec cat');

                    var hostName = targNameRenamed;
                    if (stdout3.indexOf(hostName) === -1) {
                        t.fail('host ' + hostName + ' not found in\n'
                                + stdout3);
                    }

                    t.end();
                });
            });
        });
    });
});


test('teardown', cli.rmAllCreated);
