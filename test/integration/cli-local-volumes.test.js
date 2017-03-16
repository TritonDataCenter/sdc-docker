/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Integration tests for creating local volumes with `docker run -v
 * /local-volume-dir ...` and mounting them with `--volumes-from`.
 */

var assert = require('assert-plus');
var test = require('tape');

var cli = require('../lib/cli');
var common = require('../lib/common');
var dockerTestsHelper = require('./helpers');

var ALICE;
var STATE = {
    log: require('../lib/log')
};

test('setup', function (tt) {
    tt.test('docker env', function (t) {
        dockerTestsHelper.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('DockerEnv: alice init', cli.init);

    tt.test('pull nginx image', function (t) {
        dockerTestsHelper.ensureImage({
            name: 'nginx:latest',
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling image');
            t.end();
        });
    });
});

test('docker local volumes', function (tt) {
    var containerWithLocalVolName =
        common.makeContainerName('local-volume-test-container-with-local-vol');
    var mountingContainerName =
        common.makeContainerName('local-volume-test-mounting-container');

    tt.test('creating container with local volume should succeed',
        function (t) {
            cli.run(t, {
                args: '--name ' + containerWithLocalVolName + ' -v /data '
                    + 'nginx:latest /bin/sh -c "touch /data/foo.txt && ls '
                    + '/data"'
            }, function onContainerRun(err, output) {
                t.ifErr(err,
                    'creating container with local volume should not error');
                t.equal(output.stdout, 'foo.txt\n',
                    'output should equal newly created file');
                t.end();
            });
    });

    tt.test('mounting local volume from another container should succeed',
        function (t) {
        cli.run(t, {
            args: '--name ' + mountingContainerName + ' --volumes-from='
                + containerWithLocalVolName + ' nginx:latest ls /data'
        }, function onContainerRun(err, output) {
            t.ifErr(err,
                'creating container with volume mounted with --volumes-from '
                    + 'should not error');
            t.equal(output.stdout, 'foo.txt\n', 'Output should equal newly '
                + 'created file');
            t.end();
        });
    });

    tt.test('deleting container with volume mounted via --volumes-from should '
        + 'work', function (t) {
        cli.rm(t, {args: mountingContainerName},
            function onContainerDeleted(err, stdout, stderr) {
                t.ifErr(err, 'deleting container with volume mounted via '
                    + '--volumes-from should succeed');
                t.end();
            });
        });

    tt.test('deleting container with local volume should work',
        function (t) {
            cli.rm(t, {args: containerWithLocalVolName},
                function onContainerDeleted(err, stdout, stderr) {
                    t.ifErr(err, 'deleting container with local volume should '
                        + 'succeed');
                    t.end();
                });
        });
});