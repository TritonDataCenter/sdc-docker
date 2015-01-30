/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');



/**
 * POST /exec/:id/start
 *
 * The id on this path is the command id, not the container id
 */
function execStart(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    log.debug({req: req}, 'req');

    // Before a hijacked session we need to check if the command exists and
    // then we need to check if this was a detached command
    var socketData = req.app.sockets.getSocket('exec', id);
    if (!socketData) {
        finish(404);
        return;
    } else if (socketData.command.Detach) {
        finish(201);
        return;
    }

    function finish(statusCode) {
        res.send(statusCode);
        next(false);
    }

    /*
     * Node's default HTTP timeout is two minutes, and this getImageFileStream()
     * request can take longer than that to complete.  Set this connection's
     * timeout to an hour to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    // At this moment req.socket is already hijacked
    if (socketData.command.AttachStdin) {
        req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: '
            + 'application/vnd.docker.raw-stream\r\n\r\n');
    } else {
        req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: '
            + 'application/vnd.docker.raw-stream\r\n0\r\n');
    }

    req.backend.execStart({
        cmdId: id,
        app: req.app,
        log: log,
        socketData: socketData,
        socket: req.socket
    }, function (err) {
            if (err) {
                log.error({err: err}, 'backend.execStart error');
                next(err);
                return;
            }

            next(false);
        }
    );
}


/**
 * POST /exec/:id/resize
 */
function execResize(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    log.debug({req: req}, 'req');

    var socketData = req.app.sockets.getSocket('exec', id);
    if (!socketData || !socketData.socket) {
        next(restify.ResourceNotFoundError('no such exec instance'));
        return;
    } else if (!socketData.command.AttachStdin || !socketData.command.Tty) {
        req.log.info('Attempting to resize exec %s with no AttachStdin '
            + 'and no Tty', id);
        next();
        return;
    }

    req.backend.execResize({
        app: req.app,
        log: log,
        socketData: socketData,
        w: Number(req.query.w),
        h: Number(req.query.h)
    }, function () {
        res.send(200);
        next();
    });
}


/**
 * POST /exec/:id/json
 *
 * TODO how to get process info
 */
function execInspect(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    log.debug({req: req}, 'req');

    var socketData = req.app.sockets.getSocket('exec', id);
    if (!socketData) {
        next(restify.ResourceNotFoundError('no such exec instance'));
        return;
    }

    var running = (socketData.command.Detach ? true : false);
    req.app.sockets.removeSocket('exec', id);
    res.send({ Running: running, ExitCode: 0 });

    next();
}


/**
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.post({ path: '/:apiversion/exec/:id/start',
        name: 'ExecStart' }, before, execStart);
    http.post({ path: '/:apiversion/exec/:id/resize',
    	name: 'ExecResize' }, before, execResize);
    http.get({ path: '/:apiversion/exec/:id/json',
    	name: 'ExecInspect' }, before, execInspect);
}



module.exports = {
    register: register
};
