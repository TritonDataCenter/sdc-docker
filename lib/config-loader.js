/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var common = require('./common');
var path = require('path');
var fs = require('fs');

function loadConfigSync(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var configPath = path.resolve(__dirname, '..', 'etc', 'config.json');
    opts.log.info('Loading config from "%s"', configPath);
    var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // config-agent doesn't support arrays so ENABLED_LOG_DRIVERS is stored
    // as a comma-separated list in a string. We'll unmangle that here and
    // make sure that no driver was specified that doesn't actually exist.
    if (config.enabledLogDrivers) {
        assert.string(config.enabledLogDrivers, 'config.enabledLogDrivers-raw');
        config.enabledLogDrivers = config.enabledLogDrivers.split(',');
    } else {
        config.enabledLogDrivers = ['json-file'];
    }
    assert.arrayOfString(config.enabledLogDrivers, 'config.enabledLogDrivers');
    config.enabledLogDrivers.forEach(function _checkLogDriver(driver) {
        assert.ok(common.LOG_DRIVERS.hasOwnProperty(driver),
            'config.enabledLogDrivers.' + driver + ' is not a valid driver');
    });

    if (config.hasOwnProperty('fwrule_version')) {
        assert.finite(config.fwrule_version, 'config.fwrule_version');
    } else {
        config.fwrule_version = 1;
    }

    if (config.dcMaintEta) {
        var d = new Date(config.dcMaintEta);
        if (d.toString() !== 'Invalid Date') {
            config.dcMaintUtcEta = d.toUTCString();
        }
    }

    // Validation. XXX backend-specific config validation should not be here.
    assert.finite(config.port, 'config.port');
    assert.finite(config.defaultMemory, 'config.defaultMemory');
    assert.string(config.packagePrefix, 'config.packagePrefix');
    assert.string(config.logLevel, 'config.logLevel');
    assert.object(config.cnapi, 'config.cnapi');
    assert.string(config.cnapi.url, 'config.cnapi.url');
    assert.object(config.imgapi, 'config.imgapi');
    assert.string(config.imgapi.url, 'config.imgapi.url');
    assert.object(config.napi, 'config.napi');
    assert.string(config.napi.url, 'config.papi.url');
    assert.object(config.papi, 'config.napi');
    assert.string(config.papi.url, 'config.papi.url');
    assert.object(config.vmapi, 'config.vmapi');
    assert.string(config.vmapi.url, 'config.vmapi.url');

    return config;
}

module.exports = {
    loadConfigSync: loadConfigSync
};
