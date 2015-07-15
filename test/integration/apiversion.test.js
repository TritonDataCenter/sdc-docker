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

var common = require('../../lib/common');
var cli = require('../lib/cli');
var h = require('./helpers');
var test = require('tape');
var vasync = require('vasync');



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
        var pingPath = verPrefix + '/_ping';

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

        tt.test('apiversion ' + pingPath, function (t) {
            // docker ping
            DOCKER_ALICE.get(pingPath,
                    function (err, req, res, ping) {
                if (opts && opts.shouldFail) {
                    t.ok(err, 'expected request to fail');
                    t.end();
                    return;
                }
                t.ifError(err, 'apiversion ' + pingPath);
                t.ok(ping, 'ping response');
                t.end();
            });
        });
    }

    testVersionHandling();        // no version
    testVersionHandling('v1.15'); // old version
    testVersionHandling('v' + common.SERVER_VERSION); // current server version
    testVersionHandling('v9.99'); // future version
    testVersionHandling('1.15', { shouldFail: true });   // invalid version
    testVersionHandling('golden', { shouldFail: true }); // invalid version
});
