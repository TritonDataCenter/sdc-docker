/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Helpers for running the docker CLI in tests
 */

var assert = require('assert-plus');
var common = require('./common');
var fmt = require('util').format;
var h = require('../integration/helpers');
var vasync = require('vasync');



// --- Globals


var ALICE;
var CREATED = [];
var LAST_CREATED;
var LOG = require('../lib/log');
var state = {
    log: LOG
};


// --- Exports


/**
 * Initialize the alice DockerEnv
 */
function cliInit(t) {
    h.getDockerEnv(t, state, {account: 'sdcdockertest_alice'},
            function (err, env) {
        t.ifErr(err);
        t.ok(env, 'have a DockerEnv for alice');
        ALICE = env;

        t.end();
        return;
    });
}


/**
 * `docker inspect <id>`
 */
function cliInspect(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');

    ALICE.docker('inspect ' + opts.id, function (err, stdout, stderr) {
        var obj;

        t.ifErr(err, 'docker inspect');
        t.equal(stderr, '', 'stderr');

        // XXX: allow setting opts.expectedErr
        if (err) {
            common.done(t, callback, err);
            return;
        }

        if (!stdout) {
            var stdoutErr = new Error('no stdout!');
            t.ifErr(stdoutErr, 'no stdout found');
            common.done(t, callback, stdoutErr);
            return;
        }

        try {
            // This returns an array for some reason:
            obj = JSON.parse(stdout)[0];
        } catch (parseErr) {
            common.done(t, callback, parseErr);
            return;
        }

        common.partialExp(t, opts, obj);

        common.done(t, callback, err, obj);
        return;
    });
}


/**
 * Removes all docker VMs created during this test
 */
function cliRmAllCreated(t) {
    if (CREATED.length === 0) {
        t.ok(true, 'No VMs created');
        t.end();
        return;
    }

    if (!ALICE) {
        t.ok(true, 'No docker env: not deleting');
        t.end();
        return;
    }

    vasync.forEachParallel({
        inputs: CREATED,
        func: function _delOne(id, cb) {
            ALICE.docker('rm -f ' + id, function (err, stdout, stderr) {
                t.ifErr(err, 'rm container ' + id);

                cb();
                return;
            });
        }
    }, function () {
        t.end();
        return;
    });
}


/**
 * `docker run <cmd>`
 */
function cliRun(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('run ' + opts.args, function (err, stdout, stderr) {
        var id;

        if (stdout) {
            id = stdout.split('\n')[0];
        }

        if (opts.expectedErr) {
            if (id) {
                t.ok(false, 'expected error but got ID: ' + id);
            }

            common.expErr(t, stderr, opts.expectedErr, callback);
            return;

        } else {
            t.ifErr(err, 'docker run');
            t.equal(stderr, '', 'stderr');
        }

        if (id) {
            t.ok(id, fmt('"docker run %s" -> ID %s', opts.args, id));
            CREATED.push(id);
            LAST_CREATED = id;
        }

        common.done(t, callback, err, id);
        return;
    });
}


module.exports = {
    get accountUuid() {
        return ALICE.account.uuid;
    },
    init: cliInit,
    inspect: cliInspect,
    get lastCreated() {
        return LAST_CREATED;
    },
    rmAllCreated: cliRmAllCreated,
    run: cliRun
};
