/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * Test getVmInState in lib/common.js by mocking out the common.getVm method.
 */

var format = require('util').format;
var test = require('tape');
var rewire = require('rewire');

var common = rewire('../../lib/common');


// ---- helpers

function createMockGetVm(vmState) {
    return (function mockGetVm(req, res, next) {
        req.vm = {
            state: vmState
        };
        setImmediate(next);
    });
}

function checkExpectedErr(t, err, expected) {
    if (!err) {
        t.error(format('error message matches %s: %j', expected, err));
        return;
    }

    var errorString = (typeof (err) === 'object' ? err.message : err)
        .replace(/\n$/, '');

    if (RegExp.prototype.isPrototypeOf(expected)) {
        t.ok(expected.test(errorString),
            format('error message matches %s: %j', expected, errorString));
    } else {
        t.equal(errorString, expected,
            'error message matches expected pattern');
    }
}

// ---- tests


test('getVmInState', function (tt) {

    var cases = [
        {
            name: 'no wanted or unwanted states',
            vmState: 'running',
            opts: {}
        },
        {
            name: 'exactly one wanted state',
            vmState: 'running',
            opts: {
                allowedStates: ['running']
            }
        },
        {
            name: 'one of many wanted states',
            vmState: 'running',
            opts: {
                allowedStates: ['stopped', 'running', 'starting']
            }
        },
        {
            name: 'none of many wanted states',
            vmState: 'sleeping',
            opts: {
                allowedStates: ['stopped', 'running', 'starting']
            },
            expectedErr: new RegExp('^Container state "sleeping" not allowed')
        },
        {
            name: 'exactly one unwanted state',
            vmState: 'running',
            opts: {
                disallowedStates: ['running']
            },
            expectedErr: new RegExp('^Container state "running" not allowed')
        },
        {
            name: 'one of many unwanted states',
            vmState: 'running',
            opts: {
                disallowedStates: ['stopped', 'running', 'starting']
            },
            expectedErr: new RegExp('^Container state "running" not allowed')
        },
        {
            name: 'none of many unwanted states',
            vmState: 'sleeping',
            opts: {
                disallowedStates: ['stopped', 'running', 'starting']
            }
        }
    ];

    cases.forEach(function (c) {
        if (process.env.FILTER && c.name.indexOf(process.env.FILTER) === -1) {
            tt.skip(' ' + c.name + ' (FILTER=' + process.env.FILTER + ')');
            return;
        }

        tt.test(' ' + c.name, function (t) {
            var getVmInStateFn;
            var req = {};
            var res = {};

            // rewire the common.getVm function, before calling getVmInState.
            common.__set__('getVm', createMockGetVm(c.vmState));
            getVmInStateFn = common.getVmInState(c.opts);

            getVmInStateFn(req, res, function (err) {
                if (err && c.expectedErr) {
                    checkExpectedErr(t, err, c.expectedErr);
                } else if (err) {
                    t.ifErr(err, 'getVmInState returned unexpected error');
                }
                t.end();
            });
        });
    });
});
