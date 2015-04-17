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
    get: getVm,
    init: vmapiInit
};
