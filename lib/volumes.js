/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');

var units = require('./units');

var DEFAULT_DRIVER = 'tritonnfs';

function throwInvalidSize(size) {
    assert.string(size, 'size');

    throw new Error('size "' + size + '" is not a valid volume size');
}

/*
 * Returns the number of MiBs (Mebibytes) represented by the string "size". That
 * string must be of the form: value<unit-suffix>, where "unit-suffix" can only
 * be "G" for "gibibytes, such as "100G" for 100 gibibytes. If "size" is not a
 * valid size string, an error is thrown.
 */
function parseVolumeSize(size) {
    assert.optionalString(size, 'size');

    var baseValue;

    if (size === undefined) {
        return undefined;
    }

    var matches = size.match(/^(\d+)G$/);
    if (!matches) {
        throwInvalidSize(size);
    }

    baseValue = Number(matches[1]);
    if (isNaN(baseValue)) {
        throwInvalidSize(size);
    }

    return baseValue * units.MIBS_IN_GB;
}

module.exports = {
    DEFAULT_DRIVER: DEFAULT_DRIVER,
    parseVolumeSize: parseVolumeSize
};
