/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Test lib/backends/sdc/affinity.js parsing.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var format = require('util').format;
var test = require('tape');

var affinityFromContainer = require('../../lib/backends/sdc/affinity')
    .affinityFromContainer;


// ---- globals


var log = bunyan.createLogger({
    name: 'affinity.test',
    level: process.env.TRACE ? 'trace' : bunyan.FATAL + 1 /* off */,
    req_id: '655b2da4-3165-9549-8626-531ef9336e1e'
});


// ---- tests


test('affinity', function (tt) {
    var cases = [
        {
            name: '(no env)',
            container: {
                Labels: {}
            },
            affinity: undefined
        },
        {
            name: '(no labels)',
            container: {
                Env: []
            },
            affinity: undefined
        },

        {
            name: '(no affinities)',
            container: {
                Labels: {},
                Env: ['WUZZLE=fuzz']
            },
            affinity: undefined
        },
        {
            name: 'role==database (env)',
            container: {
                Labels: {},
                Env: ['affinity:role==database']
            },
            affinity: [ {
                key: 'role',
                operator: '==',
                value: 'database',
                valueType: 'exact',
                isSoft: false
            } ],
            modifiedEnv: []
        },
        {
            name: 'role==database (label)',
            container: {
                Labels: {'com.docker.swarm.affinities': '["role==database"]'},
                Env: ['FOO=bar']
            },
            affinity: [ {
                key: 'role',
                operator: '==',
                value: 'database',
                valueType: 'exact',
                isSoft: false
            } ],
            modifiedEnv: ['FOO=bar']
        },
        {
            name: 'role!=database (env)',
            container: {
                Labels: {},
                Env: ['affinity:role!=database']
            },
            affinity: [ {
                key: 'role',
                operator: '!=',
                value: 'database',
                valueType: 'exact',
                isSoft: false
            } ],
            modifiedEnv: []
        },
        {
            name: 'role!=database (label)',
            container: {
                Labels: {'com.docker.swarm.affinities': '["role!=database"]'},
                Env: ['FOO=bar']
            },
            affinity: [ {
                key: 'role',
                operator: '!=',
                value: 'database',
                valueType: 'exact',
                isSoft: false
            } ],
            modifiedEnv: ['FOO=bar']
        },
        {
            name: 'shard==shard-* (glob)',
            container: {
                Labels: {},
                Env: ['affinity:shard==shard-*']
            },
            affinity: [ {
                key: 'shard',
                operator: '==',
                value: 'shard-*',
                valueType: 'glob',
                isSoft: false
            } ],
            modifiedEnv: []
        },
        {
            name: 'shard==*-a (glob)',
            container: {
                Labels: {},
                Env: ['affinity:shard==*-a']
            },
            affinity: [ {
                key: 'shard',
                operator: '==',
                value: '*-a',
                valueType: 'glob',
                isSoft: false
            } ],
            modifiedEnv: []
        },
        {
            name: 'shard==/ard-[ab]$/ (regex)',
            container: {
                Labels: {},
                Env: ['affinity:shard==/ard-[ab]$/']
            },
            affinity: [ {
                key: 'shard',
                operator: '==',
                value: '/ard-[ab]$/',
                valueType: 're',
                isSoft: false
            } ],
            modifiedEnv: []
        },
        {
            name: 'container==db000000-b5eb-4e92-a542-93d4ca011294 (uuid)',
            container: {
                Labels: {},
                Env: [
                    'affinity:container==db000000-b5eb-4e92-a542-93d4ca011294'
                ]
            },
            affinity: [ {
                key: 'container',
                operator: '==',
                value: 'db000000-b5eb-4e92-a542-93d4ca011294',
                valueType: 'exact',
                isSoft: false
            } ],
            modifiedEnv: []
        },
        {
            name: 'container==beef0000f7d7...c6af74 (64-char docker id)',
            container: {
                Labels: {},
                Env: [
                    // JSSTYLED
                    'affinity:container==beef0000f7d74721983366700c5c280d57f1c9bc623f454ba99d492ac2c6af74'
                ]
            },
            affinity: [ {
                key: 'container',
                operator: '==',
                // JSSTYLED
                value: 'beef0000f7d74721983366700c5c280d57f1c9bc623f454ba99d492ac2c6af74',
                valueType: 'exact',
                isSoft: false
            } ],
            modifiedEnv: []
        },
        {
            name: 'container==beef0000f7d7 (short docker id)',
            container: {
                Labels: {},
                Env: [
                    'affinity:container==beef0000f7d7'
                ]
            },
            affinity: [ {
                key: 'container',
                operator: '==',
                value: 'beef0000f7d7',
                valueType: 'exact',
                isSoft: false
            } ],
            modifiedEnv: []
        },
        {
            name: 'container==~foo',
            container: {
                Labels: {},
                Env: [
                    'affinity:container==~foo'
                ]
            },
            affinity: [ {
                key: 'container',
                operator: '==',
                value: 'foo',
                valueType: 'exact',
                isSoft: true
            } ],
            modifiedEnv: []
        },
        {
            name: 'container!=~foo',
            container: {
                Labels: {},
                Env: [
                    'affinity:container!=~foo'
                ]
            },
            affinity: [ {
                key: 'container',
                operator: '!=',
                value: 'foo',
                valueType: 'exact',
                isSoft: true
            } ],
            modifiedEnv: []
        },

        // parse errors
        {
            name: 'container=~foo (invalid syntax)',
            container: {
                Labels: {},
                Env: [
                    'affinity:container=~foo'
                ]
            },
            affinity: undefined,
            errMsg: /could not find operator/
        },
        {
            name: 'container== (invalid syntax)',
            container: {
                Labels: {},
                Env: [
                    'affinity:container=='
                ]
            },
            affinity: undefined,
            errMsg: /invalid value/
        },
        {
            name: '==foo (invalid syntax)',
            container: {
                Labels: {},
                Env: [
                    'affinity:==foo'
                ]
            },
            affinity: undefined,
            errMsg: /invalid key/
        },
        {
            name: 'container==/a!/ (invalid syntax)',
            container: {
                Labels: {},
                Env: [
                    'affinity:container==/a!/'
                ]
            },
            affinity: undefined,
            errMsg: /invalid value/
        }
    ];

    cases.forEach(function checkCase(c) {
        if (process.env.FILTER && c.name.indexOf(process.env.FILTER) === -1) {
            tt.skip('  ' + c.name + ' (FILTER=' + process.env.FILTER + ')');
            return;
        }

        tt.test('  ' + c.name, function runTest(t) {
            affinityFromContainer({
                log: log,
                container: c.container
            }, function parseCb(err, affinity) {
                if (c.errMsg) {
                    t.ok(err, 'err calling affinityFromContainer');

                    t.ok(c.errMsg.test(err.message), format(
                        'err.message matches %s: %j', c.errMsg,
                        err.message));
                } else {
                    t.ifErr(err, 'no err calling affinityFromContainer');
                }

                if (c.affinity) {
                    t.deepEqual(affinity, c.affinity, 'affinity');
                }

                if (c.modifiedEnv) {
                    t.deepEqual(c.container.Env, c.modifiedEnv,
                        'modified container.Env');
                }

                t.end();
            });
        });
    });
});
