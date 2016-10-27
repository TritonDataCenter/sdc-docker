/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var restify = require('restify');
var util = require('util');

var common = require('../common');
var errors = require('../errors');
var getImages = common.getImages;
var getVm = common.getVm;
var validate = require('../validate');



// ---- internal support stuff

function generateContainerName()
{
    /* JSSTYLED */
    // This is the same as from https://github.com/docker/docker/blob/290222c3ddbdfb871f7fa088b8c724b9970a75ba/pkg/namesgenerator/names-generator.go

    var left = [
        'admiring', 'adoring', 'agitated', 'amazing', 'angry', 'awesome',
        'backstabbing', 'berserk', 'big', 'boring', 'clever', 'cocky',
        'compassionate', 'condescending', 'cranky', 'desperate', 'determined',
        'distracted', 'dreamy', 'drunk', 'ecstatic', 'elated', 'elegant',
        'evil', 'fervent', 'focused', 'furious', 'gigantic', 'gloomy', 'goofy',
        'grave', 'happy', 'high', 'hopeful', 'hungry', 'insane', 'jolly',
        'jovial', 'kickass', 'lonely', 'loving', 'mad', 'modest', 'naughty',
        'nauseous', 'nostalgic', 'pedantic', 'pensive', 'prickly', 'reverent',
        'romantic', 'sad', 'serene', 'sharp', 'sick', 'silly', 'sleepy',
        'small', 'stoic', 'stupefied', 'suspicious', 'tender', 'thirsty',
        'tiny', 'trusting'
    ];
    var invalid = ['boring_wozniak'];
    var right = [
        'albattani', 'allen', 'almeida', 'archimedes', 'ardinghelli',
        'aryabhata', 'austin', 'babbage', 'banach', 'bardeen', 'bartik',
        'bassi', 'bell', 'bhabha', 'bhaskara', 'blackwell', 'bohr', 'booth',
        'borg', 'bose', 'boyd', 'brahmagupta', 'brattain', 'brown', 'carson',
        'chandrasekhar', 'colden', 'cori', 'cray', 'curie', 'darwin', 'davinci',
        'dijkstra', 'dubinsky', 'easley', 'einstein', 'elion', 'engelbart',
        'euclid', 'euler', 'fermat', 'fermi', 'feynman', 'franklin', 'galileo',
        'gates', 'goldberg', 'goldstine', 'golick', 'goodall', 'hamilton',
        'hawking', 'heisenberg', 'heyrovsky', 'hodgkin', 'hoover', 'hopper',
        'hugle', 'hypatia', 'jang', 'jennings', 'jepsen', 'joliot', 'jones',
        'kalam', 'kare', 'keller', 'khorana', 'kilby', 'kirch', 'knuth',
        'kowalevski', 'lalande', 'lamarr', 'leakey', 'leavitt', 'lichterman',
        'liskov', 'lovelace', 'lumiere', 'mahavira', 'mayer', 'mccarthy',
        'mcclintock', 'mcilroy', 'mclean', 'mcnulty', 'meitner', 'meninsky',
        'mestorf', 'mirzakhani', 'morse', 'newton', 'nobel', 'noether',
        'northcutt', 'noyce', 'panini', 'pare', 'pasteur', 'payne', 'perlman',
        'pike', 'poincare', 'poitras', 'ptolemy', 'raman', 'ramanujan',
        'ride', 'ritchie', 'roentgen', 'rosalind', 'saha', 'sammet', 'shaw',
        'shockley', 'sinoussi', 'snyder', 'spence', 'stallman', 'swanson',
        'swartz', 'swirles', 'tesla', 'thompson', 'torvalds', 'turing',
        'varahamihira', 'visvesvaraya', 'wescoff', 'williams', 'wilson',
        'wing', 'wozniak', 'wright', 'yalow', 'yonath'
    ];
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
    options.clientApiVersion = req.clientApiVersion;

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
        req_id: req.getId(),
        clientApiVersion: req.clientApiVersion
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
        clientApiVersion: req.clientApiVersion,
        id: id,
        images: req.images,
        log: log,
        req_id: req.getId(),
        vm: req.vm
    };

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
 * GET /containers/:id/stats
 */
