/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var restify = require('restify');

function generateContainerName()
{
    /* JSSTYLED */
    // This is the same as from https://github.com/docker/docker/blob/290222c3ddbdfb871f7fa088b8c724b9970a75ba/pkg/namesgenerator/names-generator.go

    var left = ['happy', 'jolly', 'dreamy', 'sad', 'angry', 'pensive',
        'focused', 'sleepy', 'grave', 'distracted', 'determined', 'stoic',
        'stupefied', 'sharp', 'agitated', 'cocky', 'tender', 'goofy', 'furious',
        'desperate', 'hopeful', 'compassionate', 'silly', 'lonely',
        'condescending', 'naughty', 'kickass', 'drunk', 'boring', 'nostalgic',
        'ecstatic', 'insane', 'cranky', 'mad', 'jovial', 'sick', 'hungry',
        'thirsty', 'elegant', 'backstabbing', 'clever', 'trusting', 'loving',
        'suspicious', 'berserk', 'high', 'romantic', 'prickly', 'evil',
        'admiring', 'adoring', 'reverent', 'serene', 'fervent', 'modest',
        'gloomy', 'elated'];
    var invalid = ['boring_wozniak'];
    var right = ['albattani', 'almeida', 'archimedes', 'ardinghelli', 'babbage',
        'bardeen', 'bartik', 'bell', 'blackwell', 'bohr', 'brattain', 'brown',
        'carson', 'colden', 'cori', 'curie', 'darwin', 'davinci', 'einstein',
        'elion', 'engelbart', 'euclid', 'fermat', 'fermi', 'feynman',
        'franklin', 'galileo', 'goldstine', 'goodall', 'hawking', 'heisenberg',
        'hodgkin', 'hoover', 'hopper', 'hypatia', 'jones', 'kirch',
        'kowalevski', 'lalande', 'leakey', 'lovelace', 'lumiere', 'mayer',
        'mccarthy', 'mcclintock', 'mclean', 'meitner', 'mestorf', 'morse',
        'newton', 'nobel', 'pare', 'pasteur', 'perlman', 'pike', 'poincare',
        'ptolemy', 'ritchie', 'rosalind', 'sammet', 'shockley', 'sinoussi',
        'stallman', 'tesla', 'thompson', 'torvalds', 'turing', 'wilson',
        'wozniak', 'wright', 'yalow', 'yonath'];
    var name;

    while (!name || (invalid.indexOf(name) !== -1)) {
        name = left[Math.floor(Math.random() * left.length)]
            + '_' + right[Math.floor(Math.random() * right.length)];
    }

    return (name);
}

/**
 * GET /containers/json
 */
function containerList(req, res, next) {
    var log = req.log;
    var options = {};

    if (['1', 'True', 'true'].indexOf(req.query.all) != -1) {
        options.all = true;
    }
    options.log = req.log;
    options.req_id = req.getId();
    options.app = req.app;

    req.backend.getContainers(options, function (err, containers) {

        log.debug({query: req.query}, 'got query');

        if (err) {
            log.error({err: err}, 'Problem loading containers');
            next(new restify.InternalError('Problem loading containers'));
            return;
        }

        res.send(containers);
        next();
    });
}


/**
 * POST /containers/create
 */
function containerCreate(req, res, next) {
    var log = req.log;

    var create_opts = {
        app: req.app,
        log: log,
        name: req.query.name,
        payload: req.body,
        req_id: req.getId()
    };

    if (!create_opts.name) {
        create_opts.name = generateContainerName();
    }

    req.backend.createContainer(create_opts, function (err, container) {
        //var response = {};

        if (err) {
            if (err.code === 'EMISSINGIMAGE') {
                res.send(404);
                next();
                return;
            }
            log.error({container: container, err: err},
                'createContainer error');
            next(err);
            return;
        }

        res.send({
            Id: container.DockerId,
            Warnings: [] // XXX
        });
        next();
    });
}


/**
 * GET /containers/:id/json
 */
function containerInspect(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.backend.inspectContainer({
        app: req.app,
        id: id,
        log: log,
        req_id: req.getId()
    }, function (err, container) {

        if (err) {
            log.error({err: err}, 'backend.inspectContainer failed.');
            next(new restify.InternalError('Problem inspecting container: '
                + err.message));
            return;
        }

        res.send(container);
        next();
    });
}


/**
 * GET /containers/:id/top
 */
