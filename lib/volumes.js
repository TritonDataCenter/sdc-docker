/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');

var units = require('./units');

var DEFAULT_DRIVER = 'tritonnfs';

/*
 * Returns a string representing a unique volume name.
 */
function generateVolumeName() {
    // The format of an automatically generated volume name is a string of 64
    // characters representing hexadecimal numbers. It comes from Docker's
    // implementation for local volumes:
    // https://github.com/docker/docker/blob/master/daemon/create.go#L211 and
    // https://github.com/docker/docker/blob/master/pkg/stringid/stringid.go#L53
    return (libuuid.create() + libuuid.create()).replace(/-/g, '');
}

function throwInvalidSize(size) {
    assert.string(size, 'size');

    throw new Error('size "' + size + '" is not a valid volume size');
}

/*
 * Returns the number of MiBs (Mebibytes) represented by the string "size". That
 * string can have different format suffixes, such as "100GB", "100G", etc.
 * If "size" is not a valid size string, an error is thrown.
 */
function parseVolumeSize(size) {
    assert.optionalString(size, 'size');

    var MULTIPLIERS_TABLE = {
        g: units.MIBS_IN_GB,
        GB: units.MIBS_IN_GB,
        m: 1,
        MB: 1
    };

    var multiplierSymbol, multiplier;
    var baseValue;

    if (size === undefined) {
        return undefined;
    }

    var matches = size.match(/(\d+)(g|m|G|M|gb|mb|GB|MB)/);
    if (!matches) {
        throwInvalidSize(size);
    }

    multiplierSymbol = matches[2];
    multiplier = MULTIPLIERS_TABLE[multiplierSymbol];
    baseValue = Number(matches[1]);
    if (isNaN(baseValue) || multiplier === undefined) {
        throwInvalidSize(size);
    }

    return baseValue * multiplier;
}

module.exports = {
    DEFAULT_DRIVER: DEFAULT_DRIVER,
    generateVolumeName: generateVolumeName,
    parseVolumeSize: parseVolumeSize
};
