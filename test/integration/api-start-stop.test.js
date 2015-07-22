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

var ALICE;
var DOCKER;
var STATE = {
    log: require('../lib/log')
};
var VMAPI;


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.getDockerEnv(t, STATE, {account: 'sdcdockertest_alice'},
                function (err, env) {
            t.ifErr(err, 'docker env: alice');
            t.ok(env, 'have a DockerEnv for alice');
            ALICE = env;

            t.end();
        });
    });


    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient({user: ALICE}, function (err, client) {
            t.ifErr(err, 'docker client init');
            DOCKER = client;
            t.end();
        });
    });


    tt.test('vmapi client init', function (t) {
        h.createVmapiClient(function (err, client) {
            t.ifErr(err, 'vmapi client');
            VMAPI = client;
            t.end();
        });
    });

});


test('api: create', function (tt) {

    var id;

    tt.test('docker create', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER,
            test: t
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            id = result.id;
            t.end();
        }
    });


    tt.test('start container', function (t) {
        // Attempt to start new container
        DOCKER.post('/v1.16/containers/' + id + '/start', onpost);
        function onpost(err, res, req, body) {
            t.error(err);
            t.end(err);
        }
    });


    tt.test('confirm container started', function (t) {
        h.listContainers({
            all: true,
            dockerClient: DOCKER,
            test: t
        }, function (err, containers) {
            t.error(err);

            var found = containers.filter(function (c) {
                if (c.Id === id) {
                    return true;
                }
            });

            t.equal(found.length, 1, 'found our container');

            var matched = found[0].Status.match(/^Up /);
            t.ok(matched, 'container is started');
            if (!matched) {
                t.equal(found[0].Status, 'Status for debugging');
            }

            t.end();
        });
    });


    tt.test('stop container', function (t) {
        // Attempt to stop new container
        DOCKER.post('/v1.16/containers/' + id + '/stop', onpost);
        function onpost(err, res, req, body) {
            t.error(err);
            t.end(err);
        }
    });


    tt.test('confirm container stopped', function (t) {
        h.listContainers({
            all: true,
            dockerClient: DOCKER,
            test: t
        }, function (err, containers) {
            t.error(err);

            var found = containers.filter(function (c) {
                if (c.Id === id) {
                    return true;
                }
            });

            var matched = found[0].Status.match(/^Exited /);
            t.ok(matched, 'container is stopped');
            if (!matched) {
                t.equal(found[0].Status, 'Status for debugging');
            }

            t.end();
        });
    });


    tt.test('delete container', function (t) {
        DOCKER.del('/v1.15/containers/' + id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });




});
