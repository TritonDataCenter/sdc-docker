/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var common = require('./common');

/**
 * Returns true if the container is publishing ports
 */
function publishingPorts(container) {
    var hostConf = container.HostConfig;

    if (hostConf.PublishAllPorts || !common.objEmpty(hostConf.PortBindings)) {
        return true;
    }

    return false;
}

module.exports = {
    publishingPorts: publishingPorts
};