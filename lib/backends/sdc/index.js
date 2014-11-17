/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * A sdc-docker backend to expose an *entire SDC* as a single Docker Engine.
 */

var assert = require('assert-plus');

var containers = require('./containers');
var sysinfo = require('./sysinfo');
var images = require('./images');



function SdcBackend(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.config, 'opts.config');

    this.log = opts.log.child({backend: 'sdc'}, true);
    this.config = opts.config;
}

// sysinfo.js
SdcBackend.prototype.getInfo = sysinfo.getInfo;

// containers.js
SdcBackend.prototype.createContainer = containers.createContainer;
SdcBackend.prototype.deleteContainer = containers.deleteContainer;
SdcBackend.prototype.execContainer = containers.execContainer;
SdcBackend.prototype.execStart = containers.execStart;
SdcBackend.prototype.getContainers = containers.getContainers;
SdcBackend.prototype.inspectContainer = containers.inspectContainer;
SdcBackend.prototype.killContainer = containers.killContainer;
SdcBackend.prototype.restartContainer = containers.restartContainer;
SdcBackend.prototype.startContainer = containers.startContainer;
SdcBackend.prototype.stopContainer = containers.stopContainer;
SdcBackend.prototype.waitContainer = containers.waitContainer;

// images.js
SdcBackend.prototype.listImages = images.listImages;
SdcBackend.prototype.inspectImage = images.inspectImage;

module.exports = SdcBackend;
