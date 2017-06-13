/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Tests for the /admin/config endpoint
 */

var restify = require('restify');
var test = require('tape');

var adminClient;

// include the fields from the sapi template
var EXPECTED_FIELDS = [
    'account_allowed_dcs',
    'account_allowed_dcs_msg',
    'adminUuid',
    'backend',
    'binder',
    'cnapi',
    'datacenterName',
    'defaultMaxLogSize',
    'defaultMemory',
    'dockerRegistryInsecure',
    'enabledLogDrivers',
    'externalNetwork',
    'fwapi',
    'httpProxy',
    'imgapi',
    'logLevel',
    'moray',
    'napi',
    'overlay',
    'packagePrefix',
    'papi',
    'port',
    'tls',
    'ufds',
    'useTls',
    'vmapi',
    'wfapi'
];

// --- Tests

test('setup', function (tt) {
    tt.test(' create admin client', function (t) {
        t.ok(process.env.DOCKER_ADMIN_URL, 'have DOCKER_ADMIN_URL: '
            + JSON.stringify(process.env.DOCKER_ADMIN_URL));

        adminClient = restify.createJsonClient({
            url: process.env.DOCKER_ADMIN_URL
        });
        t.ok(adminClient, 'created a restify client');

        t.end();
    });
});

test('test /admin/config', function (tt) {
    tt.test(' GET /admin/config', function (t) {
        adminClient.get('/admin/config', function onConfig(err, req, res, obj) {
            t.ifErr(err, 'getting config should succeed');

            t.ok(obj, 'have config object');

            EXPECTED_FIELDS.forEach(function checkExpectedField(field) {
                t.ok(obj.hasOwnProperty(field), 'config should have ' + field
                    + ', got: ' + JSON.stringify(obj[field]));
            });

            t.end();
        });
    });
});
