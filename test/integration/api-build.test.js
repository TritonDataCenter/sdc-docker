/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for `docker build` using the Remote API directly.
 *
 * Note: There are only limited tests here, as we rely on the docker/docker
 *       integration-cli tests to perform most of the sdc-docker build testing,
 *       which are run separately (e.g. in nightly).
 */

var format = require('util').format;
var path = require('path');

var tar = require('tar-stream');
var test = require('tape');
var vasync = require('vasync');

var h = require('./helpers');

var STATE = {
    log: require('../lib/log')
};

var ALICE;
var DOCKER_ALICE; // Regular JSON restify client.
var DOCKER_ALICE_HTTP; // For sending non-JSON payload


function createTarStream(fileAndContents) {
    var pack = tar.pack();

    Object.keys(fileAndContents).forEach(function (name) {
        pack.entry({ name: name }, fileAndContents[name]);
    });

    pack.finalize();

    return pack;
}


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        vasync.parallel({ funcs: [
            function createAliceHttp(done) {
                h.createDockerRemoteClient({user: ALICE},
                    function (err, client) {
                        t.ifErr(err, 'docker client init for alice');
                        done(err, client);
                    });
            }
        ]}, function allDone(err, results) {
            t.ifError(err, 'docker client init should be successful');
            DOCKER_ALICE = results.operations[0].result;
            t.end();
        });
    });

    tt.test('docker client http init', function (t) {
        vasync.parallel({ funcs: [
            function createAliceHttp(done) {
                h.createDockerRemoteClient({user: ALICE, clientType: 'http'},
                    function (err, client) {
                        t.ifErr(err, 'docker client init for alice/http');
                        done(err, client);
                    });
            }
        ]}, function allDone(err, results) {
            t.ifError(err, 'docker client http init should be successful');
            DOCKER_ALICE_HTTP = results.operations[0].result;
            t.end();
        });
    });
});

test('api: build', function (tt) {
    tt.test('docker build with busybox build context', function (t) {
        var dockerImageId = null;
        var tarStream;

        vasync.waterfall([

            function createTar(next) {
                var fileAndContents = {
                    'Dockerfile': 'FROM busybox\n'
                                + 'LABEL sdcdockertest=true\n'
                };
                tarStream = createTarStream(fileAndContents);
                next();
            },

            function buildContainer(next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    params: {
                        'labels': '{"gone":"fishing"}',
                        'rm': 'true'  // Remove container after it's built.
                    },
                    test: t,
                    tarball: tarStream
                }, onbuild);

                function onbuild(err, result) {
                    t.ifError(err, 'build finished');
                    next(err, result);
                }
            },

            function checkResults(result, next) {
                if (!result || !result.body) {
                    next(new Error('build generated no output!?'));
                    return;
                }

                var output = result.body;
                var hasLabel = output.indexOf('LABEL sdcdockertest=true') >= 0;
                t.ok(hasLabel, format(
                    'output contains LABEL sdcdockertest=true: output=%j',
                    output));

                var hasSuccess = output.indexOf('Successfully built') >= 0;
                t.ok(hasSuccess, 'output contains Successfully built');

                if (hasSuccess) {
                    var reg = new RegExp('Successfully built (\\w+)');
                    dockerImageId = output.match(reg)[1];
                }

                next();
            },

            function inspectImage(next) {
                DOCKER_ALICE.get('/images/' + dockerImageId + '/json',
                        function (err, req, res, img) {
                    t.ok(img, 'inspect image');
                    t.deepEqual(img.Config.Labels,
                        {'gone': 'fishing', 'sdcdockertest': 'true'});
                    next();
                });
            },

            function removeBuiltImage(next) {
                t.ok(dockerImageId, 'Got the docker image id');
                DOCKER_ALICE.del('/images/' + dockerImageId, next);
            }

        ], function allDone(err) {
            t.ifErr(err);

            t.end();
        });

    });
});


/**
 * DOCKER-662: Ensure no conflicts with same images in different repositories.
 */
