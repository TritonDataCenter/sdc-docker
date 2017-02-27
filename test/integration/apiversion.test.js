/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for docker client version handling.
 */

var constants = require('../../lib/constants');
var h = require('./helpers');
var test = require('tape');



// --- Globals


var DOCKER_ALICE;
var STATE = {
    log: require('../lib/log')
};


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);
            h.createDockerRemoteClient({user: accounts.alice},
                function (err2, client) {
                    t.ifErr(err2, 'docker client init');
                    DOCKER_ALICE = client;
                    t.end();
                }
            );
        });
    });

    //tt.test('DockerEnv: alice init', cli.init);
});

test('apiversion', function (tt) {

    function testVersionHandling(apiversion, opts) {
        var verPrefix = apiversion ? ('/' + apiversion) : '';
        var infoPath = verPrefix + '/info';
        var containersPath = verPrefix + '/containers/json';
        var imagesPath = verPrefix + '/images/json';
        var versionPath = verPrefix + '/version';

        tt.test('apiversion ' + infoPath, function (t) {
            // docker info
            DOCKER_ALICE.get(infoPath,
                    function (err, req, res, info) {
                if (opts && opts.shouldFail) {
                    t.ok(err, 'expected request to fail');
                    t.end();
                    return;
                }
                t.ifError(err, 'apiversion ' + infoPath);
                t.ok(info, 'info object');
                t.end();
            });
        });

        tt.test('apiversion ' + containersPath, function (t) {
            // docker ps
            DOCKER_ALICE.get(containersPath,
                    function (err, req, res, containers) {
                if (opts && opts.shouldFail) {
                    t.ok(err, 'expected request to fail');
                    t.end();
                    return;
                }
                t.ifError(err, 'apiversion ' + containersPath);
                t.ok(containers, 'containers array');
                t.end();
            });
        });

        tt.test('apiversion ' + imagesPath, function (t) {
            // docker images
            DOCKER_ALICE.get(imagesPath,
                    function (err, req, res, images) {
                if (opts && opts.shouldFail) {
                    t.ok(err, 'expected request to fail');
                    t.end();
                    return;
                }
                t.ifError(err, 'apiversion ' + imagesPath);
                t.ok(images, 'images array');
                t.end();
            });
        });

        tt.test('apiversion ' + versionPath, function (t) {
            // docker version
            DOCKER_ALICE.get(versionPath,
                    function (err, req, res, verInfo) {
                if (opts && opts.shouldFail) {
                    t.ok(err, 'expected request to fail');
                    t.end();
                    return;
                }
                t.ifError(err, 'apiversion ' + versionPath);
                t.ok(verInfo, 'version response');
                t.end();
            });
        });
    }

    testVersionHandling();        // no version
    testVersionHandling('v1.14', { shouldFail: true }); // unsupported version
    testVersionHandling('v1.19', { shouldFail: true }); // unsupported version
    testVersionHandling('v' + constants.MIN_API_VERSION); // min ver
    testVersionHandling('v' + constants.API_VERSION); // current ver
    testVersionHandling('v9.99'); // future version
    testVersionHandling('1.14', { shouldFail: true });   // invalid version
    testVersionHandling('golden', { shouldFail: true }); // invalid version
});
