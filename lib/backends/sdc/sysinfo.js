/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var execFile = require('child_process').execFile;
var vasync = require('vasync');

var VERSION = require('../../../package.json').version;

var cachedZoneSysInfo = null;


/**
 * Return result of '/usr/bin/sysinfo' as an object.
 *
 * Note: This call caches the result of /usr/bin/sysinfo so it doesn't
 *       repeatedly shell out.
 */
function getZoneSysInfo(opts, callback) {
    if (cachedZoneSysInfo) {
        callback(null, cachedZoneSysInfo);
        return;
    }

    var log = opts.log;
    var cmd = '/usr/bin/sysinfo';

    log.debug('running command: ', cmd);
    execFile(cmd, null, function (error, stdout, stderr) {
        if (error) {
            log.error('Unable to run sysinfo');
            error.stdout = stdout;
            error.stderr = stderr;
            callback(error);
            return;
        }
        cachedZoneSysInfo = JSON.parse(stdout);
        callback(null, cachedZoneSysInfo);
    });
}

function getInfo(opts, callback) {
    var self = this;
    if (callback === undefined) {
        callback = opts;
        opts = {};
    }
    assert.object(opts, 'opts');
    assert.finite(opts.clientApiVersion, 'opts.clientApiVersion');
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.func(callback, 'callback');

    var log = opts.log || self.log;

    // See `CmdInfo` in docker.git:api/client/commands.go.
    var info = {
        Architecture: 'x86_64',
        Driver: 'sdc',
        DriverStatus: [
            ['SDCAccount', opts.account && opts.account.login]
        ],
        ExecutionDriver: 'sdc-' + VERSION,
        // Kernel version same as lxzone.
        KernelVersion: '3.12.0-1-amd64',
        LoggingDriver: 'json-file',
        OperatingSystem: 'SmartDataCenter',
        OSType: 'linux',

        Name: self.config.datacenterName,

        // IndexServerAddress changed (from array to string in ver 1.18).
        IndexServerAddress: (opts.clientApiVersion < 1.18 ?
                            ['https://index.docker.io/v1/'] :
                            'https://index.docker.io/v1/'),
        MemoryLimit: true,
        SwapLimit: true,
        IPv4Forwarding: true
    };

    var countContainers = function (cb) {
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
            cb();
        });
    };

    var countImages = function (cb) {
        opts.skip_smartos = true;
        opts.all = true;
        self.listImages(opts, function (iErr, imgs) {
            if (iErr) {
                log.warn(iErr, 'error listing images for Info');
                // Stumble on.
            } else {
                info.Images = imgs.length;
            }
            cb();
        });
    };

    var setId = function (cb) {
        getZoneSysInfo({ log: log }, function (err, zoneinfo) {
            if (err) {
                log.warn(err, 'error calling getZoneSysInfo');
                // Stumble on.
            } else {
                info.ID = zoneinfo.UUID || '(Unknown ID)';
            }
            cb();
        });
    };

    vasync.parallel({ funcs: [
        countContainers,
        countImages,
        setId
    ]}, function (err) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, info);
    });
}

module.exports = {
    getInfo: getInfo
};
