/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Helpers for interacting with VMAPI
 */

var assert = require('assert-plus');
var common = require('./common');
var h = require('../integration/helpers');


// --- Globals


var VMAPI;


// --- Exports


/**
 * Get a VM from VMAPI
 */
function getVm(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');

    // XXX: pass in x-request-id here
    VMAPI.getVm({ uuid: h.dockerIdToUuid(opts.id) }, function (err, obj) {
        t.ifErr(err, 'getVm error');

        // XXX: allow opts.expectedErr
        if (err) {
            common.done(t, callback, err);
            return;
        }

        common.partialExp(t, opts, obj);
        common.expected(t, opts, obj);
        common.done(t, callback, err, obj);
    });
}


/**
 * UpdateVm (https://mo.joyent.com/docs/vmapi/master/#UpdateVm)
 */
function updateVm(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.object(opts.payload, 'opts.payload');

    VMAPI.updateVm({uuid: h.dockerIdToUuid(opts.id), payload: opts.payload},
            function (err, obj) {
        t.ifErr(err, 'updateVm error');

        // XXX: allow opts.expectedErr
        if (err) {
            common.done(t, callback, err);
            return;
        }

        common.partialExp(t, opts, obj);
        common.expected(t, opts, obj);
        common.done(t, callback, err, obj);
    });
}

/**
 * Add/update tags on a VM
 * (https://mo.joyent.com/docs/vmapi/master/#AddMetadata)
 */
function addTags(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.object(opts.tags, 'opts.tags');

    VMAPI.addMetadata('tags', {
        uuid: h.dockerIdToUuid(opts.id),
        metadata: opts.tags
    }, function (err, obj) {
        t.ifErr(err, 'addTags error');
        if (err) {
            common.done(t, callback, err);
            return;
        }
        common.partialExp(t, opts, obj);
        common.expected(t, opts, obj);
        common.done(t, callback, err, obj);
    });
}


/*
 * Wait for given tag values to be applied to a VM (from an earlier
 * `addTags` call).
 *
 * Note: This is a poorman's version of
 * `TritonApi.prototype.waitForInstanceTagChanges` from node-triton
 * github.com/joyent/node-triton/blob/ba16f0d9/lib/tritonapi.js#L1127-L1283
 */
function waitForTagUpdate(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');  // the docker container id
    assert.object(opts.tags, 'opts.tags');

    var POLL_INTERVAL = 2 * 1000;
    var uuid = h.dockerIdToUuid(opts.id);

    var poll = function () {
        VMAPI.getVm({uuid: uuid}, function (err, obj) {
            t.ifErr(err, 'waitForTagUpdate: poll getVm ' + uuid);
            if (err) {
                common.done(t, callback, err);
                return;
            }

            // Determine in changes are not yet applied (incomplete).
            var incomplete = false;
            var keys = Object.keys(opts.tags);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (obj.tags[k] !== opts.tags[k]) {
                    incomplete = true;
                    break;
                }
            }

            if (!incomplete) {
                common.done(t, callback, err);
            } else {
                setTimeout(poll, POLL_INTERVAL);
            }
        });
    };

    setImmediate(poll);
}


/**
 * Initialize the VMAPI client
 */
function vmapiInit(t) {
    h.createVmapiClient(function (err, client) {
        t.error(err, 'vmapi client err');
        VMAPI = client;
        t.end();
        return;
    });
}


module.exports = {
    init: vmapiInit,
    get: getVm,
    update: updateVm,

    addTags: addTags,
    waitForTagUpdate: waitForTagUpdate
};
