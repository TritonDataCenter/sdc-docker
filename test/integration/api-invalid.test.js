/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker create`.
 */

var p = console.log;

var fmt = require('util').format;
var test = require('tape');
var util = require('util');
var vasync = require('vasync');

var h = require('./helpers');



// --- Globals

var CLIENTS = {};
var FMT = {
    arrayOfStr: '(Validation) "%s" must be an array of strings',
    bool: '(Validation) "%s" must be a boolean',
    obj: '(Validation) "%s" must be an object',
    str: '(Validation) "%s" must be a string'
};
var STR = {
    portNum: '(Validation) HostConfig.PortBindings: invalid port number',
    portSpec:
        '(Validation) HostConfig.PortBindings: port specification incorrect: '
        + 'must be "number/protocol"',
    proto: '(Validation) HostConfig.PortBindings: unknown protocol: '
        + 'must be tcp or udp',
    tcp: 'publish port: only support exposing 8 TCP ports',
    udp: 'publish port: only support exposing 8 UDP ports'
};


// --- Tests

test('setup', function (tt) {

    tt.test('vmapi client', function (t) {
        h.createVmapiClient(function (err, client) {
            t.error(err, 'vmapi client err');
            CLIENTS.vmapi = client;
            return t.end();
        });
    });

    tt.test('docker client', function (t) {
        h.createDockerRemoteClient(function (err, client) {
            t.error(err, 'docker client err');
            CLIENTS.docker = client;
            return t.end();
        });
    });

});


test('create', function (t) {
    var invalid = [
        {
            prop: 'Image',
            err: fmt(FMT.str, 'Image'),
            inputs: [ null, 1, [], {} ]
        },
        {
            prop: 'Name',
            err: fmt(FMT.str, 'Name'),
            inputs: [ 1, [], {} ]
        },
        {
            prop: 'Cmd',
            err: fmt(FMT.arrayOfStr, 'Cmd'),
            inputs: [ 'asdf', 1, {}, [ 1 ], [ 'asdf', {} ] ]
        },
        {
            prop: 'Env',
            err: fmt(FMT.arrayOfStr, 'Env'),
            inputs: [ 'asdf', 1, {}, [ 1 ], [ 'asdf', {} ] ]
        },
        {
            prop: 'Entrypoint',
            err: fmt(FMT.arrayOfStr, 'Entrypoint'),
            inputs: [ 'asdf', 1, {}, [ 1 ], [ 'asdf', {} ] ]
        },
        {
            prop: 'HostConfig',
            err: fmt(FMT.obj, 'HostConfig'),
            inputs: [ 'asdf', 1, [], [ 1 ], [ 'asdf', {} ] ]
        },
        {
            prop: 'HostConfig.PublishAllPorts',
            err: fmt(FMT.bool, 'HostConfig.PublishAllPorts'),
            inputs: [ 'asdf', 1, [], {} ]
        },
        {
            prop: 'HostConfig.PortBindings',
            err: fmt(FMT.obj, 'HostConfig.PortBindings'),
            inputs: [ 'asdf', 1, [] ]
        },

        // PortBindings with invalid port formats
        {
            prop: 'HostConfig.PortBindings',
            err: STR.portSpec,
            inputs: [ { 'foo': {} } ]
        },
        {
            prop: 'HostConfig.PortBindings',
            err: STR.portNum,
            inputs: [ { 'a/foo': {} }, { '0/udp': {} }, { '-1/udp': {} },
                { 'a/tcp': {} }, { '65536/tcp': {} } ]
        },
        {
            prop: 'HostConfig.PortBindings',
            err: STR.proto,
            inputs: [ { '32/foo': {} } ]
        },

        // Too many ports (not to be confused with "too many cooks")
        {
            prop: 'HostConfig.PortBindings',
            err: STR.tcp,
            inputs: [ { '31/tcp': {}, '32/tcp': {}, '33/tcp': {},
                '34/tcp': {}, '35/tcp': {}, '36/tcp': {}, '37/tcp': {},
                '38/tcp': {}, '39/tcp': {} } ]
        },
        {
            prop: 'HostConfig.PortBindings',
            err: STR.udp,
            inputs: [ { '31/udp': {}, '32/udp': {}, '33/udp': {},
                '34/udp': {}, '35/udp': {}, '36/udp': {}, '37/udp': {},
                '38/udp': {}, '39/udp': {} } ]
        }
    ];


    function createInvalid(params, expErr, t2) {
        var arg = {
            dockerClient: CLIENTS.docker,
            expectedErr: expErr,
            extra: params,
            test: t2,
            vmapiClient: CLIENTS.vmapi
        };

        h.createDockerContainer(arg, function _onCreate() {
            return t2.end();
        });
    }

    invalid.forEach(function (item) {
        item.inputs.forEach(function (val) {
            var params = {};
            params[item.prop] = val;
            t.test(item.prop + '=' + JSON.stringify(val),
                createInvalid.bind(null, params, item.err));
        });
    });
});
