/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Integration tests for docker rmi.
 */

var imgmanifest = require('imgmanifest');
var test = require('tape');
var util = require('util');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var h = require('./helpers');

// --- Globals

var ALICE;
var CONTAINER_PREFIX = 'sdcdockertest_rmi_';
var TAG_PREFIX = 'sdcdockertest_rmi_';
var IMAGE_NAME = 'joyentunsupported/test-nginx:1.0.0';

// --- Tests


test('setup', function (tt) {
    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, function (err, result) {
            if (!err) {
                ALICE = result.user;
            }
            // Note: cli.init() calls t.end()
        });
    });

    // Pull down the docker image.
    tt.test('pull ' + IMAGE_NAME, function (t) {
        pullTestImage(function (err) {
            t.ifErr(err, 'check pull ' + IMAGE_NAME);
            t.end();
        });
    });

    // Remove old containers.
    cli.rmContainersWithNamePrefix(tt, CONTAINER_PREFIX);
});


test('docker rmi', function (tt) {

    var altTagName = TAG_PREFIX + 'altbox';
    var imageInspect;

    // Get image details.
    tt.test('inspect image', function (t) {
        cli.inspect(t, {
            id: IMAGE_NAME
        }, function (err, img) {
            t.ifErr(err, 'Inspect image');
            imageInspect = img;
            t.end();
        });
    });

    // Tag with an alternative name.
    tt.test('tag as altbox', function (t) {
        cli.docker('tag ' + IMAGE_NAME + ' ' + altTagName, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err);
            t.end();
        }
    });

    // Test two tags to the same image, should get a docker rmi warning when
    // trying to delete using the image id.
    tt.test('rmi using image id', function (t) {
        var opts = {
            args: imageInspect.Id,
            expectedErr: new RegExp('conflict: unable to delete [0-9a-f]{12} '
                + '\\(must be forced\\) - image is referenced in one or more '
                + 'repositories')
        };

        cli.rmi(t, opts); // Err checking and t.end() is done in cli.rmi().
    });

    // Remove altbox image using it's repo/tag name.
    tt.test('rmi altbox image', function (t) {
        var opts = {args: altTagName};
        cli.rmi(t, opts); // Err checking and t.end() is done in cli.rmi().
    });

    // Run container based on our test image.
    tt.test('docker rmi for in-use image', function (t) {
        var imageShortId = imgmanifest.shortDockerId(
            imgmanifest.dockerIdFromDigest(imageInspect.Id));
        var containerId;

        function ensureInspect404(_, next) {
            cli.inspect(t, {
                id: imageInspect.Id,
                expectedErr: new RegExp('Error: No such image')
            }, function () {
                // Ignore error - as it's handled by cli.inspect
                next();
            });
        }

        function repullTestImage(_, next) {
            pullTestImage(function (err) {
                t.ifErr(err, 'check pull ' + IMAGE_NAME);
                next(err);
            });
        }

        vasync.pipeline({ funcs: [
            function runContainer(_, next) {
                var opts = {
                    args: util.format('-d --name %s %s sh -c "sleep 86400"',
                        common.makeResourceName(CONTAINER_PREFIX), IMAGE_NAME)
                };

                cli.run(t, opts, function (err, id) {
                    t.ifErr(err, 'check for docker run error');
                    containerId = id;
                    next(err);
                });
            },

            // ---- Failure rmi cases ---- //

            // Cannot remove image (by id) if a running container is using it.
            function rmiById(_, next) {
                var opts = {
                    args: imageInspect.Id,
                    expectedErr: new RegExp('conflict: unable to delete '
                        + '[0-9a-f]{12} \\(cannot be forced\\) - image is '
                        + 'being used by running container [0-9a-f]{12}')
                };

                cli.rmi(t, opts, function () {
                    // Ignore err - as it's already checked in cli.rmi call.
                    next();
                });
            },

            // Cannot remove image (by name) if a running container is using it.
            function rmiByName(_, next) {
                var opts = {
                    args: IMAGE_NAME,
                    expectedErr: new RegExp('conflict: unable to remove '
                        + 'repository reference "' + IMAGE_NAME + '" '
                        + '\\(must force\\) - container [0-9a-f]{12} is using '
                        + 'its referenced image ' + imageShortId)
                };

                cli.rmi(t, opts, function () {
                    // Ignore err - as it's already checked in cli.rmi call.
                    next();
                });
            },

            // Cannot force remove image (by id) if a running container is
            // using it.
            function forcedRmiById(_, next) {
                var opts = {
                    args: '--force ' + imageInspect.Id,
                    expectedErr: new RegExp('conflict: unable to delete '
                        + '[0-9a-f]{12} \\(cannot be forced\\) - image is '
                        + 'being used by running container [0-9a-f]{12}')
                };

                cli.rmi(t, opts, function (err) {
                    // Ignore err - as it's already checked in cli.rmi call.
                    next();
                });
            },

            function stopContainer(_, next) {
                cli.stop(t, {args: containerId}, next);
            },

            // Cannot remove image (by id) if a stopped container is using it.
            function rmiByIdStoppedContainer(_, next) {
                var opts = {
                    args: imageInspect.Id,
                    expectedErr: new RegExp('conflict: unable to delete '
                        + '[0-9a-f]{12} \\(must be forced\\) - image is '
                        + 'being used by stopped container [0-9a-f]{12}')
                };

                cli.rmi(t, opts, function () {
                    // Ignore err - as it's already checked in cli.rmi call.
                    next();
                });
            },

            // Cannot remove image (by name) if a stopped container is using it.
            function rmiByNameStoppedContainer(_, next) {
                var opts = {
                    args: IMAGE_NAME,
                    expectedErr: new RegExp('conflict: unable to remove '
                        + 'repository reference "' + IMAGE_NAME + '" '
                        + '\\(must force\\) - container [0-9a-f]{12} is using '
                        + 'its referenced image ' + imageShortId)
                };

                cli.rmi(t, opts, function () {
                    // Ignore err - as it's already checked in cli.rmi call.
                    next();
                });
            },

            // ---- Successful rmi cases ---- //

            // Can force remove image (by id) if stopped container is using it.
            function forcedRmiByIdStoppedContainer(_, next) {
                cli.rmi(t, {args: '--force ' + imageInspect.Id}, next);
            },

            ensureInspect404,
            repullTestImage,

            // Can force remove image (by name) if stopped container uses it.
            function forcedRmiByNameStoppedContainer(_, next) {
                cli.rmi(t, {args: '--force ' + IMAGE_NAME}, next);
            },

            ensureInspect404,
            repullTestImage,

            function restartContainer(_, next) {
                cli.start(t, {args: containerId}, next);
            },

            // Can force remove image (by name) if a running container is using
            // it, but it only untags the image!
            function forcedRmiByName(_, next) {
                cli.rmi(t, {args: '--force ' + IMAGE_NAME}, next);
            },

            function ensureInspectByIdSuccessful(_, next) {
                cli.inspect(t, {
                    id: imageInspect.Id
                }, function (err, img) {
                    t.ifErr(err, 'Inspect image');
                    t.equal(img.Id, imageInspect.Id,
                        'inspected image should have the correct id');
                    next(err);
                });
            },

            function ensureInspectByName404(_, next) {
                cli.inspect(t, {
                    id: IMAGE_NAME,
                    expectedErr: new RegExp('Error: No such image')
                }, function () {
                    // Ignore error - as it's handled by cli.inspect
                    next();
                });
            }

        ]}, function (err) {
            t.ifErr(err);
            if (containerId) {
                // Note: cli.rm will call t.end() when it's done.
                cli.rm(t, {args: '-f ' + containerId});
                return;
            }
            t.end();
        });
    });
});


// Helpers

function pullTestImage(callback) {
    h.ensureImage({
        name: IMAGE_NAME,
        user: ALICE
    }, callback);
}
