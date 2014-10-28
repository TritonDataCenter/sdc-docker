/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var containers = require('./containers');
var sysinfo = require('./sysinfo');


function LxZoneBackend(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.config, 'opts.config');

    this.log = opts.log.child({backend: 'sdc'}, true);
    this.config = opts.config;
}

LxZoneBackend.prototype.getInfo = sysinfo.getInfo;

LxZoneBackend.prototype.createContainer = containers.createContainer;
LxZoneBackend.prototype.getContainers = containers.getContainers;

module.exports = LxZoneBackend;
