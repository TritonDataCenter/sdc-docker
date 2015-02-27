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

var docker;
var vmapi;


// --- Tests

test('docker rm', function (t) {
    t.plan(12);

    var created;

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
                docker = client;
                next(err);
            });
        },
        function (next) {
            h.createDockerContainer({
                vmapiClient: vmapi,
                dockerClient: docker,
                test: t
            }, oncreate);

            function oncreate(err, result) {
                t.error(err);
                created = result;
                t.ok(created.uuid);
                t.ok(created.id);
                next();
            }
        },
        function (next) {
            docker.del('/v1.15/containers/' + created.id, ondel);
            function ondel(err, res, req, body) {
                console.log(body);
                console.log('deleted');
                next(err);
            }
        },
        function (next) {
            vmapi.getVm({ uuid: created.uuid }, function (err, vm) {
                t.error(err);
                t.equal(vm.state, 'destroyed', 'should show up as destroyed');
                next(err);
            });
        }
    ], function (err) {
        t.error(err);
        t.end();
    });
});
