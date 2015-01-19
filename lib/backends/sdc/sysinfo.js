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
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.func(callback, 'callback');

    var log = opts.log || self.log;

    self.getContainers({
        all: true,
        app: opts.app,
        log: log,
        req_id: opts.req_id
    }, function (err, cont) {
        self.listImages(opts, function (img_err, imgs) {
            var info = {
                'Containers': cont.length,
                'Images': imgs.length,
                'Driver': 'sdc',
                'ExecutionDriver': 'sdc-0.1',
                'OperatingSystem': 'SmartDataCenter',
                'KernelVersion': '7.x',
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
