/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var errors = require('./errors');

function ConnectionStatusWatcher(opts) {
    this.connections = {};
    this.app = opts.app;
    this.log = this.app.log;
}

ConnectionStatusWatcher.prototype.register = function register(opts) {
    var self = this;

    assert.string(opts.name, 'opts.name');
    assert.func(opts.init, 'opts.init');
    assert.optionalFunc(opts.isAvaiable, 'opts.init');

    opts.init(function (err, connection) {
        self.connections[opts.name] = {
            connection: connection,
            available: false
        };

        if (opts.isAvailable) {
            self.connections[opts.name].isAvailable = opts.isAvailable;
        }

        self.app[opts.name] = connection;
    });

    if (opts.pingIntervalSecs) {
        ping();
    }

    function ping() {
        schedulePing();
        opts.ping(self.connections[opts.name].connection, function (err) {
            if (err) {
                self.log.error({ err: err }, 'error pinging %s', opts.name);
                self.connections[opts.name].available = false;
                return;
            }

            if (!self.connections[opts.name].available) {
                self.log.error({ err: err },
                    '%s appears to have recovered and is responding to '
                    + 'pings without error', opts.name);
            }

            self.connections[opts.name].available = true;
            return;
        });
    }

    function schedulePing() {
        self.connections[opts.name].interval = setTimeout(function () {
            ping();
        }, opts.pingIntervalSecs * 1000);
    }
};


ConnectionStatusWatcher.prototype.checkAvailability =
function checkAvailability(names, callback) {
    var self = this;

    if (!callback) {
        callback = names;
        names = null;
    }

    if (!names) {
        names = Object.keys(self.connections);
    }

    var notAvailable = names.filter(function (name) {
        if (self.connections[name].hasOwnProperty('isAvailable')) {
            return !self.connections[name].isAvailable(
                self.connections[name].connection);
        } else {
            return !self.connections[name].available;
        }
    });

    if (notAvailable.length) {
        callback(new errors.ServiceDegradedError(
            new Error('connection(s) to ' + notAvailable.join(', ')
            + ' not available')));
        return;
    }

    callback();
};


module.exports = ConnectionStatusWatcher;
