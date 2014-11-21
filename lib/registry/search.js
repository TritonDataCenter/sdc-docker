/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Docker registry index search implementation
 */

var assert = require('assert-plus');

function search(term, opts, callback) {
    assert.string(term, 'term');
    assert.func(callback, 'callback');
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var client = this.indexClient;
    var searchOpts = {
        path: '/v1/search',
        query: { q: term },
        headers: { 'X-Docker-Token': 'true' }
    };

    client.get(searchOpts, function (err, req, res, images) {
        callback(err, images);
        return;
    });
}

module.exports = search;