test('api: build image conflicts', function (tt) {
    var imageName1 =
        'docker.io/joyentunsupported/triton_alpine_inherit_test:latest';
    var imageName2 = 'quay.io/joyent/triton_alpine_inherit_test:latest';

    // Pull the docker.io alpine image.
    tt.test('pull docker.io alpine test image', function (t) {
        h.ensureImage({
            name: imageName1,
            user: ALICE
        }, function (err) {
            t.error(err, 'getting docker.io alpine test image');
            t.end();
        });
    });

    // Pull something that uses the same alpine image in a different repository.
    tt.test('pull quay.io alpine test image', function (t) {
        h.ensureImage({
            name: imageName2,
            user: ALICE
        }, function (err) {
            t.error(err, 'getting quay.io alpine test image');
            t.end();
        });
    });

    // TODO: Assert two alpine images share the same history.

    tt.test('docker build own alpine image', function (t) {
        var dockerImageId = null;
        var tarStream;

        vasync.waterfall([

            function createTar(next) {
                var fileAndContents = {
                    'Dockerfile': 'FROM ' + imageName1 + '\n'
                                + 'LABEL sdcdockertest_conflict=yes\n'
                };
                tarStream = createTarStream(fileAndContents);
                next();
            },

            function buildContainer(next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    params: {
                        'rm': 'true'  // Remove container after it's built.
                    },
                    test: t,
                    tarball: tarStream
                }, onbuild);

                function onbuild(err, result) {
                    t.ifError(err, 'built successfully');
                    next(err, result);
                }
            },

            function checkResults(result, next) {
                if (!result || !result.body) {
                    next(new Error('build generated no output!?'));
                    return;
                }

                var output = result.body;
                var hasSuccess = output.indexOf('Successfully built') >= 0;
                t.ok(hasSuccess, 'output should contain: Successfully built');

                if (hasSuccess) {
                    var reg = new RegExp('Successfully built (\\w+)');
                    dockerImageId = output.match(reg)[1];
                } else {
                    t.fail('Output: ' + output);
                }

                next();
            },

            function removeBuiltImage(next) {
                t.ok(dockerImageId, 'got the built docker image id');
                DOCKER_ALICE.del('/images/' + dockerImageId, next);
            }

        ], function allDone(err) {
            t.ifErr(err);
            t.end();
        });

    });

    // Cleanup images we pulled down.

    tt.test('delete docker.io alpine test image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(imageName1),
            function (err) {
                t.ifErr(err);
                t.end();
            }
        );
    });

    tt.test('delete quay.io alpine test image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(imageName2),
            function (err) {
                t.ifErr(err);
                t.end();
            }
        );
    });

});


/**
 * DOCKER-748: Cannot build an image that references multiple registries.
 */
test('api: build across multiple registries', function (tt) {
    var imageName = 'quay.io/joyent/triton_alpine_inherit_test:latest';
    var newTagName = 'quay.io/joyent/newtag:latest';

    // Pull the docker.io alpine image.
    tt.test('pull quay.io alpine test image', function (t) {
        h.ensureImage({
            name: imageName,
            user: ALICE
        }, function (err) {
            t.error(err, 'getting docker.io alpine test image');
            t.end();
        });
    });

    tt.test('docker build from alpine image (cross registry)', function (t) {
        var tarStream;

        vasync.waterfall([

            function createTar(next) {
                var fileAndContents = {
                    'Dockerfile': 'FROM ' + imageName + '\n'
                                + 'LABEL something=true\n'
                };
                tarStream = createTarStream(fileAndContents);
                next();
            },

            function buildContainer(next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    params: {
                        'rm': 'true'  // Remove container after it's built.
                    },
                    test: t,
                    tarball: tarStream
                }, onbuild);

                function onbuild(err, result) {
                    t.ifErr(err, 'build should not error on post');
                    var msg = result.body;
                    if (msg.indexOf('different registries') === -1) {
                        t.fail('expected a "different registries" error '
                            + 'message, got: "' + msg + '"');
                    }
                    next();
                }
            }

        ], function allDone(err) {
            t.ifErr(err);
            t.end();
        });

    });

    // Test that can still build using the same index.
    tt.test('docker build from alpine image (same registry)', function (t) {
        var tarStream;

        vasync.waterfall([

            function createTar(next) {
                var fileAndContents = {
                    'Dockerfile': 'FROM ' + imageName + '\n'
                                + 'LABEL something=true\n'
                };
                tarStream = createTarStream(fileAndContents);
                next();
            },

            function buildContainer(next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    params: {
                        't': newTagName,
                        'rm': 'true'  // Remove container after it's built.
                    },
                    test: t,
                    tarball: tarStream
                }, onbuild);

                function onbuild(err, result) {
                    t.ifErr(err, 'build should not error on post');
                    var msg = result.body;

                    var hasSuccess = msg.indexOf('Successfully built') >= 0;
                    t.ok(hasSuccess, 'output contains Successfully built');

                    // Delete the built image.
                    if (hasSuccess) {
                        DOCKER_ALICE.del('/images/' + escape(newTagName), next);
                    } else {
                        next();
                    }
                }
            }

        ], function allDone(err) {
            t.ifErr(err);
            t.end();
        });

    });

    // Cleanup images we pulled down.

    tt.test('delete quay.io alpine test image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(imageName),
            function (err) {
                t.ifErr(err);
                t.end();
            }
        );
    });

});


