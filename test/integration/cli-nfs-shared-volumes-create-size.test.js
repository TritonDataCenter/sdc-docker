/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var helpers = require('./helpers');
var log = require('../lib/log');
var mod_testVolumes = require('../lib/volumes');
var volumesCli = require('../lib/volumes-cli');

var createTestVolume = mod_testVolumes.createTestVolume;
var test = mod_testVolumes.createTestFunc({
    checkTritonSupportsNfsVols: true,
    checkDockerClientSupportsNfsVols: true
});

var ALICE_USER;
var MIBS_IN_GIB = 1024;
var NFS_SHARED_VOLUMES_DRIVER_NAME =
    mod_testVolumes.getNfsSharedVolumesDriverName();
var NFS_SHARED_VOLUME_NAMES_PREFIX =
    mod_testVolumes.getNfsSharedVolumesNamePrefix();
var VOLAPI_CLIENT;

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, function onCliInit(err, env) {
            t.ifErr(err, 'Docker environment initialization should not err');
            if (env) {
                ALICE_USER = env.user;
            }
        });
    });

    // Ensure the busybox image is around.
    tt.test('pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });

    tt.test('volapi client init', function (t) {
        helpers.createVolapiClient(function (err, client) {
            t.ifErr(err, 'volapi client');
            VOLAPI_CLIENT = client;
            t.end();
        });
    });
});

test('Volume creation with invalid size', function (tt) {
    tt.test('creating volume with invalid sizes should fail', function (t) {
        var INVALID_SIZES = [
            'invalid-size',
            '$%#%',
            '',
            '10GB',
            '10MB',
            '100gb',
            '100mb'
        ];

        vasync.forEachParallel({
            func: createVolumeWithInvalidSize,
            inputs: INVALID_SIZES
        }, function invalidSizesTested(err, results) {
            t.end();
        });

        function createVolumeWithInvalidSize(invalidSize, callback) {
            assert.string(invalidSize, 'invalidSize');
            assert.func(callback, 'callback');

            var expectedErrMsg = '(Validation) Volume size: "' + invalidSize
                + '" is not a valid volume size';

            volumesCli.createTestVolume(ALICE_USER, {
                size: invalidSize
            }, function volumeCreated(err, stdout, stderr) {
                t.ok(err, 'volume creation should result in an error');
                t.ok(stderr.indexOf(expectedErrMsg) !== -1,
                    'Error message should include: ' + expectedErrMsg);

                callback();
            });
        }
    });
});

test('Volume creation with unavailable size', function (tt) {
    tt.test('creating volume with unavailable size should fail', function (t) {
        var largestVolSize;

        vasync.pipeline({arg: {}, funcs: [
            function getAvailableSizes(ctx, next) {
                VOLAPI_CLIENT.listVolumeSizes(
                    function onListVolSizes(listVolSizesErr, sizes) {
                        t.ifErr(listVolSizesErr,
                            'listing volume sizes should not error');
                        if (listVolSizesErr) {
                            next(listVolSizesErr);
                            return;
                        }

                        t.ok(sizes,
                            'listing volume sizes should return a non-empty '
                                + 'response');
                        if (sizes) {
                            t.ok(sizes.length > 0,
                                'listing volume sizes should return a '
                                    + 'non-empty list of sizes');
                        }

                        largestVolSize = sizes[sizes.length - 1].size;

                        next();
                    });
            },
            function createVolWithUnavailableSize(ctx, next) {
                var unavailableSize = (largestVolSize / MIBS_IN_GIB + 1) + 'G';

                volumesCli.createTestVolume(ALICE_USER, {
                    size: unavailableSize
                }, function volumeCreated(err, stdout, stderr) {
                    var expectedErrMsg = 'Volume size not available';
                    t.ok(err, 'volume creation should result in an error');
                    t.ok(stderr.indexOf(expectedErrMsg) !== -1,
                        'Error message should include: ' + expectedErrMsg
                            + ' and was: ' + stderr);

                    next();
                });
            }
        ]}, function onTestDone(err) {
            t.end();
        });
    });
});
