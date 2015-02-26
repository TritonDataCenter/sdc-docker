/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker create`.
 */

var p = console.log;

var test = require('tape');
var util = require('util');
var vasync = require('vasync');
var exec = require('child_process').exec;
var sdcutils = require('../../lib/backends/sdc/utils');

var h = require('./helpers');



// --- Globals

var CLIENT;
var vmapi;


// --- Tests

test('/v1.15/containers/create', function (t) {
    t.plan(7);

    var payload = {
        'Hostname': '',
        'Domainname': '',
        'User': '',
        'Memory': 0,
        'MemorySwap': 0,
        'CpuShares': 0,
        'Cpuset': '',
        'AttachStdin': false,
        'AttachStdout': false,
        'AttachStderr': false,
        'PortSpecs': null,
        'ExposedPorts': {},
        'Tty': false,
        'OpenStdin': false,
        'StdinOnce': false,
        'Env': [],
        'Cmd': null,
        'Image': 'nginx',
        'Volumes': {},
        'WorkingDir': '',
        'Entrypoint': null,
        'NetworkDisabled': false,
        'OnBuild': null,
        'SecurityOpt': null,
        'HostConfig': {
            'Binds': null,
            'ContainerIDFile': '',
            'LxcConf': [],
            'Privileged': false,
            'PortBindings': {},
            'Links': null,
            'PublishAllPorts': false,
            'Dns': null,
            'DnsSearch': null,
            'ExtraHosts': null,
            'VolumesFrom': null,
            'Devices': [],
            'NetworkMode': 'bridge',
            'CapAdd': null,
            'CapDrop': null,
            'RestartPolicy': {
                'Name': '',
                'MaximumRetryCount': 0
            }
        }
    };

    var id;
    var uuid;

    vasync.waterfall([
        function (next) {
            // Create VMAPI client
            h.createVmapiClient(function (err, client) {
                t.error(err);
                vmapi = client;
                next(err);
            });
        },
        function (next) {
            // Create Docker client
            h.createDockerRemoteClient(function (err, client) {
                CLIENT = client;
                next(err);
            });
        },
        function (next) {
            // Post create request
            CLIENT.post('/v1.15/containers/create', payload, onpost);
            function onpost(err, res, req, body) {
                t.deepEqual(
                    body.Warnings, [], 'Warnings should be present and empty');
                t.ok(body.Id, 'Id should be present');
                id = body.Id;
                next(err);
            }
        },
        function (next) {
            // Attempt to get new container
            CLIENT.get('/v1.15/containers/' + id + '/json', onget);
            function onget(err, res, req, body) {
                t.error(err);
                uuid = sdcutils.dockerIdToUuid(id);
                next(err);
            }
        },
        function (next) {
            vmapi.getVm({ uuid: uuid }, function (err, vm) {
                t.error(err);
                next(err);
            });
        },
        function (next) {
            // Cheat
            exec('vmadm destroy ' + uuid, function (err, stdout, stderr) {
                t.error(err, 'vmadm destroy should succeed');
                next(err);
            });
        }
    ], function (err) {
        t.error(err);
        t.end();
    });
});
