/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker info`.
 */

var p = console.log;

var test = require('tape');
var util = require('util');
var vasync = require('vasync');

var h = require('./helpers');



// --- Globals

var CLIENT;



// --- Setup

test('setup', function (t) {
    h.createDockerRemoteClient(function (err, client) {
        CLIENT = client;
        t.end();
    });
});


// --- Tests

test('/v1.15/info', function (t) {
    CLIENT.get('/v1.15/info', function (err, res, req, body) {
        h.assertInfo(t, body);
        t.end();
    });
});

test('/v1.16/info', function (t) {
    CLIENT.get('/v1.16/info', function (err, res, req, body) {
        h.assertInfo(t, body);
        t.end();
    });
});

// TODO: get this working: create lx zone, prep it, call `docker` client in it
//test('docker info', function (t) {
//    h.dockerExec('info', function (err, stdout, stderr) {
//        if (h.ifErr(t, err)) {
//            return t.end();
//        }
//        var info = JSON.parse(stdout);
//        h.assertInfo(t, info);
//        t.end();
//    });
//});
