/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for docker start and stop using the Remote API directly.
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

test.skip('api: start stop', function (tt) {

    tt.test('docker start stop', function (t) {
        t.plan(22);

        var uuid;
        var id;

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
                    id = result.id;
                    uuid = result.vm.uuid;
                    next();
                }
            },
            function (next) {
                // Attempt to get new container
                docker.post('/v1.16/containers/' + id + '/start', onpost);
                function onpost(err, res, req, body) {
                    t.error(err);
                    next(err);
                }
            },
            function (next) {
                h.listContainers({
                    all: true,
                    dockerClient: docker,
                    test: t
                }, function (err, containers) {
                    t.error(err);

                    var found = containers.filter(function (c) {
                        if (c.Id === id) {
                            return true;
                        }
                    });

                    t.equal(found.length, 1, 'found our container');
                    t.ok(found[0].Status.match(/^Up /), 'container is started');

                    next();
                });
            },
            function (next) {
                // Attempt to get new container
                docker.post('/v1.16/containers/' + id + '/stop', onpost);
                function onpost(err, res, req, body) {
                    t.error(err);
                    next(err);
                }
            },
            function (next) {
                h.listContainers({
                    all: true,
                    dockerClient: docker,
                    test: t
                }, function (err, containers) {
                    t.error(err);

                    var found = containers.filter(function (c) {
                        if (c.Id === id) {
                            return true;
                        }
                    });

                    t.equal(found.length, 1, 'found our container');
                    t.ok(found[0].Status.match(/^Exited /),
                        'container is started');

                    next();
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
});
