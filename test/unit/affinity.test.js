/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * Test lib/backends/sdc/affinity.js by mocking out the expected VMAPI.listVms
 * calls.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var format = require('util').format;
var test = require('tape');

var localityFromContainer = require('../../lib/backends/sdc/affinity')
    .localityFromContainer;


// ---- globals

var log = bunyan.createLogger({
    name: 'affinity.test',
    level: process.env.TRACE ? 'trace' : bunyan.FATAL + 1 /* off */,
    req_id: '655b2da4-3165-9549-8626-531ef9336e1e'
});

var ABE = 'abe00000-bad2-f64d-ae99-986b4fca0308';
var BOB = 'b0b00000-bfe9-d94d-8874-7b56aea62a6c';


/*
 * ---- Mock VMAPI client
 *
 * A very limited Mock VMAPI client that implements a small subset of `listVms`.
 */

function _vmDottedLookup(obj, lookup) {
    var o = obj;
    var parts = lookup.split('.');
    var s = [];
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (part === 'tag') {
            part = 'tags';  // VMAPI "?tag.foo=bar" looks up "tags.foo".
        }
        s.push(part);
        if (!o.hasOwnProperty(part)) {
            return undefined;
        }
        o = o[part];
    }
    return o;
}

function _evalPred(pred, vm) {
    if (pred.eq) {
        var val = _vmDottedLookup(vm, pred.eq[0]);
        if (val === undefined) {
            return false;
        }
        var q = pred.eq[1];
        if (q.indexOf('*') !== -1) {
            /*
             * Glob comparison.
             *
             * This conversion is broken for other regex special chars in
             * the predicate value, but this is the same naive conversion
             * that Docker Swarm is doing and this is just a quick mock.
             *      https://github.com/docker/swarm/blob/ee28008f/
             *          scheduler/filter/expr.go#L87-L88
             */
            // JSSTYLED
            var re = new RegExp('^' + q.replace(/\*/g, '.*') + '$');
            return Boolean(re.test(val));
        } else {
            return (val === q);
        }
    } else {
        throw new Error(format('unknown predicate op: %j', pred));
    }
}

function MockVMAPI(vms) {
    this.vms = vms;
}

MockVMAPI.prototype.getVm = function getVm(query, options, cb) {
    assert.uuid(query.uuid, 'query.uuid');
    assert.equal(options.headers['x-request-id'], log.fields.req_id);

    var vms = this.vms;

    if (query.owner_uuid) {
        vms = vms.filter(
            function (vm) { return vm.owner_uuid === query.owner_uuid; });
    }

    var hit;
    for (var i = 0; i < vms.length; i++) {
        if (vms[i].uuid === query.uuid) {
            hit = vms[i];
            break;
        }
    }

    if (hit && query.fields) {
        var fields = query.fields.split(',');
        var newHit = {};
        fields.forEach(function (field) {
            newHit[field] = hit[field];
        });
        hit = newHit;
    }

    if (hit) {
        cb(null, hit);
    } else {
        var err = new Error('vm ' + query.uuid + ' not found');
        err.statusCode = 404;
        err.restCode = 'ResourceNotFound';
        err.body = {
            code: 'ResourceNotFound',
            message: err.message
        };
        cb(err);
    }
};


MockVMAPI.prototype.listVms = function listVms(query, options, cb) {
    assert.equal(options.headers['x-request-id'], log.fields.req_id);

    var filtered;
    var i;
    var isMatch;
    var vm;
    var vms = this.vms;
    var vmState;

    assert.optionalUuid(query.owner_uuid, 'query.owner_uuid');
    if (query.owner_uuid) {
        vms = vms.filter(
            function (vm_) { return vm_.owner_uuid === query.owner_uuid; });
    }

    assert.optionalString(query.state, 'query.state');
    if (query.state) {
        if (query.state === 'active') {
            filtered = [];
            for (i = 0; i < vms.length; i++) {
                vm = vms[i];
                vmState = vm.state || 'running';
                if (['destroyed', 'failed'].indexOf(vmState) === -1) {
                    filtered.push(vm);
                }
            }
            vms = filtered;
        } else {
            filtered = [];
            for (i = 0; i < vms.length; i++) {
                vm = vms[i];
                vmState = vm.state || 'running';
                if (vmState === query.state) {
                    filtered.push(vm);
                }
            }
            vms = filtered;
        }
    }

    assert.optionalString(query.predicate, 'query.predicate');
    if (query.predicate) {
        var pred = JSON.parse(query.predicate);

        var hits = [];
        try {
            if (pred.or) {
                // E.g.:
                //  {"or":[
                //      {"eq":["tag.foo","b*"]},
                //      {"eq":["tag.docker:label:foo","b*"]}
                //  ]}
                for (i = 0; i < vms.length; i++) {
                    vm = vms[i];
                    for (var j = 0; j < pred.or.length; j++) {
                        var subpred = pred.or[j];
                        isMatch = _evalPred(subpred, vm);
                        log.trace({isMatch: isMatch, vm: vm, pred: subpred},
                            '_evalPred');
                        if (isMatch) {
                            hits.push(vm);
                            break;
                        }
                    }
                }
            } else if (pred.eq) {
                for (i = 0; i < vms.length; i++) {
                    vm = vms[i];
                    isMatch = _evalPred(pred, vm);
                    log.trace({isMatch: isMatch, vm: vm, pred: pred},
                        '_evalPred');
                    if (isMatch) {
                        hits.push(vm);
                    }
                }
            } else {
                throw new Error(format('unexpected listVms predicate: %j',
                    pred));
            }
        } catch (err) {
            cb(err);
            return;
        }

        vms = hits;
    }

    if (query.fields) {
        var fields = query.fields.split(',');
        vms = vms.map(function (hit) {
            var reducedVm = {};
            fields.forEach(function (field) {
                reducedVm[field] = hit[field];
            });
            return reducedVm;
        });
    }

    log.trace({query: query, vms: vms}, 'listVms');
    cb(null, vms);
};



