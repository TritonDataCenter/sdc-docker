/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');

var VERSION = require('../../../package.json').version;



function getInfo(opts, callback) {
    var self = this;
    if (callback === undefined) {
        callback = opts;
        opts = {};
    }
    assert.object(opts, 'opts');
    assert.number(opts.clientApiVersion, 'opts.clientApiVersion');
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.func(callback, 'callback');

    var log = opts.log || self.log;

    // See `CmdInfo` in docker.git:api/client/commands.go.
    var info = {
        Driver: 'sdc',
        DriverStatus: [
            ['SDCAccount', opts.account && opts.account.login]
        ],
        ExecutionDriver: 'sdc-' + VERSION,
        // Kernel version same as lxzone.
        KernelVersion: '3.12.0-1-amd64',
        OperatingSystem: 'SmartDataCenter',

        Name: self.config.datacenterName,
        // TODO: should we have ID?

        // IndexServerAddress changed (from array to string in ver 1.18).
        IndexServerAddress: (opts.clientApiVersion < 1.18 ?
                            ['https://index.docker.io/v1/'] :
                            'https://index.docker.io/v1/'),
        MemoryLimit: true,
        SwapLimit: true,
        IPv4Forwarding: true
    };

    self.getContainerCount({
        app: opts.app,
        log: log,
        req_id: opts.req_id,
        account: opts.account
    }, function (cErr, num) {
        if (cErr) {
            log.warn(cErr, 'error listing containers for Info');
            // Stumble on.
        } else {
            info.Containers = num;
        }

        opts.skip_smartos = true;
        opts.all = true;
        self.listImages(opts, function (iErr, imgs) {
            if (iErr) {
                log.warn(iErr, 'error listing images for Info');
                // Stumble on.
            } else {
                info.Images = imgs.length;
            }

            callback(null, info);
        });
    });
}

module.exports = {
    getInfo: getInfo
};
