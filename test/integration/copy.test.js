/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker copy`
 */

var sprintf = require('sprintf').sprintf;
var test = require('tape');
var vasync = require('vasync');
var crypto = require('crypto');
var exec = require('child_process').exec;

var cli = require('../lib/cli');
var h = require('./helpers');
var vm = require('../lib/vm');


var CONTAINER_PREFIX = 'sdcdockertest_copy_';

// --- Globals

var log = require('../lib/log');
var state = {
    log: log
};

var nginxName = CONTAINER_PREFIX + 'nginx';

// --- Tests

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', cli.init);
    tt.test('vmapi client', vm.init);
});


test('test initialization', function (tt) {
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

    tt.test('env', function (t) {
        cli.run(t, { args: '-d --name ' + nginxName + ' nginx' });
    });
});


test('copy a file out of container', function (tt) {
    var fnbase = '/var/tmp';
    var fn = 'random.test1';
    var ffn = fnbase + '/' + fn;

    // Create a file and get a checksum of it
    tt.test('create test file', function (t) {
        var inside = [
            'dd if=/dev/urandom count=1024 bs=1024',
            'tee ' + ffn,
            '/native/usr/bin/sum -x sha1'
        ].join('| \\\n');
        var args = sprintf('exec %s bash -c "%s"', nginxName, inside);
        cli.docker(args, onDocker);

        function onDocker(err, stdout, stderr) {
            t.ifErr(err);
            console.log(stdout.trim());
            t.end();
        }
    });

    tt.test('copy and check test file', function (t) {
        var args = sprintf(
            'cp %s:%s - | tar xOf - var/tmp/%s',
            nginxName, ffn, fn);
        var execOpts = { maxBuffer: 1024*1024+1, encoding: 'binary' };
        cli.docker(args, { execOpts: execOpts }, onDocker);
        function onDocker(err, stdout, stderr) {
            t.ifErr(err);
            var str = stdout.toString();
            console.log(
                crypto.createHash('sha1').update(str, 'binary').digest('hex'));
            t.end();
        }
    });
});


test('copy a file into a container', function (tt) {
    var fnbase = '/var/tmp';
    var fn = 'random.test2';
    var ffn = fnbase + '/' + fn;

    var origSha1;

    tt.test('set up test file', function (t) {
        var cmd = sprintf(
            'dd if=/dev/urandom of=%s '
            + 'count=1024 bs=1024 >/dev/null && '
            + '/native/usr/bin/sum -x sha1 %s | awk "{ print $1 }"',
            ffn, ffn);
        console.log(cmd);
        cli.exec(cmd, function (err, stdout, stderr) {
            t.ifErr(err);
            origSha1 = stdout.toString();
            console.log('sha1 before' + origSha1);
            t.end();
        });
    });

    tt.test('copy file in', function (t) {
        var args = sprintf('cp %s %s:%s', ffn, nginxName, ffn);
        var execOpts = { maxBuffer: 1024*1024*2, encoding: 'binary' };
        cli.docker(args, { execOpts: execOpts }, onDocker);
        function onDocker(err, stdout, stderr) {
            t.ifErr(err);
            t.end();
        }
    });

    tt.test('check the file contents', function (t) {
        var args = sprintf('exec %s /native/usr/bin/sum -x sha1 %s',
            nginxName, ffn);
        cli.docker(args, onDocker);
        function onDocker(err, stdout, stderr) {
            t.ifErr(err);
            console.log('sha1 after' + stdout.toString());
            t.equal(stdout.toString(), origSha1);
            t.end();
        }
    });
});
