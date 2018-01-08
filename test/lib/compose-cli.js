/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

/**
 * `docker-compose <opts.args>`
 *
 * @param composeConfig {String} The compose configuration to deploy, typically
 *   the full content of a docker-compose.yml file.
 * @param opts {Object}:
 *   - args {String} The command (after the 'docker-compose ') to run. E.g.
 *    'up -d'.
 *   - user {Object} The user object passed to `getDockerEnv`'s callback.
 * @param callback {Function} `function (err, stdout, stderr)`
 */
function cliCompose(composeConfig, opts, callback) {
    assert.string(composeConfig, 'composeConfig');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');
    assert.object(opts.user, 'opts.user');
    assert.func(callback, 'callback');

    var user = opts.user;

    user.compose(composeConfig, opts.args, callback);
}

module.exports = cliCompose;