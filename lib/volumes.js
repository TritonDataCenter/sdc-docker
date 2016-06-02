/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var libuuid = require('libuuid');

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

module.exports = {
    generateVolumeName: generateVolumeName,
    DEFAULT_DRIVER: DEFAULT_DRIVER
};
