/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var fs = require('fs');
var path = require('path');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var composeCli = require('../lib/compose-cli.js');
var helpers = require('./helpers');
var testVolumes = require('../lib/volumes');

var test = testVolumes.createTestFunc({
    checkTritonSupportsNfsVols: true
});

var ALICE_USER;
var COMPOSE_FILE = fs.readFileSync(path.join(__dirname, '..', 'compose',
    'compose-with-nfs-volume', 'docker-compose.yml')).toString();

/*
 * We use a project name as a way to namespace all resources created by this
 * test, so that they do not conflict with any other test or any other resource
 * that may have been created either automatically or manually.
 */
var COMPOSE_PROJECT_NAME = 'compose-nfs-volume-test';
var MOUNTING_CONTAINER_NAMES_PREFIX = 'test-nfs-mounting-container';
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

    tt.test('volapi client init', function (t) {
        helpers.createVolapiClient(function (err, client) {
            t.ifErr(err, 'volapi client');
            VOLAPI_CLIENT = client;
            t.end();
        });
    });
});

test('docker volume created with docker compose', function (tt) {
    /*
     * docker-compose creates resources based on the project name (the -p
     * command line option passed to the docker-compose command), but removes
     * hyphens from the project name only.
     */
    var volumeName = COMPOSE_PROJECT_NAME.replace(/-/g, '')
        + '_compose-with-nfs-volume-test';

    tt.test('docker compose up should succeed', function (t) {
        vasync.pipeline({arg: {}, funcs: [
            function composeUp(ctx, next) {
                composeCli(COMPOSE_FILE, {
                    args: '-p ' + COMPOSE_PROJECT_NAME + ' up -d',
                    user: ALICE_USER
                }, function onComposeUp(composeUpErr, stdout, stderr) {
                    t.ifErr(composeUpErr,
                        'compose up should not error');
                    next(composeUpErr);
                });
            },
            function checkVolumeExists(ctx, next) {
                VOLAPI_CLIENT.listVolumes({
                    name: volumeName,
                    owner_uuid: ALICE_USER.account.uuid,
                    state: 'ready'
                }, function onListVols(listVolsErr, vols) {
                    t.ifErr(listVolsErr, 'Listing volumes with name '
                        + volumeName + ' should not error');
                    t.ok(vols, 'result should not be empty');
                    if (vols) {
                        t.equal(vols.length, 1,
                                'only one volume should be present');
                    }
                    next(listVolsErr);
                });
            }
        ]}, function onDone(err) {
            t.end();
        });
    });

    tt.test('docker-compose down should succeed', function (t) {
        composeCli(COMPOSE_FILE, {
            /*
             * We use -v here so that volumes are also deleted.
             */
            args: '-p ' + COMPOSE_PROJECT_NAME + ' down -v',
            user: ALICE_USER
        }, function onComposeDown(composeDownErr, stdout, stderr) {
            t.ifErr(composeDownErr, 'compose down should not error');
            t.end();
        });
    });
});