// ---- tests


test('affinity', function (tt) {

    var vmapi = new MockVMAPI([
        // Owned by Abe:
        {
            'uuid': 'cafe0000-3943-49d5-851f-afd5e2ed93e5',
            'alias': 'cafe0',
            'owner_uuid': ABE,
            'tags': {}
        },
        {
            'uuid': 'db000000-b5eb-4e92-a542-93d4ca011294',
            'alias': 'db0',
            'owner_uuid': ABE,
            'tags': {
                'role': 'database',
                'shard': 'shard-a',
                'primary': true
            }
        },
        {
            'uuid': 'db000001-1e4b-4fbd-9763-0492e32e7d07',
            'alias': 'db1',
            'owner_uuid': ABE,
            'tags': {
                'role': 'database',
                'shard': 'shard-b'
            }
        },
        {
            'uuid': 'beef0000-f7d7-4721-9833-66700c5c280d',
            'alias': 'beef0',
            'owner_uuid': ABE,
            'docker': true,
            'tags': {
                'sdc_docker': true,
                'docker:label:role': 'cattle'
            },
            'internal_metadata': {
                // JSSTYLED
                'docker:id': 'beef0000f7d74721983366700c5c280d57f1c9bc623f454ba99d492ac2c6af74'
            }
        },

        // Owned by bob: b0b00000-bfe9-d94d-8874-7b56aea62a6c
        {
            'uuid': 'db000000-b5eb-4e92-a542-93d4ca011294',
            'alias': 'db0',
            'owner_uuid': BOB,
            'tags': {
                'role': 'database',
                'shard': 'shard-a',
                'primary': true
            }
        }
    ]);

    var cases = [
        {
            name: '(no env)',
            ownerUuid: ABE,
            container: {
                Labels: {}
            },
            locality: undefined
        },
        {
            name: '(no labels)',
            ownerUuid: ABE,
            container: {
                Env: []
            },
            locality: undefined
        },

        {
            name: '(no affinities)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['WUZZLE=fuzz']
            },
            locality: undefined
        },

        {
            name: 'role==database (env)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:role==database']
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['role==database'])
        },
        {
            name: 'role==database (label)',
            ownerUuid: ABE,
            container: {
                Labels: {'com.docker.swarm.affinities': '["role==database"]'},
                Env: ['FOO=bar']
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: ['FOO=bar'],
            modifiedAffinitiesLabel: JSON.stringify(['role==database'])
        },
        {
            name: 'role!=database (env)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:role!=database']
            },
            locality: {
                strict: true,
                far: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['role!=database'])
        },
        {
            name: 'role!=database (label)',
            ownerUuid: ABE,
            container: {
                Labels: {'com.docker.swarm.affinities': '["role!=database"]'},
                Env: ['FOO=bar']
            },
            locality: {
                strict: true,
                far: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: ['FOO=bar'],
            modifiedAffinitiesLabel: JSON.stringify(['role!=database'])
        },

        {
            name: 'role==cattle (picks up docker:label:*)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:role==cattle']
            },
            locality: {
                strict: true,
                near: ['beef0000-f7d7-4721-9833-66700c5c280d']
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['role==cattle'])
        },

        {
            name: 'shard==shard-* (glob)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:shard==shard-*']
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['shard==shard-*'])
        },
        {
            name: 'shard==*-a (glob)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:shard==*-a']
            },
            locality: {
                strict: true,
                near: ['db000000-b5eb-4e92-a542-93d4ca011294']
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['shard==*-a'])
        },

        {
            name: 'shard==/ard-[ab]$/ (regex)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:shard==/ard-[ab]$/']
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['shard==/ard-[ab]$/'])
        },

        {
            name: 'shard==nada (no hits + "==" should be an error)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:shard==nada']
            },
            err: {
                // JSSTYLED
                messageRe: /no active containers found matching tag "shard=nada" for affinity "shard==nada"/
            }
        },
        {
            name: 'shard!=nada (no hits, but not "==" so not error)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:shard!=nada']
            },
            locality: undefined
        },
        {
            name: 'shard==~nada (no hits, but not "==" so not error)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: ['affinity:shard==~nada']
            },
            locality: undefined
        },

        /*
         * `container==???` cases to test:
         * - instance uuid
         * - docker id: 32 chars and up
         * - short docker id
         * - name
         * - name glob ('*'-only)
         * - name regex
         */
        {
            name: 'container==db000000-b5eb-4e92-a542-93d4ca011294 (uuid)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==db000000-b5eb-4e92-a542-93d4ca011294'
                ]
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(
                ['container==db000000-b5eb-4e92-a542-93d4ca011294'])
        },
        {
            name: 'container==beef0000f7d7...c6af74 (64-char docker id)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    // JSSTYLED
                    'affinity:container==beef0000f7d74721983366700c5c280d57f1c9bc623f454ba99d492ac2c6af74'
                ]
            },
            locality: {
                strict: true,
                near: [
                    'beef0000-f7d7-4721-9833-66700c5c280d'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(
                // JSSTYLED
                ['container==beef0000f7d74721983366700c5c280d57f1c9bc623f454ba99d492ac2c6af74'])
        },
        {
            // JSSTYLED
            name: 'container==beef0000f7d7...c6abad (64-char docker id, bad tail chars)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    // JSSTYLED
                    'affinity:container==beef0000f7d74721983366700c5c280d57f1c9bc623f454ba99d492ac2c6abad'
                ]
            },
            err: {
                // JSSTYLED
                messageRe: /no active containers found matching "beef0000f7d74721983366700c5c280d57f1c9bc623f454ba99d492ac2c6abad" for affinity "container==beef0000f7d74721983366700c5c280d57f1c9bc623f454ba99d492ac2c6abad"/,
                restCode: 'ResourceNotFound'
            }
        },
        {
            name: 'container==beef0000f7d7 (short docker id)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==beef0000f7d7'
                ]
            },
            locality: {
                strict: true,
                near: [
                    'beef0000-f7d7-4721-9833-66700c5c280d'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(
                ['container==beef0000f7d7'])
        },
        {
            name: 'container==db0 (name)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==db0'
                ]
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['container==db0'])
        },
        {
            name: 'container==DB0 (name, no match)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==DB0'
                ]
            },
            err: {
                // JSSTYLED
                messageRe: /no active containers found matching "DB0" for affinity "container==DB0"/,
                code: 'ResourceNotFound'
            }
        },
        {
            name: 'container==db* (name glob)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==db*'
                ]
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['container==db*'])
        },
        {
            name: 'container==DB* (glob, no match)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==DB*'
                ]
            },
            err: {
                // JSSTYLED
                messageRe: /no active containers found matching "DB\*" for affinity "container==DB\*"/,
                restCode: 'ResourceNotFound'
            }
        },
        {
            name: 'container==/^db/ (name regex)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==/^db/'
                ]
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['container==/^db/'])
        },
        {
            name: 'container==/^DB/ (glob, no match)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==/^DB/'
                ]
            },
            err: {
                // JSSTYLED
                messageRe: /no active containers found matching "\/\^DB\/" for affinity "container==\/\^DB\/"/,
                restCode: 'ResourceNotFound'
            }
        },
        {
            name: 'container==/(?i)^DB/ (name regex, case-insensitive)',
            ownerUuid: ABE,
            container: {
                Labels: {},
                Env: [
                    'affinity:container==/(?i)^DB/'
                ]
            },
            locality: {
                strict: true,
                near: [
                    'db000000-b5eb-4e92-a542-93d4ca011294',
                    'db000001-1e4b-4fbd-9763-0492e32e7d07'
                ]
            },
            modifiedEnv: [],
            modifiedAffinitiesLabel: JSON.stringify(['container==/(?i)^DB/'])
        }
    ];

    cases.forEach(function (c) {
        if (process.env.FILTER && c.name.indexOf(process.env.FILTER) === -1) {
            tt.skip('  ' + c.name + ' (FILTER=' + process.env.FILTER + ')');
            return;
        }

        tt.test('  ' + c.name, function (t) {
            localityFromContainer({
                log: log,
                vmapi: vmapi,
                ownerUuid: c.ownerUuid,
                container: c.container
            }, function (err, locality) {
                if (c.err) {
                    t.ok(err, 'err calling localityFromContainer');
                    if (c.err.messageRe) {
                        t.ok(c.err.messageRe.test(err.message), format(
                            'err.message matches %s: %j', c.err.messageRe,
                            err.message));
                    }
                    if (c.err.restCode) {
                        t.equal(err.restCode, c.err.restCode, 'err.restCode');
                    }
                } else {
                    t.ifErr(err, 'no err calling localityFromContainer');
                }
                if (c.hasOwnProperty('locality')) {
                    t.deepEqual(locality, c.locality, 'locality');
                }
                if (c.modifiedEnv) {
                    t.deepEqual(c.container.Env, c.modifiedEnv,
                        'modified container.Env');
                }
                if (c.modifiedAffinitiesLabel) {
                    t.equal(c.container.Labels['com.docker.swarm.affinities'],
                        c.modifiedAffinitiesLabel,
                        // JSSTYLED
                        'modified container.Labels["com.docker.swarm.affinities"]');
                }
                t.end();
            });
        });
    });
});
