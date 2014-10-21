/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert');
var imgadm = require('./imgadm');
var containers = require('./containers');

function getInfo(options, callback)
{
    containers.getContainers({log: options.log, all: true},
        function (err, cont) {
            imgadm.getImages(options, function (img_err, images) {

                var info = {
                    "Containers": cont.length,
                    "Images": images.length,
                    "Driver": "lxzone",
                    "ExecutionDriver": "lxzone-0.1",
                    "KernelVersion": "3.12.0-1-amd64",
                    "Debug": true,
                    "NFd":  42,
                    "NGoroutines": 42,
                    "NEventsListener": 0,
                    "InitPath": "/usr/bin/docker",
                    "IndexServerAddress": ["https://index.docker.io/v1/"],
                    "MemoryLimit": true,
                    "SwapLimit": true,
                    "IPv4Forwarding": true
                };
    
                callback(null, info);
            });
        }
    );
}

module.exports = {
    getInfo: getInfo
};
