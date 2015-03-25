/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var restify = require('restify');

var common = require('../common');
var errors = require('../errors');



// ---- internal support stuff

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



// ---- endpoint handlers

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
    options.account = req.account;

    req.backend.getContainers(options, function (err, containers) {
        if (err) {
            log.error({err: err}, 'Problem loading containers');
            next(new errors.DockerError(err, 'problem loading containers'));
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
        req_id: req.getId(),
        account: req.account
    };

    if (!create_opts.name) {
        create_opts.name = generateContainerName();
    }

    req.backend.createContainer(create_opts, function (err, container) {
        //var response = {};

        if (err) {
            if (err.code === 'EMISSINGIMAGE') {
                res.send(new restify.ResourceNotFoundError(
                    err, 'image not found'));
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
        req_id: req.getId(),
        account: req.account
    }, function (err, container) {

        if (err) {
            log.error({err: err}, 'backend.inspectContainer failed.');
            next(new errors.DockerError(err, 'problem inspecting container'));
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
        req_id: req.getId(),
        account: req.account
    }, function (err, psdata) {
        if (err) {
            log.error({err: err}, 'backend.psContainer failed.');
            next(new errors.DockerError(err, 'problem inspecting container'));
            return;
        }

        res.send(psdata);
        next();
    });
}


/**
 * GET /containers/:id/logs
 *
 * // JSSTYLED
 * http://docs.docker.com/reference/api/docker_remote_api_v1.17/#get-container-logs
 */
function containerLogs(req, res, next) {
    var id = req.params.id;
    var log = req.log;
    var payload = {
        Container: id,
        Logs: true,
        Tail: 'all',
        Cmd: ['Logs'],
        Follow: common.boolFromQueryParam(req.query.follow),
        Timestamps: common.boolFromQueryParam(req.query.timestamps)
    };

    if (req.query.tail !== 'all') {
        // TODO: should error on NaN
        payload.Tail = Number(req.query.tail);
    }

    req.log.debug({req: req}, 'req');

    /*
     * Node's default HTTP timeout is two minutes, and this getImageFileStream()
     * request can take longer than that to complete.  Set this connection's
     * timeout to an hour to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: '
        + 'application/vnd.docker.raw-stream\r\n\r\n');

    req.backend.containerLogs({
        id: id,
        payload: payload,
        log: log,
        req_id: req.getId(),
        app: req.app,
        account: req.account,
        socket: req.socket
    }, function (err) {
            if (err) {
                log.error({err: err}, 'backend.containerLogs error');
                next(err);
                return;
            }

            next(false);
        }
    );
}


/**
 * GET /containers/:id/changes
 */
function containerChanges(req, res, next) {
    // pass in req_id: req.getId()
    return next(new errors.NotImplementedError('changes'));
}


/**
 * GET /containers/:id/export
 */
function containerExport(req, res, next) {
    // pass in req_id: req.getId()
    return next(new errors.NotImplementedError('export'));
}


/**
 * POST /containers/:id/resize
 */
function containerResize(req, res, next) {
    var id = req.params.id;
    var log = req.log;

    log.debug({req: req}, 'req');

    req.backend.resizeContainer({
        app: req.app,
        id: id,
        log: log,
        req_id: req.getId(),
        account: req.account,
        w: Number(req.query.w),
        h: Number(req.query.h)
    }, function (err) {
        if (err) {
            next(err);
            return;
        }

        res.send(200);
        next();
    });
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
        req_id: req.getId(),
        account: req.account
    }, function (err) {

        if (err) {
            log.error({err: err}, 'backend.startContainer failed.');
            next(new errors.DockerError(err, 'problem starting container'));
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
        req_id: req.getId(),
        account: req.account
    }, function (err) {
        if (err) {
            log.error({err: err}, 'backend.stopContainer failed.');
            next(new errors.DockerError(err, 'problem stopping container'));
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
        req_id: req.getId(),
        account: req.account
    }, function (err) {
        if (err) {
            log.error({err: err}, 'backend.restartContainer failed.');
            next(new errors.DockerError(err, 'problem restarting container'));
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
        req_id: req.getId(),
        account: req.account
    }, function (err) {
        if (err) {
            log.error({err: err, signal: signal},
                'backend.killContainer failed.');
            next(new errors.DockerError(
                err, 'problem sending signal to container'));
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
    var force = common.boolFromQueryParam(req.query.force);

    req.backend.deleteContainer({
        force: force,
        id: id,
        log: log,
        req_id: req.getId(),
        account: req.account
    }, function (err) {
        if (err) {
            log.error({err: err}, 'backend.deleteContainer failed.');
            next(err);
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
    return next(new errors.NotImplementedError('pause'));
}


/**
 * POST /containers/:id/unpause
 */
function containerUnPause(req, res, next) {
    // pass in req_id: req.getId()
    return next(new errors.NotImplementedError('unpause'));
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

    /*
     * Node's default HTTP timeout is two minutes, and this getImageFileStream()
     * request can take longer than that to complete.  Set this connection's
     * timeout to an hour to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: '
        + 'application/vnd.docker.raw-stream\r\n\r\n');

    req.backend.attachContainer({
        id: id,
        payload: payload,
        log: log,
        req_id: req.getId(),
        app: req.app,
        account: req.account,
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
        req_id: req.getId(),
        account: req.account
    }, function (err, statusCode) {
        if (err) {
            log.error({err: err}, 'backend.waitContainer failed.');
            next(new errors.DockerError(
                err, 'problem waiting for container to stop'));
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
        account: req.account,
        app: req.app
    };

    req.backend.copyContainer(opts, function (err, copySocket) {
        if (err) {
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

                res.send(new error.DockerError(
                    error, 'problem copying from container'));
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
        account: req.account,
        app: req.app
    }, function (err, cmdId, socketData) {
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
 * POST /containers/:id/rename?name=
 */
function containerRename(req, res, next) {
    var log = req.log;

    log.debug({req: req}, 'req');

    var id = req.params.id;
    var name = req.query.name;

    req.backend.renameContainer({
        id: id,
        name: name,
        log: log,
        req_id: req.getId(),
        account: req.account,
        app: req.app
    }, function (err, cmdId, socketData) {
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
 * Register all endpoints with the restify server
 */
function register(http, before) {
    http.get({ path: '/:apiversion/containers/json',
        name: 'ContainerList' }, before, containerList);
    http.post({ path: '/:apiversion/containers/create',
        name: 'ContainerCreate' }, before, containerCreate);
    http.get({ path: '/:apiversion/containers/:id/json',
        name: 'ContainerInspect' }, before, containerInspect);
    http.get({ path: '/:apiversion/containers/:id/top',
        name: 'ContainerTop' }, before, containerTop);
    http.get({ path: '/:apiversion/containers/:id/logs',
        name: 'ContainerLogs' }, before, containerLogs);
    http.get({ path: '/:apiversion/containers/:id/changes',
        name: 'ContainerChanges' }, before, containerChanges);
    http.get({ path: '/:apiversion/containers/:id/export',
        name: 'ContainerExport' }, before, containerExport);
    http.post({ path: '/:apiversion/containers/:id/resize',
        name: 'ContainerResize' }, before, containerResize);
    http.post({ path: '/:apiversion/containers/:id/start',
        name: 'ContainerStart' }, before, containerStart);
    http.post({ path: '/:apiversion/containers/:id/stop',
        name: 'ContainerStop' }, before, containerStop);
    http.post({ path: '/:apiversion/containers/:id/restart',
        name: 'ContainerRestart' }, before, containerRestart);
    http.post({ path: '/:apiversion/containers/:id/kill',
        name: 'ContainerKill' }, before, containerKill);
    http.post({ path: '/:apiversion/containers/:id/pause',
        name: 'ContainerPause' }, before, containerPause);
    http.post({ path: '/:apiversion/containers/:id/unpause',
        name: 'ContainerUnPause' }, before, containerUnPause);
    http.post({ path: '/:apiversion/containers/:id/attach',
        name: 'ContainerAttach' }, before, containerAttach);
    http.post({ path: '/:apiversion/containers/:id/wait',
        name: 'ContainerWait' }, before, containerWait);
    http.del({ path: '/:apiversion/containers/:id',
        name: 'ContainerDelete' }, before, containerDelete);
    http.post({ path: '/:apiversion/containers/:id/copy',
        name: 'ContainerCopy' }, before, containerCopy);
    http.post({ path: '/:apiversion/containers/:id/exec',
        name: 'ContainerExec' }, before, containerExec);
    http.post({ path: '/:apiversion/containers/:id/rename',
        name: 'ContainerRename' }, before, containerRename);
}

module.exports = {
    register: register
};
