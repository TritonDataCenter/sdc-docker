/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * A sdc-docker backend to expose an *entire SDC* as a single Docker Engine.
 */

var assert = require('assert-plus');

var build = require('./build');
var containers = require('./containers');
var sysinfo = require('./sysinfo');
var images = require('./images');
var networks = require('./networks');
var volumes = require('./volumes');


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
SdcBackend.prototype.attachContainer = containers.attachContainer;
SdcBackend.prototype.createContainer = containers.createContainer;
SdcBackend.prototype.containerLogs = containers.containerLogs;
SdcBackend.prototype.containerStats = containers.containerStats;
SdcBackend.prototype.deleteContainer = containers.deleteContainer;
SdcBackend.prototype.deleteLink = containers.deleteLink;
SdcBackend.prototype.execContainer = containers.execContainer;
SdcBackend.prototype.execResize = containers.execResize;
SdcBackend.prototype.execStart = containers.execStart;
SdcBackend.prototype.getContainers = containers.getContainers;
SdcBackend.prototype.getContainerCount = containers.getContainerCount;
SdcBackend.prototype.getVmById = containers.getVmById;
SdcBackend.prototype.inspectContainer = containers.inspectContainer;
SdcBackend.prototype.killContainer = containers.killContainer;
SdcBackend.prototype.psContainer = containers.psContainer;
SdcBackend.prototype.renameContainer = containers.renameContainer;
SdcBackend.prototype.resizeContainer = containers.resizeContainer;
SdcBackend.prototype.restartContainer = containers.restartContainer;
SdcBackend.prototype.startContainer = containers.startContainer;
SdcBackend.prototype.stopContainer = containers.stopContainer;
SdcBackend.prototype.waitContainer = containers.waitContainer;
SdcBackend.prototype.copyContainer = containers.copyContainer;
SdcBackend.prototype.containerArchiveStream = containers.containerArchiveStream;

// images.js
SdcBackend.prototype.deleteImage = images.deleteImage;
SdcBackend.prototype.getImageCount = images.getImageCount;
SdcBackend.prototype.getImageHistory = images.getImageHistory;
SdcBackend.prototype.getScratchImage = images.getScratchImage;
SdcBackend.prototype.listImages = images.listImages;
SdcBackend.prototype.inspectImage = images.inspectImage;
SdcBackend.prototype.pullImage = images.pullImage;
SdcBackend.prototype.pushImage = images.pushImage;
SdcBackend.prototype.imgFromConfigDigest = images.imgFromConfigDigest;
SdcBackend.prototype.imgFromName = images.imgFromName;
SdcBackend.prototype.tagsFromRepoName = images.tagsFromRepoName;
SdcBackend.prototype.tagImage = images.tagImage;

// build.js
SdcBackend.prototype.buildImage = build.buildImage;
SdcBackend.prototype.commitImage = build.commitImage;

// networks.js
SdcBackend.prototype.findNetworkOrPoolByNameOrId =
    networks.findNetworkOrPoolByNameOrId;
SdcBackend.prototype.inspectNetwork = networks.inspectNetwork;
SdcBackend.prototype.listNetworksForAccount = networks.listNetworksForAccount;
SdcBackend.prototype.getNapiNetworksForAccount =
    networks.getNapiNetworksForAccount;

// volumes.js
SdcBackend.prototype.createVolume = volumes.createVolume;
SdcBackend.prototype.listVolumes = volumes.listVolumes;
SdcBackend.prototype.deleteVolume = volumes.deleteVolume;
SdcBackend.prototype.inspectVolume = volumes.inspectVolume;

module.exports = SdcBackend;