function containerTop(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    req.backend.psContainer({
        id: id,
        log: log,
        fields: req.query.fields,
        ps_args: req.query.ps_args,
        req_id: req.getId()
    }, function (err, psdata) {
        if (err) {
            log.error({err: err}, 'backend.psContainer failed.');
            next(new restify.InternalError('Problem inspecting container '
                + 'processes: ' + err.message));
            return;
        }

        res.send(psdata);
        next();
    });
}


/**
 * GET /containers/:id/logs
 */
function containerLogs(req, res, next) {
    // pass in req_id: req.getId()
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/changes
 */
function containerChanges(req, res, next) {
    // pass in req_id: req.getId()
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/export
 */
function containerExport(req, res, next) {
    // pass in req_id: req.getId()
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * GET /containers/:id/resize
 */
function containerResize(req, res, next) {
    // pass in req_id: req.getId()
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/start
 */
function containerStart(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.backend.startContainer({
        id: id,
        log: log,
        req_id: req.getId()
    }, function (err) {

        if (err) {
            log.error({err: err}, 'backend.startContainer failed.');
            next(new restify.InternalError('Problem starting container: '
                + err.message));
            return;
        }

        res.send(204);
        next();
    });
}


/**
 * POST /containers/:id/stop
 */
function containerStop(req, res, next) {
    var id = req.params.id;
    var log = req.log;
    var t = req.query.t;

    // default in docker daemon is 10s
    if (isNaN(t)) {
        t = 10;
    }

    req.backend.stopContainer({
        id: id,
        timeout: t,
        log: log,
        req_id: req.getId()
    }, function (err) {
        if (err) {
            log.error({err: err}, 'backend.stopContainer failed.');
            next(new restify.InternalError('Problem stopping container: '
                + err.message));
            return;
        }

        res.send(204);
        next();
    });
}


/**
 * POST /containers/:id/restart
 */
function containerRestart(req, res, next) {
    var id = req.params.id;
    var log = req.log;
    var t = req.query.t;

    // default in docker daemon is 10s
    if (isNaN(t)) {
        t = 10;
    }

    req.backend.restartContainer({
        id: id,
        timeout: t,
        log: log,
        req_id: req.getId()
    }, function (err) {
        if (err) {
            log.error({err: err}, 'backend.restartContainer failed.');
            next(new restify.InternalError('Problem restarting container: '
                + err.message));
            return;
        }

        res.send(204);
        next();
    });
}


/**
 * POST /containers/:id/kill
 */
function containerKill(req, res, next) {
    var id = req.params.id;
    var log = req.log;
    var signal = req.query.signal;

    req.backend.killContainer({
        id: id,
        signal: signal,
        log: log,
        req_id: req.getId()
    }, function (err) {
        if (err) {
            log.error({err: err}, 'backend.killContainer failed.');
            next(new restify.InternalError('Problem sending signal to '
                + 'container: ' + err.message));
            return;
        }

        res.send(204);
        next();
    });
}


/**
 * DELETE /containers/:id
 */
function containerDelete(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    req.backend.deleteContainer({
        id: id,
        log: log,
        req_id: req.getId()
    }, function (err) {
        if (err) {
            log.error({err: err}, 'backend.deleteContainer failed.');
            next(new restify.InternalError(
                'Problem deleting container: ' + err.message));
            return;
        }

        res.send(204);
        next();
    });
}


/**
 * POST /containers/:id/pause
 */
function containerPause(req, res, next) {
    // pass in req_id: req.getId()
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/unpause
 */
function containerUnPause(req, res, next) {
    // pass in req_id: req.getId()
    return next(new restify.InvalidVersionError('Not implemented'));
}


/**
 * POST /containers/:id/attach
 *
 * Assume stream=1 for now
 */
function containerAttach(req, res, next) {
    var id = req.params.id;
    var log = req.log;
    var payload = {
        Container: id,
        AttachConsole: true,
        Cmd: ['AttachConsole'] // To fix in cn-agent
    };

    if (req.query.stdout) {
        payload.AttachStdout = true;
    }
    if (req.query.stderr) {
        payload.AttachStderr = true;
    }
    if (req.query.stdin) {
        payload.AttachStdin = true;
    }

    req.log.debug({req: req}, 'req');

    // TODO need a before handler to check existence of containers on
    // container based routes
    if (payload.AttachStdin) {
        req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: '
            + 'application/vnd.docker.raw-stream\r\n\r\n');
    } else {
        req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: '
            + 'application/vnd.docker.raw-stream\r\n0\r\n');
    }

    req.backend.attachContainer({
        id: id,
        payload: payload,
        log: log,
        req_id: req.getId(),
        app: req.app,
        socket: req.socket
    }, function (err) {
            if (err) {
                log.error({err: err}, 'backend.attachContainer error');
                next(err);
                return;
            }

            next(false);
        }
    );
}


/**
 * POST /containers/:id/wait
 */
function containerWait(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    req.backend.waitContainer({
        id: id,
        log: log,
        req_id: req.getId()
    }, function (err, statusCode) {
        if (err) {
            log.error({err: err}, 'backend.waitContainer failed.');
            next(new restify.InternalError(
                'Problem waiting for container to stop: ' + err.message));
            return;
        }

        res.send({ StatusCode: statusCode });
        next();
    });
}


/**
 * POST /containers/:id/copy
 */
function containerCopy(req, res, next) {
    // pass in req_id: req.getId()
    var id = req.params.id;
    var log = req.log;

    req.log.debug({req: req}, 'req');
    var opts = {
        id: id,
        payload: req.params,
        log: log,
        req_id: req.getId(),
        app: req.app
    };

    req.backend.copyContainer(opts, function (err, copySocket) {
        if (err) {
            log.error({err: err}, 'backend.execContainer error');
            next(err);
            return;
        }

        copySocket.on('connect', function () {
            res.setHeader('content-type', 'application/tar');
            copySocket.pipe(res);

            req.on('end', function () {
                res.end(200);
            });

            copySocket.on('error', function (error) {
                opts.log.debug(
                    'copySocket for %s threw an error %', error.toString());

                res.send(500);
                next();
            });

            copySocket.on('close', function (had_error) {
                opts.log.debug('copySocket closed, had_error=%s', had_error);
                next();
            });

            copySocket.on('end', function () {
                opts.log.debug('copySocket end');
                next();
            });
        });


    });
}


/**
 * POST /containers/:id/exec
 */
function containerExec(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.backend.execContainer({
        id: id,
        payload: req.body,
        log: log,
        req_id: req.getId(),
        app: req.app
    }, function (err, cmdId) {
            if (err) {
                log.error({err: err}, 'backend.execContainer error');
                next(err);
                return;
            }

            res.send({ Id: cmdId });
            next();
        }
    );
}


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
            // Cleanup regardless of the error
            delete req.app.execCommands[id];

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
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/v1.15/containers/json', name: 'ContainerList' },
        before, containerList);
    http.post({ path: '/v1.15/containers/create', name: 'ContainerCreate' },
        before, containerCreate);
    http.get({ path: '/v1.15/containers/:id/json', name: 'ContainerInspect' },
        before, containerInspect);
    http.get({ path: '/v1.15/containers/:id/top', name: 'ContainerTop' },
        before, containerTop);
    http.get({ path: '/containers/:id/logs', name: 'ContainerLogs' },
        before, containerLogs);
    http.get({ path: '/containers/:id/changes', name: 'ContainerChanges' },
        before, containerChanges);
    http.get({ path: '/containers/:id/export', name: 'ContainerExport' },
        before, containerExport);
    http.get({ path: '/containers/:id/resize', name: 'ContainerResize' },
        before, containerResize);
    http.post({ path: '/v1.15/containers/:id/start', name: 'ContainerStart' },
        before, containerStart);
    http.post({ path: '/v1.15/containers/:id/stop', name: 'ContainerStop' },
        before, containerStop);
    http.post({ path: '/v1.15/containers/:id/restart',
        name: 'ContainerRestart' }, before, containerRestart);
    http.post({ path: '/v1.15/containers/:id/kill', name: 'ContainerKill' },
        before, containerKill);
    http.post({ path: '/containers/:id/pause', name: 'ContainerPause' },
        before, containerPause);
    http.post({ path: '/containers/:id/unpause', name: 'ContainerUnPause' },
        before, containerUnPause);
    http.post({ path: '/v1.15/containers/:id/attach', name: 'ContainerAttach' },
        before, containerAttach);
    http.post({ path: '/v1.15/containers/:id/wait', name: 'ContainerWait' },
        before, containerWait);
    http.del({ path: '/v1.15/containers/:id', name: 'ContainerDelete' },
        before, containerDelete);
    http.post({ path: '/v1.15/containers/:id/copy', name: 'ContainerCopy' },
        before, containerCopy);
    http.post({ path: '/v1.15/containers/:id/exec', name: 'ContainerExec' },
        before, containerExec);
    http.post({ path: '/v1.15/exec/:id/start', name: 'ExecStart' },
        before, execStart);
}

module.exports = {
    register: register
};
