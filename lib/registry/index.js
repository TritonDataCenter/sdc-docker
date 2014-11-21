/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Docker registry client implementation
 *
 * TODO eventually this will need to talk to different registry types
 */

var assert = require('assert-plus');
var restify = require('restify');

var search = require('./search');

function Registry(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.config, 'opts.config');

    // The index server provides search for images
    assert.string(opts.config.indexUrl, 'opts.config.indexUrl');
    // The registry server provides the rest of the image handling functionality
    assert.string(opts.config.registryUrl, 'opts.config.registryUrl');

    this.log = opts.log.child({ registry: true }, true);
    this.config = opts.config;

    this.indexClient = restify.createJsonClient({
    	url: this.config.indexUrl,
    	log: this.log
    });

    this.registryClient = restify.createJsonClient({
    	url: this.config.registryUrl,
    	log: this.log
    });
}

// search.js
Registry.prototype.search = search;

module.exports = Registry;
