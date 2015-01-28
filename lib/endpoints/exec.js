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
    var execCommand = req.app.execCommands[id];
    if (!execCommand) {
        finish(404);
        return;
    } else if (execCommand.command.Detach) {
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
    if (execCommand.command.AttachStdin) {
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
        payload: execCommand.command,
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

    var execCommand = req.app.execCommands[id];

    if (!execCommand || !execCommand.socket) {
        next(restify.ResourceNotFoundError('no such exec instance'));
        return;
    } else if (!execCommand.command.AttachStdin || !execCommand.command.Tty) {
        req.log.info('Attempting to resize exec %s with no AttachStdin '
            + 'and no Tty', id);
        next();
        return;
    }

    req.backend.execResize({
        app: req.app,
        log: log,
        socket: execCommand.socket,
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

    var execCommand = req.app.execCommands[id];
    if (!execCommand) {
        next(restify.ResourceNotFoundError('no such exec instance'));
        return;
    }

    delete req.app.execCommands[id];

    var running = (execCommand.command.Detach ? true : false);
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
