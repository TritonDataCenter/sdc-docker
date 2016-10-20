/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * socket-manager.js
 * XXX explanation
 */

var assert = require('assert-plus');

var SOCKET_TYPES = {
    'attach': true,
    'exec': true,
    'job': true
};

/*
 * This function manages the references for exec, attach and pull
 * sockets so they can be properly reused across different HTTP requests.
 */
function SocketManager(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    this.log = opts.log;
    this.sockets = {};

    // These are held by container attach/run operations
    // scoped by container id
    this.sockets.attach = {};

    // These client sockets are held by container exec operations. They
    // store the server socket connection info and a reference to the
    // client socket
    // scoped by exec id
    this.sockets.exec = {};

    // These are created by any call that results in a WFAPI job
    // and needs to report progress back to the docker client
    // scoped by id of whatever is being operated on
    this.sockets.job = {};

    // Holds a list of resize messages that get sent for a specific
    // container. When we want to attach to a container the docker
    // client will send a resize message before calling attach, so
    // we need to hold on to the resize data for a moment
    // scoped by container id
    this.resizes = {};
}


SocketManager.prototype.setSocket = function (type, id, data) {
    assert.ok(SOCKET_TYPES[type], 'socket type');
    assert.string(id, 'socket identifier');
    assert.object(data, 'socket data');

    this.sockets[type][id] = data;
    return data;
};


SocketManager.prototype.getSocket = function (type, id) {
    assert.ok(SOCKET_TYPES[type], 'socket type');
    assert.string(id, 'socket identifier');

    return this.sockets[type][id];
};


SocketManager.prototype.removeSocket = function (type, id) {
    assert.ok(SOCKET_TYPES[type], 'socket type');
    assert.string(id, 'socket identifier');

    delete this.sockets[type][id];
};


SocketManager.prototype.pushResize = function (id, resize) {
    assert.string(id, 'socket identifier');
    assert.object(resize, 'resize object');
    assert.finite(resize.w, 'resize columns');
    assert.finite(resize.h, 'resize rows');

    this.resizes[id] = resize;
    return resize;
};


SocketManager.prototype.popResize = function (id) {
    assert.string(id, 'socket identifier');

    var resize = this.resizes[id];
    delete this.resizes[id];
    return resize;
};


module.exports = SocketManager;
