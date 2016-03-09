/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for docker start and stop using the Remote API directly.
 */

var test = require('tape');
var util = require('util');
var vasync = require('vasync');

var container = require('../lib/container');
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


test('api: kill', function (tt) {

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
        DOCKER.post('/containers/' + id + '/start', onpost);
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


    tt.test('kill container with invalid symbolic signal', function (t) {
        DOCKER.post('/containers/' + id + '/kill?signal=foo', onpost);
        function onpost(err, res, req, body) {
            var expectedResponseStatusCode = 422;
            var expectedErrorMessage = '(Validation) Invalid parameters: '
                + 'Invalid parameter "signal": "foo" is not a valid signal';

            t.ok(err, 'Response should be an error');
            t.equal(err.statusCode, expectedResponseStatusCode,
                'Response status code should be ' + expectedResponseStatusCode);
            t.equal(err.message.indexOf(expectedErrorMessage), 0,
                'Error message should be: ' + expectedErrorMessage);
            t.end();
        }
    });


    tt.test('confirm container still running', function (t) {
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
            t.ok(matched, 'container is still running');
            if (!matched) {
                t.equal(found[0].Status, 'Status for debugging');
            }

            t.end();
        });
    });


    tt.test('kill container with invalid numeric signal', function (t) {
        DOCKER.post('/containers/' + id + '/kill?signal=5000', onpost);
        function onpost(err, res, req, body) {
            var expectedResponseStatusCode = 422;
            var expectedErrorMessage = '(Validation) Invalid parameters: '
                + 'Invalid parameter "signal": "5000" is not a valid signal';

            t.ok(err, 'Response should be an error');
            t.equal(err.statusCode, expectedResponseStatusCode,
                'Response status code should be ' + expectedResponseStatusCode);
            t.equal(err.message.indexOf(expectedErrorMessage), 0,
                'Error message should be: ' + expectedErrorMessage);
            t.end();
        }
    });


    tt.test('confirm container still running', function (t) {
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
            t.ok(matched, 'container is still running');
            if (!matched) {
                t.equal(found[0].Status, 'Status for debugging');
            }

            t.end();
        });
    });


    tt.test('kill container without specifying a signal', function (t) {
        DOCKER.post('/containers/' + id + '/kill', onpost);
        function onpost(err, res, req, body) {
            t.error(err);
            t.end(err);
        }
    });


    tt.test('confirm container killed', function (t) {
        container.checkContainerStatus(id, /^Exited /, {
            helper: h,
            dockerClient: DOCKER,
            retries: 10
        }, function _onCheckDone(err, success) {
            t.ifErr(err, 'Checking container status should not error');
            t.ok(success, 'Container should be in status exited');

            t.end();
        });
    });

    tt.test('restart container', function (t) {
        DOCKER.post('/containers/' + id + '/restart', onpost);
        function onpost(err, res, req, body) {
            t.error(err);
            t.end(err);
        }
    });


    tt.test('confirm container restarted', function (t) {
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
            t.ok(matched, 'container has started');
            if (!matched) {
                t.equal(found[0].Status, 'Status for debugging');
            }

            t.end();
        });
    });


    tt.test('kill container with valid numeric signal', function (t) {
        DOCKER.post('/containers/' + id + '/kill?signal=9', onpost);
        function onpost(err, res, req, body) {
            t.error(err);
            t.end(err);
        }
    });


    tt.test('confirm container killed', function (t) {
        container.checkContainerStatus(id, /^Exited /, {
            helper: h,
            dockerClient: DOCKER,
            retries: 10
        }, function _onCheckDone(err, success) {
            t.ifErr(err, 'Checking container status should not error');
            t.ok(success, 'Container should be in status exited');

            t.end();
        });
    });

    tt.test('restart container', function (t) {
        DOCKER.post('/containers/' + id + '/restart', onpost);
        function onpost(err, res, req, body) {
            t.error(err);
            t.end(err);
        }
    });


    tt.test('confirm container restarted', function (t) {
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
            t.ok(matched, 'container has started');
            if (!matched) {
                t.equal(found[0].Status, 'Status for debugging');
            }

            t.end();
        });
    });


    tt.test('kill container with valid symbolic signal', function (t) {
        DOCKER.post('/containers/' + id + '/kill?signal=SIGKILL', onpost);
        function onpost(err, res, req, body) {
            t.error(err);
            t.end(err);
        }
    });


    tt.test('confirm container killed', function (t) {
        container.checkContainerStatus(id, /^Exited /, {
            helper: h,
            dockerClient: DOCKER,
            retries: 10
        }, function _onCheckDone(err, success) {
            t.ifErr(err, 'Checking container status should not error');
            t.ok(success, 'Container should be in status exited');

            t.end();
        });
    });

    tt.test('delete container', function (t) {
        DOCKER.del('/containers/' + id, ondel);

        function ondel(err, res, req, body) {
            t.ifErr(err, 'rm container');
            t.end();
        }
    });

});
