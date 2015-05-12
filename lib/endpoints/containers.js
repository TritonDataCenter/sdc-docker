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
var getContainerImage = common.getContainerImage;
var getImages = common.getImages;
var getVm = common.getVm;
var validate = require('../validate');



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

    options.all = common.boolFromQueryParam(req.query.all);
    // Note: options.all is implied when using these query params.
    if (req.query.hasOwnProperty('limit')
        || req.query.hasOwnProperty('filters')
        || req.query.hasOwnProperty('before')
        || req.query.hasOwnProperty('since'))
    {
        options.all = true;
    }

    options.limit = parseInt(req.query.limit || '0', 10);
    options.before = req.query.before;
    options.since = req.query.since;
    options.size = req.query.size;
    options.filters = req.query.filters;
    options.log = req.log;
    options.req_id = req.getId();
    options.app = req.app;
    options.account = req.account;
    options.images = req.images;
    options.apiversion = req.params.apiversion;

    if (options.apiversion && options.apiversion.match(/^v[0-9\.]+$/)) {
        options.apiversion = Number(options.apiversion.slice(1));
    } else {
        options.apiversion = common.SERVER_VERSION;
    }

    req.backend.getContainers(options, function (err, containers) {
        if (err) {
            if (!(err instanceof errors.DockerError)) {
                log.error({err: err}, 'Problem loading containers');
                err = new errors.DockerError(err, 'problem loading containers');
            }
            next(err);
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

    /*
     * Node's default HTTP timeout is two minutes, and this request can
     * take longer than that to complete.  Set this connection's
     * timeout to an hour to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    var create_opts = {
        account: req.account,
        app: req.app,
        image: req.image,
        log: log,
        name: req.query.name,
        payload: req.body,
        req_id: req.getId()
    };

    if (!create_opts.name) {
        create_opts.name = generateContainerName();
    }

    req.backend.createContainer(create_opts, function (err, container) {
        if (err) {
            if (err.code === 'EMISSINGIMAGE') {
                next(new restify.ResourceNotFoundError(err, 'image not found'));
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
    var options = {
        account: req.account,
        app: req.app,
        id: id,
        images: req.images,
        log: log,
        req_id: req.getId(),
        vm: req.vm
    };

    options.apiversion = req.params.apiversion;
    if (options.apiversion && options.apiversion.match(/^v[0-9\.]+$/)) {
        options.apiversion = Number(options.apiversion.slice(1));
    } else {
        options.apiversion = common.SERVER_VERSION;
    }

    req.log.debug({req: req}, 'req');

    req.backend.inspectContainer(options, function (err, container) {
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
        account: req.account,
        app: req.app,
        fields: req.query.fields,
        id: id,
        log: log,
        ps_args: req.query.ps_args,
        req_id: req.getId(),
        vm: req.vm
    }, function (err, psdata) {
        if (err) {
            log.error({err: err}, 'backend.psContainer failed.');
            next(err);
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
        account: req.account,
        app: req.app,
        log: log,
        payload: payload,
        req_id: req.getId(),
        socket: req.socket,
        vm: req.vm
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
    var log = req.log;

    req.log.debug({req: req}, 'req');

    req.backend.startContainer({
        account: req.account,
        app: req.app,
        log: log,
        req_id: req.getId(),
        vm: req.vm
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
    var log = req.log;
    var t = req.query.t;

    // default in docker daemon is 10s
    if (isNaN(t)) {
        t = 10;
    }

    req.backend.stopContainer({
        account: req.account,
        app: req.app,
        log: log,
        req_id: req.getId(),
        timeout: t,
        vm: req.vm
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
    var log = req.log;
    var t = req.query.t;

    // default in docker daemon is 10s
    if (isNaN(t)) {
        t = 10;
    }

    req.backend.restartContainer({
        account: req.account,
        app: req.app,
        log: log,
        req_id: req.getId(),
        timeout: t,
        vm: req.vm
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
    var log = req.log;
    var signal = req.query.signal;

    req.backend.killContainer({
        account: req.account,
        app: req.app,
        log: log,
        req_id: req.getId(),
        signal: signal,
        vm: req.vm
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
    var log = req.log;
    var force = common.boolFromQueryParam(req.query.force);
    var link = common.boolFromQueryParam(req.query.link);

    req.backend.deleteContainer({
        account: req.account,
        app: req.app,
        force: force,
        link: link,
        log: log,
        req_id: req.getId(),
        vm: req.vm
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
 * DELETE /containers/:id/:link
 */
function linkDelete(req, res, next) {
    var link = req.params.link;
    var log = req.log;

    req.backend.deleteLink({
        app: req.app,
        link: link,
        log: log,
        vm: req.vm
    }, function (err) {
        if (err) {
            log.error({err: err}, 'backend.deleteLink failed.');
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
    if (req.vm.internal_metadata['docker:tty']) {
        payload.Tty = true;
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
        account: req.account,
        app: req.app,
        id: id,
        log: log,
        payload: payload,
        req_id: req.getId(),
        socket: req.socket,
        vm: req.vm
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
    var log = req.log;

    req.backend.waitContainer({
        account: req.account,
        app: req.app,
        log: log,
        req_id: req.getId(),
        vm: req.vm
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
    var log = req.log;

    req.log.debug({req: req}, 'req');

    var opts = {
        account: req.account,
        app: req.app,
        log: log,
        payload: req.params,
        req_id: req.getId(),
        vm: req.vm
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
        account: req.account,
        app: req.app,
        id: id,
        log: log,
        payload: req.body,
        req_id: req.getId(),
        vm: req.vm
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
    var name = req.query.name;

    log.debug({req: req}, 'req');

    req.backend.renameContainer({
        account: req.account,
        app: req.app,
        log: log,
        name: name,
        req_id: req.getId(),
        vm: req.vm
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
        name: 'ContainerList' }, before, getImages, containerList);
    // TODO(trent): getImages really necessary for ContainerCreate?
    http.post({ path: '/:apiversion/containers/create',
        name: 'ContainerCreate' }, before, validate.createContainer,
        common.checkApprovedForProvisioning, getImages, getContainerImage,
        containerCreate);
    // TODO(trent) The *full* getImages is overkill for a single container.
    http.get({ path: '/:apiversion/containers/:id/json',
        name: 'ContainerInspect' }, before, getVm, getImages, containerInspect);
    http.get({ path: '/:apiversion/containers/:id/top',
        name: 'ContainerTop' }, before, getVm, containerTop);
    http.get({ path: '/:apiversion/containers/:id/logs',
        name: 'ContainerLogs' }, before, getVm, containerLogs);
    http.get({ path: '/:apiversion/containers/:id/changes',
        name: 'ContainerChanges' }, before, containerChanges);
    http.get({ path: '/:apiversion/containers/:id/export',
        name: 'ContainerExport' }, before, containerExport);
    http.post({ path: '/:apiversion/containers/:id/resize',
        name: 'ContainerResize' }, before, getVm, containerResize);
    http.post({ path: '/:apiversion/containers/:id/start',
        name: 'ContainerStart' }, before, getVm, containerStart);
    http.post({ path: '/:apiversion/containers/:id/stop',
        name: 'ContainerStop' }, before, getVm, containerStop);
    http.post({ path: '/:apiversion/containers/:id/restart',
        name: 'ContainerRestart' }, before, getVm, containerRestart);
    http.post({ path: '/:apiversion/containers/:id/kill',
        name: 'ContainerKill' }, before, getVm, containerKill);
    http.post({ path: '/:apiversion/containers/:id/pause',
        name: 'ContainerPause' }, before, containerPause);
    http.post({ path: '/:apiversion/containers/:id/unpause',
        name: 'ContainerUnPause' }, before, containerUnPause);
    http.post({ path: '/:apiversion/containers/:id/attach',
        name: 'ContainerAttach' }, before, getVm, containerAttach);
    http.post({ path: '/:apiversion/containers/:id/wait',
        name: 'ContainerWait' }, before, getVm, containerWait);
    http.del({ path: '/:apiversion/containers/:id',
        name: 'ContainerDelete' }, before, getVm, containerDelete);
    http.del({ path: '/:apiversion/containers/:id/:link',
        name: 'LinkDelete' }, before, getVm, linkDelete);
    http.post({ path: '/:apiversion/containers/:id/copy',
        name: 'ContainerCopy' }, before, getVm, containerCopy);
    http.post({ path: '/:apiversion/containers/:id/exec',
        name: 'ContainerExec' }, before, getVm, containerExec);
    http.post({ path: '/:apiversion/containers/:id/rename',
        name: 'ContainerRename' }, before, getVm, containerRename);
}

module.exports = {
    register: register
};
