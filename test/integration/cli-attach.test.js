/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for `docker attach`
 */

var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');


// --- Globals

var CONTAINER_PREFIX = 'sdcdockertest_';
var container = CONTAINER_PREFIX + 'attach_test';

var log = require('../lib/log');


/**
 * Setup
 */

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', cli.init);
});


/**
 * Tests
 */

test('test status code on attach exiting with implicit 0', function (tt) {
    removeTestContainers(tt);
    tt.test('create container ' + container, function (t) {
        t.plan(4);
        var cmd = 'sleep 20; echo done';

        cli.run(t, {
            args: '-d --name ' + container + ' -d ubuntu bash -c "' + cmd + '"'
        },
        function (err, id) {
            t.ifErr(err, 'docker run ' + container);

            cli.attach(t, { args: id },
            function (attachErr) {
                t.ifErr(attachErr, 'attach should have not returned an error');
                t.end();
            });
        });
    });
});


test('test status code on attach exiting with 2', function (tt) {
    removeTestContainers(tt);
    tt.test('create container ' + container, function (t) {
        t.plan(5);
        var cmd = 'sleep 20; exit 2';

        cli.run(t, {
            args: '-d --name ' + container + ' -d ubuntu bash -c "' + cmd + '"'
        },
        function (err, id) {
            t.ifErr(err, 'docker run ' + container);

            cli.attach(t, { args: id },
            function (attachErr) {
                t.ok(attachErr, 'attach should have returned an error');
                t.equal(attachErr.cause().code, 2,
                        'attach error status code should match');
                t.end();
            });
        });
    });
});


test('test status code on exec exiting with implicit 0',
function (tt) {
    removeTestContainers(tt);
    tt.test('create container ' + container, function (t) {
        t.plan(4);

        var cmd = 'echo yolo';

        cli.run(t, { args: '-d --name ' + container + ' -d nginx'  },
        function (err, id) {
            t.ifErr(err, 'docker run ' + container);

            cli.docker('exec ' + id + ' bash -c "' + cmd + '"',
            function (execErr) {
                t.ifErr(execErr, 'docker exec ' + container);
                t.end();
            });
        });
    });
});


test('test status code on exec exiting with 2',
function (tt) {
    removeTestContainers(tt);
    tt.test('create container ' + container, function (t) {
        t.plan(5);

        var cmd = 'exit 2';

        cli.run(t, { args: '-d --name ' + container + ' -d nginx'  },
        function (err, id) {
            t.ifErr(err, 'docker run ' + container);

            cli.docker('exec ' + id + ' bash -c "' + cmd + '"',
            function (execErr) {
                t.ok(execErr, 'docker exec ' + container);
                t.equal(execErr.cause().code, 2);
                t.end();
            });
        });
    });
});


/**
 * Cleanup
 */

test('container cleanup', function (tt) {
    removeTestContainers(tt);
});


/**
 * Support functions
 */

function removeTestContainers(tt) {
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
            }, function (forEachErr) {
                tt.ifErr(forEachErr);
                t.end();
            });
        });
    });
}
