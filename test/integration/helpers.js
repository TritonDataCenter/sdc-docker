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
var vasync = require('vasync');
var VMAPI = require('sdc-clients').VMAPI;
var restify = require('restify');
var sdcutils = require('../../lib/backends/sdc/utils');

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
 * Get a simple restify JSON client to the SDC Docker Remote API.
 */
function createVmapiClient(callback) {
    loadConfig(function (err, config) {
        if (err) {
            return callback(err);
        }
        var url = fmt('http://vmapi.%s.%s',
            config.datacenter_name,
            config.dns_domain);
        var client = new VMAPI({
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
//     t.equal(info.NGoroutines, 42, 'Totally have 42 goroutines');
}

/**
 * Create a nginx VM fixture
 */

function createDockerContainer(opts, callback) {
    var payload = {
        'Hostname': '',
        'Domainname': '',
        'User': '',
        'Memory': 0,
        'MemorySwap': 0,
        'CpuShares': 0,
        'Cpuset': '',
        'AttachStdin': false,
        'AttachStdout': false,
        'AttachStderr': false,
        'PortSpecs': null,
        'ExposedPorts': {},
        'Tty': false,
        'OpenStdin': false,
        'StdinOnce': false,
        'Env': [],
        'Cmd': null,
        'Image': 'nginx',
        'Volumes': {},
        'WorkingDir': '',
        'Entrypoint': null,
        'NetworkDisabled': false,
        'OnBuild': null,
        'SecurityOpt': null,
        'HostConfig': {
            'Binds': null,
            'ContainerIDFile': '',
            'LxcConf': [],
            'Privileged': false,
            'PortBindings': {},
            'Links': null,
            'PublishAllPorts': false,
            'Dns': null,
            'DnsSearch': null,
            'ExtraHosts': null,
            'VolumesFrom': null,
            'Devices': [],
            'NetworkMode': 'bridge',
            'CapAdd': null,
            'CapDrop': null,
            'RestartPolicy': {
                'Name': '',
                'MaximumRetryCount': 0
            }
        }
    };

    var dockerClient = opts.dockerClient;
    var vmapiClient = opts.vmapiClient;
    var t = opts.test;
    var response = {};

    vasync.waterfall([
        function (next) {
            // Post create request
            dockerClient.post('/v1.15/containers/create', payload, onpost);
            function onpost(err, res, req, body) {
                t.deepEqual(
                    body.Warnings, [], 'Warnings should be present and empty');
                t.ok(body.Id, 'Id should be present');
                response.id = body.Id;
                next(err);
            }
        },
        function (next) {
            // Attempt to get new container
            dockerClient.get(
                '/v1.15/containers/' + response.id + '/json', onget);
            function onget(err, res, req, body) {
                t.error(err);
                response.inspect = body;
                response.uuid = sdcutils.dockerIdToUuid(response.id);
                next(err);
            }
        },
        function (next) {
            vmapiClient.getVm({ uuid: response.uuid }, function (err, vm) {
                t.error(err);
                response.vm = vm;
                next(err);
            });
        }
    ], function (err) {
        t.error(err);
        callback(null, response);
    });
}

module.exports = {
    loadConfig: loadConfig,
    createDockerRemoteClient: createDockerRemoteClient,
    createVmapiClient: createVmapiClient,

    createDockerContainer: createDockerContainer,

    ifErr: common.ifErr,
    assertInfo: assertInfo
};
