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
var exec = require('child_process').exec;
var vasync = require('vasync');

var h = require('./helpers');



// --- Globals

var docker;
var vmapi;


// --- Tests

test('docker create', function (t) {
    t.plan(10);

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
                uuid = result.vm.uuid;
                next();
            }
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
