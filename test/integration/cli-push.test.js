/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Integration tests for `docker push` using the docker cli.
 */

var path = require('path');

var tarstream = require('tar-stream');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var h = require('./helpers');

var format = require('util').format;

// -- Globals

var STATE = {
    log: require('../lib/log')
};

var ALICE;
var CONTAINER_PREFIX = 'sdcdockertest_push_';
var DOCKER_ALICE; // Regular JSON restify client.
var DOCKER_ALICE_HTTP; // For sending non-JSON payload
var IMAGE_NAME = 'busybox';
var TP = 'cli: push: ';  // Test prefix.

// -- Helpers

function createTarStream(fileAndContents) {
    var pack = tarstream.pack();

    Object.keys(fileAndContents).forEach(function (name) {
        pack.entry({ name: name }, fileAndContents[name]);
    });

    pack.finalize();

    return pack;
}

// -- Tests

test(TP + 'setup', function (tt) {

    tt.test('DockerEnv: alice init', cli.init);

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err, 'Initializing docker env');

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient({user: ALICE},
            function (err, client) {
                t.ifErr(err, 'docker client init for alice');
                DOCKER_ALICE = client;
                t.end();
            }
        );
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

    // Ensure the busybox image is around.
    tt.test(TP + 'pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });
});


test(TP + 'unathorized tag and push', function (tt) {
    var tagName = 'joyentunsupported/privatetest';

    tt.test(TP + 'tag busybox as ' + tagName, function (t) {
        cli.docker('tag busybox ' + tagName, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err, 'Tagging busybox as ' + tagName);
            t.end();
        }
    });

    tt.test(TP + 'push ' + tagName, function (t) {
        cli.docker('push ' + tagName, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(!err, 'Pushing ' + tagName);
            // We expect an error in stdout.
            var expectedErr = 'authentication required';
            var authFailure = stderr.indexOf(expectedErr) >= 0;
            if (!authFailure) {
                t.fail('Expected authorization failure, got ' + stderr);
            }
            t.end();
        }
    });

    // Cleanup the tagged image.

    tt.test('delete tagged image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(tagName),
            function (err) {
                t.ifErr(err, 'deleting ' + tagName);
                t.end();
            }
        );
    });
});

test(TP + 'tag and push', function (tt) {
    var repo = 'joyentunsupported/test_push';
    var tagName = repo + ':tagpush';
    var tagName2 = repo + ':tagpush2';

    tt.test(TP + 'tag busybox as ' + tagName, function (t) {
        cli.docker('tag busybox ' + tagName, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err, 'Tagging busybox as ' + tagName);
            t.end();
        }
    });

    tt.test(TP + 'push ' + tagName, function (t) {
        if (!process.env.DOCKER_TEST_CONFIG_FILE) {
            t.skip(TP + 'push ' + tagName);
            t.end();
            return;
        }
        cli.docker('push ' + tagName, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err, 'Pushing ' + tagName);
            // We expect a tag and digest in stdout.
            var msg = 'tagpush: digest: sha256:';
            var pushOkay = stdout.indexOf(msg) >= 0;
            if (!pushOkay) {
                t.fail('Expected successful push, got ' + stdout);
            }
            // Make sure we don't see tagpush2 being pushed.
            msg = 'tagpush2: digest: sha256:';
            if (stdout.indexOf(msg) !== -1) {
                t.fail('Should not see tagpush2 in stdout: ' + stdout);
            }
            t.end();
        }
    });

    tt.test(TP + 'tag busybox as ' + tagName2, function (t) {
        cli.docker('tag busybox ' + tagName2, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err, 'Tagging busybox as ' + tagName2);
            t.end();
        }
    });

    // Test pushing the repo name - this should push all tags for the given
    // repo.
    tt.test(TP + 'push ' + repo, function (t) {
        if (!process.env.DOCKER_TEST_CONFIG_FILE) {
            t.skip(TP + 'push ' + repo);
            t.end();
            return;
        }
        cli.docker('push ' + repo, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err, 'Pushing ' + repo);
            // We expect a tag and digest (for each tag) in stdout.
            ['tagpush', 'tagpush2'].forEach(function (tag) {
                var msg = tag + ': digest: sha256:';
                var pushOkay = stdout.indexOf(msg) >= 0;
                if (!pushOkay) {
                    t.fail('Expected successful push, got ' + stdout);
                }
            });
            t.end();
        }
    });

    // Cleanup tagged images.

    tt.test('delete tagged image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(tagName),
            function (err) {
                t.ifErr(err, 'deleting ' + tagName);
                DOCKER_ALICE.del('/images/' + encodeURIComponent(tagName2),
                    function (err2) {
                        t.ifErr(err2, 'deleting ' + tagName2);
                        t.end();
                    }
                );
            }
        );
    });
});


test(TP + 'build and push', function (tt) {
    tt.test('docker build image', function (t) {
        var dockerImageId = null;
        var tarStream;
        var repo = 'joyentunsupported/test_push';
        var tagName = repo + ':buildpush';

        vasync.waterfall([

            function createTar(next) {
                var fileAndContents = {
                    'Dockerfile': 'FROM scratch\n'
                                + 'LABEL sdcdockertest_push=yes\n'
                                + 'ADD dummy.txt /\n',
                    'dummy.txt': 'Some contents\n'
                };
                tarStream = createTarStream(fileAndContents);
                next();
            },

            function buildContainer(next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    params: {
                        rm: 'true',  // Remove container after it's built.
                        t: tagName
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

                if (!hasSuccess) {
                    next(new Error('Build failed: ' + output));
                    return;
                }

                var reg = new RegExp('Successfully built (\\w+)');
                dockerImageId = output.match(reg)[1];
                next();
            },

            function pushImage(next) {
                if (!process.env.DOCKER_TEST_CONFIG_FILE) {
                    t.skip(TP + 'push ' + tagName);
                    next();
                    return;
                }
                cli.docker('push ' + tagName, {}, onComplete);
                function onComplete(err, stdout) {
                    t.ifErr(err, 'Pushing ' + tagName);
                    // We expect an error in stdout.
                    var msg = 'buildpush: digest: sha256:';
                    var pushOkay = stdout.indexOf(msg) >= 0;
                    if (!pushOkay) {
                        next(new Error(
                            'Expected successful push, got ' + stdout));
                        return;
                    }
                    next();
                }
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
});
