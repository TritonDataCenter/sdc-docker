/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');


function getInfo(opts, callback) {
    var self = this;
    if (callback === undefined) {
        callback = opts;
        opts = {};
    }
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var log = opts.log || self.log;

    self.getContainers({log: log, all: true}, function (err, cont) {
        self.listImages(opts, function (img_err, imgs) {
            var info = {
                'Containers': cont.length,
                'Images': imgs.length,
                'Driver': 'sdc',
                'ExecutionDriver': 'sdc-0.1',
                'KernelVersion': '3.12.0-1-amd64', // XXX
                'Debug': true,
                'NFd':  42,
                'NGoroutines': 42,
                'NEventsListener': 0,
                'InitPath': '/usr/bin/docker',
                'IndexServerAddress': ['https://index.docker.io/v1/'],
                'MemoryLimit': true,
                'SwapLimit': true,
                'IPv4Forwarding': true
            };

            callback(null, info);
        });
    });
}

module.exports = {
    getInfo: getInfo
};
