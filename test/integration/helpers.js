/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Test helpers for SDC Docker integration tests
 */

var p = console.log;
var assert = require('assert-plus');
var exec = require('child_process').exec;
var fmt = require('util').format;
var restify = require('restify');

var common = require('../lib/common');



// --- Exported functions

/**
 * Load the SDC config.
 */
function loadConfig(callback) {
    assert.func(callback, 'callback');

    var cmd = '/usr/bin/bash /lib/sdc/config.sh -json';
    exec(cmd, function (err, stdout, stderr) {
        if (err) {
            return callback(err);
        }
        try {
            callback(null, JSON.parse(stdout));
        } catch (parseErr) {
            callback(parseErr);
        }
    });
}


/**
 * Get a simple restify JSON client to the SDC Docker Remote API.
 */
function createDockerRemoteClient(callback) {
    loadConfig(function (err, config) {
        if (err) {
            return callback(err);
        }
        var url = fmt('http://docker.%s.%s:2375',
            config.datacenter_name,
            config.dns_domain);
        var client = restify.createJsonClient({
            url: url,
            agent: false
        });
        callback(err, client);
    });
}


/**
 * Test the given Docker 'info' API response.
 */
function assertInfo(t, info) {
    t.equal(typeof (info), 'object', 'info is an object');
    t.equal(info.Driver, 'sdc', 'Driver is "sdc"');
    t.equal(info.NGoroutines, 42, 'Totally have 42 goroutines');
}

module.exports = {
    loadConfig: loadConfig,
    createDockerRemoteClient: createDockerRemoteClient,

    ifErr: common.ifErr,
    assertInfo: assertInfo
};
