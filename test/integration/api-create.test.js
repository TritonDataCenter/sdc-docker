/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker create` using the Remote API directly.
 */

var p = console.log;

var fmt  = require('util').format;
var exec = require('child_process').exec;
var test = require('tape');
var util = require('util');
var vasync = require('vasync');

var configLoader = require('../../lib/config-loader.js');

var h = require('./helpers');



// --- Globals
var BYTES_IN_MB = 1024 * 1024;
var ALICE;
var BOB;
var DOCKER_ALICE;
var DOCKER_BOB;
var STATE = {
    log: require('../lib/log')
};
var CONFIG = configLoader.loadConfigSync({log: STATE.log});
var VMAPI;


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;
            BOB   = accounts.bob;

            t.end();
        });
    });


    tt.test('docker client init', function (t) {
        vasync.parallel({ funcs: [
            function createAliceJson(done) {
                h.createDockerRemoteClient({user: ALICE},
                    function (err, client) {
                        t.ifErr(err, 'docker client init for alice');
                        done(err, client);
                    }
                );
            },
            function createBobJson(done) {
                h.createDockerRemoteClient({user: BOB},
                    function (err, client) {
                        t.ifErr(err, 'docker client init for bob');
                        return done(err, client);
                    }
                );
            }
        ]}, function allDone(err, results) {
            t.ifError(err, 'docker client init should be successful');
            DOCKER_ALICE = results.operations[0].result;
            DOCKER_BOB = results.operations[1].result;
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

    var created;

    tt.test('pull nginx image', function (t) {
        var url = '/images/create?fromImage=nginx%3Alatest';
        DOCKER_ALICE.post(url, function (err, req, res) {
            t.error(err, 'should be no error posting image create request');

            t.end();
        });
    });

    tt.test('docker create', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

    tt.test('docker create without approved_for_provisioning', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_BOB,
            // we expect errors here, so stub this out
            test: {
                deepEqual: stub,
                equal: stub,
                error: stub,
                ok: stub
            }
        }, oncreate);

        function oncreate(err, result) {
            t.ok(err, 'should not create without approved_for_provisioning');
            t.equal(err.statusCode, 403);

            var expected = BOB.login + ' does not have permission to pull or '
                + 'provision';
            t.ok(err.message.match(expected));

            t.end();
        }

        function stub() {}
    });

    tt.test('docker create without memory override', function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.equal(created.vm.ram, CONFIG.defaultMemory,
                    'VM with default memory specs should be created with '
                    + CONFIG.defaultMemory + ' MBs of RAM');
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

    tt.test('docker create with 2GB memory', function (t) {
        var MEMORY_IN_MBS = CONFIG.defaultMemory * 2;
        var memory = MEMORY_IN_MBS * BYTES_IN_MB;

        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.Memory': memory }
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.equal(created.vm.ram, MEMORY_IN_MBS,
                    'VM should be created with ' + MEMORY_IN_MBS
                    + 'MBs of RAM');
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

    tt.test('docker create with invalid memory',
            function (t) {
        h.createDockerContainer({
            vmapiClient: VMAPI,
            dockerClient: DOCKER_ALICE,
            test: t,
            extra: { 'HostConfig.Memory': 'Foo' }
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'create container');
            created = result;
            t.equal(created.vm.ram, CONFIG.defaultMemory,
                    'VM should be created with ' + CONFIG.defaultMemory
                    + 'MBs of RAM');
            t.end();
        }
    });

    tt.test('docker rm', function (t) {
        DOCKER_ALICE.del('/containers/' + created.id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

    tt.test('delete nginx image', function (t) {
        DOCKER_ALICE.del('/images/nginx', ondel);
        function ondel(err, req, res) {
            t.error(err, 'should be no error deleting nginx');
            t.end();
        }
    });

});