test('build with packagelabel', function (tt) {

    var imageLabels = { 'fireworks': 'awesome' };

    vasync.pipeline({ arg: {}, funcs: [

        function getSmallestPackage(ctx, next) {
            h.getSortedPackages(function (err, pkgs) {
                if (err) {
                    next(err);
                    return;
                }
                tt.ok(pkgs.length >= 1, 'Must be at least one pkg');
                var smallestPkg = pkgs[0];
                tt.ok(smallestPkg.name, 'smallestPkg.name');
                ctx.allLabels = {
                    'com.joyent.package': smallestPkg.name,
                    'fireworks': 'awesome'
                };
                next();
            });
        },

        function createTar(ctx, next) {
            var fileAndContents = {
                'Dockerfile': 'FROM busybox\n'
                            + 'LABEL fireworks=awesome\n'
                            + 'RUN true\n'
            };
            ctx.tarStream = createTarStream(fileAndContents);
            next();
        },

        function buildWithPackageLabel(ctx, next) {
            h.buildDockerContainer({
                dockerClient: DOCKER_ALICE_HTTP,
                params: {
                    'labels': JSON.stringify(ctx.allLabels),
                    'rm': 'false'  // Don't remove container after it's built.
                },
                test: tt,
                tarball: ctx.tarStream
            }, onbuild);

            function onbuild(err, result) {
                tt.ifError(err, 'build finished');
                ctx.result = result;
                next(err, result);
            }
        },

        function checkResults(ctx, next) {
            if (!ctx.result || !ctx.result.body) {
                next(new Error('build generated no output!?'));
                return;
            }

            var reg;
            var output = ctx.result.body;
            var hasLabel = output.indexOf('LABEL fireworks=awesome') >= 0;
            tt.ok(hasLabel, format(
                'output contains "LABEL fireworks=awesome": output=%j',
                output));

            var hasRunningIn = output.indexOf('Running in ') >= 0;
            tt.ok(hasRunningIn, 'output contains "Running in"');
            if (hasRunningIn) {
                reg = new RegExp('Running in (\\w+)');
                ctx.containerId = output.match(reg)[1];
                tt.ok(ctx.containerId, 'Found containerId');
            }

            var hasSuccess = output.indexOf('Successfully built') >= 0;
            tt.ok(hasSuccess, 'output contains Successfully built');
            if (hasSuccess) {
                reg = new RegExp('Successfully built (\\w+)');
                ctx.dockerImageId = output.match(reg)[1];
                tt.ok(ctx.dockerImageId, 'Found dockerImageId');
            }

            next();
        },

        function inspectBuildContainer(ctx, next) {
            DOCKER_ALICE.get('/containers/' + ctx.containerId + '/json',
                    function (err, req, res, container) {
                tt.ok(container, 'inspect container');
                tt.deepEqual(container.Config.Labels, ctx.allLabels);
                next();
            });
        },

        // Make sure that the image does not include 'com.joyent.package' label.
        function inspectBuiltImage(ctx, next) {
            DOCKER_ALICE.get('/images/' + ctx.dockerImageId + '/json',
                    function (err, req, res, img) {
                tt.ok(img, 'inspect image');
                tt.deepEqual(img.Config.Labels, imageLabels);
                next();
            });
        },

        function removeBuiltImage(ctx, next) {
            tt.ok(ctx.dockerImageId, 'Got the docker image id');
            DOCKER_ALICE.del('/images/' + ctx.dockerImageId, next);
        },

        function removeBuildContainer(ctx, next) {
            DOCKER_ALICE.del('/containers/' + ctx.containerId, next);
        }

    ]}, function _inspectedContainers(err) {
        tt.ifError(err, 'build with packagelabel');
        tt.end();
    });
});