function containerStats(req, res, next) {
    var log = req.log;
    var payload = {
        clientApiVersion: req.clientApiVersion,
        doStream: common.boolFromQueryParam(req.query.stream)
    };

    req.log.debug({req: req}, 'req');

    /*
     * Node's default HTTP timeout is two minutes, and this getImageFileStream()
     * request can take longer than that to complete.  Set this connection's
     * timeout to an hour to avoid an abrupt close after two minutes.
     */
    req.connection.setTimeout(60 * 60 * 1000);

    req.backend.containerStats({
        account: req.account,
        app: req.app,
        log: log,
        payload: payload,
        req_id: req.getId(),
        socket: req.socket,
        vm: req.vm
    }, function (err, statsSocket) {
            if (err) {
                log.error({err: err}, 'backend.containerStats error');
                next(err);
                return;
            }

            // Close the statsSocket when the response socket is ended.
            res.socket.on('end', function () {
                log.debug('containerStats got res.end - closing stats socket');
                statsSocket.destroy();
            });

            log.debug('containerStats piping stats socket to the res');
            statsSocket.pipe(res);
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
 * POST /containers/:id/stop[?t=:timeout]
 */
function containerStop(req, res, next) {
    var log = req.log;
    var t;
    var tErr;

    assert.object(req, 'req');
    assert.object(req.query, 'req.query');
    assert.object(res, 'res');
    assert.func(next, 'next');

    if (req.query.hasOwnProperty('t')) {
        t = Number(req.query.t);
        if (isNaN(t) || (req.query.t && req.query.t.length === 0)) {
            tErr = new errors.ValidationError('stop timeout parameter must be '
                + 'an integer');
            log.error({err: tErr, t: t}, 'timeout parameter is not an integer');
            next(tErr);
            return;
        }
    } else {
        t = 10;
    }

    // Docker allows negative values and so will we. In case of negative,
    // it assumes we should wait forever.
    t = Math.floor(t);

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
        id: req.params.id,
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

    req.socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: '
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
        cnapi: req.app.cnapi,
        log: log,
        payload: { path: req.params.Resource },
        req_id: req.getId(),
        res: res,
        req: req,
        vm: req.vm
    };

    req.backend.copyContainer(opts, function (err, copySocket) {
        if (err) {
            if (err.statusCode === 404) {
                // Unwrap the error, `docker cp` < 1.8.0 treats a 404 as a
                // "container not found" error
                return next(new errors.DockerError('file not found'));
            } else {
                return next(
                    new errors.DockerError(err, 'problem copying file'));
            }
        }

        copySocket.on('connect', function () {
            res.setHeader('content-type', 'application/tar');

            var error;

            copySocket.on('error', function (e) {
                error = e;

                opts.log.debug(
                    'copySocket for %s threw an error %', opts.vm.uuid,
                    error.toString());
            });

            copySocket.on('error', function (e) {
                opts.log.error(
                    'archive read stream for %s threw an error %',
                    opts.vm.uuid, e.message);
            });

            copySocket.pipe(res);
            next();
        });
    });
}


/**
 * GET /containers/:id/archive
 */
function containerReadArchive(req, res, next) {
    // pass in req_id: req.getId()
    var log = req.log;

    req.log.debug({req: req}, 'req');

    var opts = {
        log: log,
        cnapi: req.app.cnapi,
        req_id: req.getId(),
        vm: req.vm,
        path: req.query.path
    };

    req.backend.containerArchiveReadStream(opts, onReadStream);

    function onReadStream(err, readSocket, extras) {
        if (err) {
            return next(err);
        }

        var statHeader = new Buffer(JSON.stringify(
            extras.containerPathStat)).toString('base64');


        readSocket.on('connect', function () {
            res.setHeader('content-type', 'application/tar');
            res.setHeader('x-docker-container-path-stat', statHeader);

            readSocket.on('error', function (e) {
                opts.log.error(
                    'archive read stream for %s threw an error %',
                    opts.vm.uuid, e.message);
            });

            readSocket.pipe(res);
            next();
        });
    }
}


/**
 * PUT /containers/:id/archive
 */
function containerWriteArchive(req, res, next) {
    // pass in req_id: req.getId()
    var log = req.log;

    req.log.debug({req: req}, 'req');

    var opts = {
        log: log,
        path: req.query.path,
        cnapi: req.app.cnapi,
        req_id: req.getId(),
        vm: req.vm
    };

    var noOverwriteDirNonDir = req.query.noOverwriteDirNonDir;
    if (noOverwriteDirNonDir) {
        opts.no_overwrite_dir = common.boolFromQueryParam(noOverwriteDirNonDir);
    }

    req.backend.containerArchiveWriteStream(
        opts, onContainerArchiveWriteStream);

    function onContainerArchiveWriteStream(err, archiveSocket) {
        if (err) {
            return next(err);
        }

        archiveSocket.on('connect', function () {
            res.setHeader('content-type', 'text/plain');
            req.pipe(archiveSocket);

            var error;
            archiveSocket.on('error', function (e) {
                error = e;
                opts.log.error(
                    'archive read stream for %s threw an error %',
                    opts.vm.uuid, error.toString());
            });

            archiveSocket.on('close', function (hadError) {
                opts.log.debug(
                    'copySocket (write) closed, hadError=%s', hadError);

                if (hadError) {
                    res.send(new error.DockerError(
                        error, 'problem copying to container'));
                } else {
                    res.send(200);
                }

                next();
            });
        });
    }
}


/**
 * HEAD /containers/:id/archive
 */
function containerStatArchive(req, res, next) {
    // pass in req_id: req.getId()
    var log = req.log;

    req.log.debug({req: req}, 'req');

    var opts = {
        log: log,
        cnapi: req.app.cnapi,
        req_id: req.getId(),
        vm: req.vm,
        path: req.query.path
    };

    req.backend.containerArchiveStat(opts, function onStat(err, extras) {
        if (err) {
            return next(err);
        }

        var statHeader = new Buffer(JSON.stringify(
            extras.containerPathStat)).toString('base64');

        res.setHeader('x-docker-container-path-stat', statHeader);

        res.send(200);
        next();
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

    function reqParamsId(req, res, next) {
        req.params.id = unescape(req.params[1]);
        next();
    }

    function reqParamsLink(req, res, next) {
        req.params.link = unescape(req.params[2]);
        next();
    }

    var queryParserOpts = {
        mapParams: false,

        // See: ZAPI-744:
        allowDots: false,
        plainObjects: false
    };

    // Match: '/:apiversion/containers/json'
    http.get({ path: /^(\/v[^\/]+)?\/containers\/json$/,
        name: 'ContainerList' }, before, getImages,
        restify.queryParser(queryParserOpts), containerList);

    // Match: '/:apiversion/containers/create'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/create$/,
        name: 'ContainerCreate' },
        before,
        restify.bodyParser(),
        validate.createContainer,
        common.checkApprovedForProvisioning,
        common.reqImageIncludeSmartos,
        restify.queryParser(queryParserOpts),
        containerCreate);

    // Match: '/:apiversion/containers/:id/json'
    // TODO(trent) The *full* getImages is overkill for a single container.
    http.get({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/json$/,
        name: 'ContainerInspect' }, before, reqParamsId, getVm, getImages,
        containerInspect);

    // Match: '/:apiversion/containers/:id/top'
    http.get({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/top$/,
        name: 'ContainerTop' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts), containerTop);

    // Match: '/:apiversion/containers/:id/logs'
    http.get({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/logs$/,
        name: 'ContainerLogs' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts), containerLogs);

    // Match: '/:apiversion/containers/:id/stats'
    http.get({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/stats$/,
        name: 'ContainerStats' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts), containerStats);

    // Match: '/:apiversion/containers/:id/changes'
    http.get({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/changes$/,
        name: 'ContainerChanges' }, before, reqParamsId, getVm,
        containerChanges);

    // Match: '/:apiversion/containers/:id/export'
    http.get({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/export$/,
        name: 'ContainerExport' }, before, reqParamsId, getVm, containerExport);

    // Match: '/:apiversion/containers/:id/resize'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/resize$/,
        name: 'ContainerResize' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts), containerResize);

    // Match: '/:apiversion/containers/:id/start'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/start$/,
        name: 'ContainerStart' }, before, reqParamsId, getVm, containerStart);

    // Match: '/:apiversion/containers/:id/stop'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/stop$/,
        name: 'ContainerStop' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts), containerStop);

    // Match: '/:apiversion/containers/:id/restart'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/restart$/,
        name: 'ContainerRestart' }, before, reqParamsId, getVm,
        containerRestart);

    // Match: '/:apiversion/containers/:id/kill'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/kill$/,
        name: 'ContainerKill' }, before, reqParamsId, getVm, containerKill);

    // Match: '/:apiversion/containers/:id/pause'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/pause$/,
        name: 'ContainerPause' }, before, reqParamsId, getVm, containerPause);

    // Match: '/:apiversion/containers/:id/unpause'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/unpause$/,
        name: 'ContainerUnPause' }, before, reqParamsId, getVm,
        containerUnPause);

    // Match: '/:apiversion/containers/:id/attach'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/attach$/,
        name: 'ContainerAttach' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts), containerAttach);

    // Match: '/:apiversion/containers/:id/wait'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/wait$/,
        name: 'ContainerWait' }, before, reqParamsId, getVm, containerWait);

    // Match: '/:apiversion/containers/:id'
    http.del({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)$/,
        name: 'ContainerDelete' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts), containerDelete);

    // Match: '/:apiversion/containers/:id/link'
    http.del({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/([^\/]+)$/,
        name: 'LinkDelete' }, before, reqParamsId, reqParamsLink, getVm,
        linkDelete);
    // Support docker 1.6, which adds an extra slash after 'containers':
    // Match: '/:apiversion/containers//:id/link'
    http.del({ path: /^(\/v[^\/]+)?\/containers\/\/([^\/]+)\/([^\/]+)$/,
        name: 'LinkDeleteAlt' }, before, reqParamsId, reqParamsLink, getVm,
        linkDelete);

    // Pre-v1.20 remote api `docker cp` calls out to /copy
    // Match: '/:apiversion/containers/:id/copy'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/copy$/,
        name: 'ContainerCopy' }, before, reqParamsId, restify.bodyParser(),
        getVm, containerCopy);

    // Match: '/:apiversion/containers/:id/archive'
    http.get({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/archive$/,
        name: 'ContainerReadArchive' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts),
        validate.archiveReadStream, containerReadArchive);

    // Match: '/:apiversion/containers/:id/archive'
    http.put({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/archive$/,
        name: 'ContainerWriteArchive' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts),
        validate.archiveWriteStream, containerWriteArchive);

    // Match: '/:apiversion/containers/:id/archive'
    http.head({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/archive$/,
        name: 'ContainerStatArchive' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts),
        validate.archiveReadStream, containerStatArchive);


    // Match: '/:apiversion/containers/:id/exec'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/exec$/,
        name: 'ContainerExec' }, before, reqParamsId, getVm,
        restify.bodyParser(), containerExec);

    // Match: '/:apiversion/containers/:id/rename'
    http.post({ path: /^(\/v[^\/]+)?\/containers\/([^\/]+)\/rename$/,
        name: 'ContainerRename' }, before, reqParamsId, getVm,
        restify.queryParser(queryParserOpts), containerRename);
}

module.exports = {
    register: register
};
