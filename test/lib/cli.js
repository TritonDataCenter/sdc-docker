/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Helpers for running the docker CLI in tests
 */

var assert = require('assert-plus');
var fmt = require('util').format;
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('./common');
var h = require('../integration/helpers');


// --- Globals


var ALICE;
var ALICE_CLIENT;
var CREATED = [];
var LAST_CREATED;
var LOG = require('../lib/log');
var state = {
    log: LOG
};


// --- Exports


/**
 * Initialize the alice DockerEnv
 *
 * Callback returns (err, result) with result containing:
 *  {
 *    client: json (restify) client object for the docker socket
 *    user: account object
 *  }
 */
function cliInit(t, cb) {
    h.getDockerEnv(t, state, {account: 'sdcdockertest_alice'},
            function (err, env) {
        t.ifErr(err, 'expect no error loading docker env');
        t.ok(env, 'have a DockerEnv for alice');
        ALICE = env;

        h.createDockerRemoteClient({user: ALICE},
            function (clientErr, client) {
                t.ifErr(clientErr, 'docker remote client for alice');
                ALICE_CLIENT = client;
                if (cb) {
                    cb(err || clientErr, {user: ALICE, client: ALICE_CLIENT});
                }
                t.end();
            }
        );
    });
}


/**
 * `docker inspect <id>`
 */
function cliInspect(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');

    ALICE.docker('inspect ' + opts.id, function (err, stdout, stderr) {
        var obj;
        var pe;

        t.ifErr(err, 'docker inspect ' + opts.id);
        t.equal(stderr, '', 'stderr should be empty');

        // XXX: allow setting opts.expectedErr
        if (err) {
            common.done(t, callback, err);
            return;
        }

        if (!stdout) {
            var stdoutErr = new Error('no stdout!');
            t.ifErr(stdoutErr, 'no stdout found');
            common.done(t, callback, stdoutErr);
            return;
        }

        try {
            // This returns an array for some reason:
            obj = JSON.parse(stdout)[0];
        } catch (parseErr) {
            common.done(t, callback, parseErr);
            return;
        }

        // Special case for Labels, if we have opts.partialExp including a label
        // with a value '*', we'll replace that with the value for that label
        // from 'obj' since in that case we're just trying to confirm the label
        // exists and don't care about the value. By setting it as the
        // partialExp value, the objects will not differ on this field.
        if (obj && obj.Config && obj.Config.Labels && opts) {
            pe = opts.partialExp;

            if (pe && pe.Config && pe.Config.Labels) {
                Object.keys(pe.Config.Labels).forEach(
                    function _fixWildcardLabels(l) {
                        if (pe.Config.Labels[l] === '*') {
                            pe.Config.Labels[l] = obj.Config.Labels[l];
                        }
                    }
                );
            }
        }

        common.partialExp(t, opts, obj);
        common.expected(t, opts, obj);

        common.done(t, callback, err, obj);
        return;
    });
}


/**
 * `docker images <opts.args>`
 *
 * An array of entries will returned via the callback(err, entries), with each
 * entry being an object holding the docker images contents for one image.
 * Example:
 *  {
 *      "RepoTags": ["busybox:latest"],
 *      "Uuid": "d8473b5a-713b-6b89-e35b-40620a1da3b3",
 * `docker images <opts.args>`
 *
 * An array of entries will returned via the callback(err, entries), with each
 * entry being an object holding the docker images contents for one image.
 * Example:
 *  {
 *      "RepoTags": ["busybox:latest"],
 *      "Uuid": "d8473b5a-713b-6b89-e35b-40620a1da3b3",
 *      "Id": "bc744c4ab376115cc45c610d53f529dd2d4249ae6b35e5d6e7ae58863545aa",
 *      "IndexName": "docker.io",
 *      "Created": 1458325368,
 *      "Cmd": ["sh"],
 *      "Env": null,
 *      "Entrypoint": null,
 *      "ParentId": "56ed16bd6310cca65920c653a9bb22de6baa1742ff839867aed730e5",
 *      "Size": 0,
 *      "Tty": false,
 *      "User": "",
 *      "VirtualSize": 0,
 *      "Volumes": null,
 *      "WorkingDir": ""
 *  }
 */
function cliImages(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.optionalString(opts.args, 'opts.args');

    ALICE.docker('images ' + (opts.args || ''), function (err, stdout, stderr) {
        if (opts.expectedErr) {
            t.equal(stdout, '', 'stdout should be empty');
            common.expCliErr(t, stderr, opts.expectedErr, callback);
            return;
        } else {
            t.ifErr(err, 'docker images' + (' ' + opts.args || ''));
            t.equal(stderr, '', 'stderr should be empty');
        }

        // Parse stdout using header columns.
        var parseOpts = {
            headerNamesWithSpaces: ['image id'],
            linesOnly: opts.linesOnly
        };
        var entries = common.parseOutputUsingHeader(stdout, parseOpts);

        common.done(t, callback, err, entries);
    });
}


/**
 * `docker port <id> [port spec]`
 */
function cliPort(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');

    ALICE.docker('port ' + opts.id, function (err, stdout, stderr) {
        var obj = {};

        t.ifErr(err, 'docker port');
        t.equal(stderr, '', 'stderr');

        // XXX: allow setting opts.expectedErr
        if (err) {
            common.done(t, callback, err);
            return;
        }

        if (!stdout) {
            // Not an error to have an empty stdout - if no ports are
            // exposed, this is expected.
            stdout = '';
        }

        stdout.split('\n').forEach(function (line) {
            var split = line.split(' -> ');
            if (split[0] && split[1]) {
                obj[split[0]] = split[1];
            }
        });

        common.partialExp(t, opts, obj);
        common.expected(t, opts, obj);

        common.done(t, callback, err, obj);
        return;
    });
}


/**
 * `docker pull <id>`
 */
function cliPull(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.image, 'opts.image');

    ALICE.docker('pull ' + opts.image, function (err, stdout, stderr) {
        var obj;

        t.ifErr(err, 'docker pull');
        t.equal(stderr, '', 'stderr');

        // XXX: allow setting opts.expectedErr
        if (err) {
            common.done(t, callback, err);
            return;
        }

        if (!stdout) {
            var stdoutErr = new Error('no stdout!');
            t.ifErr(stdoutErr, 'no stdout found');
            common.done(t, callback, stdoutErr);
            return;
        }

        // XXX: allow some sort of comparison here, or do we just care
        // about pass / fail?

        common.done(t, callback, err, obj);
        return;
    });
}


/**
 * Removes all docker VMs created during this test
 */
function cliRmAllCreated(t) {
    if (CREATED.length === 0) {
        t.ok(true, 'No VMs created');
        t.end();
        return;
    }

    if (!ALICE) {
        t.ok(true, 'No docker env: not deleting');
        t.end();
        return;
    }

    vasync.forEachParallel({
        inputs: CREATED,
        func: function _delOne(id, cb) {
            ALICE.docker('rm -f ' + id, function (err, stdout, stderr) {
                t.ifErr(err, 'rm container ' + id);

                cb();
                return;
            });
        }
    }, function () {
        t.end();
        return;
    });
}


/**
 * `docker create <cmd>`
 */
function cliCreate(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('create ' + opts.args, function (err, stdout, stderr) {
        var id;

        if (stdout) {
            id = stdout.split('\n')[0];
        }

        if (opts.expectedErr) {
            if (id) {
                t.ok(false, 'expected error but got ID: ' + id);
            }

            common.expCliErr(t, stderr, opts.expectedErr, callback);
            return;

        } else {
            t.ifErr(err, 'docker create');
            // Docker create may need to download the image, which produces
            // stderr - only allow for that case:
            if (stderr
                && stderr.indexOf('Status: Downloaded newer image') === -1)
            {
                t.equal(stderr, '', 'stderr');
            }
        }

        if (id) {
            t.ok(id, fmt('"docker create %s" -> ID %s', opts.args, id));
            CREATED.push(id);
            LAST_CREATED = id;
        }

        common.done(t, callback, err, id);
        return;
    });
}


/**
 * `docker run <cmd>`
 *
 * Note that the returned callback result is different depending on whether the
 * run command used '-d' (background) mode.
 */
function cliRun(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    // The docker id is only printed when in background (detached) mode.
    // Note: This detection is lame - but effective enough for our usage.
    var detachedRegex = /(^|\s)(-d|--detached)\s/;
    var isBackgroundMode = (opts.args || '').search(detachedRegex) >= 0;

    ALICE.docker('run ' + opts.args, function (err, stdout, stderr) {
        var id;

        if (isBackgroundMode && stdout) {
            id = stdout.split('\n')[0];
        }

        if (opts.expectedErr) {
            if (id) {
                t.ok(false, 'expected error but got ID: ' + id);
            }

            common.expCliErr(t, stderr, opts.expectedErr, callback);
            return;

        } else {
            t.ifErr(err, 'docker run');
            // Docker run may need to download the image, which produces
            // stderr - only allow for that case:
            if (stderr
                && stderr.indexOf('Status: Downloaded newer image') === -1)
            {
                t.equal(stderr, '', 'stderr');
            }
        }

        if (id) {
            t.ok(id, fmt('"docker run %s" -> ID %s', opts.args, id));
            CREATED.push(id);
            LAST_CREATED = id;
        }

        if (isBackgroundMode) {
            common.done(t, callback, err, id);
        } else {
            common.done(t, callback, err, { stdout: stdout, stderr: stderr });
        }
        return;
    });
}


/**
 * `docker ps <opts.args>`
 *
 * An array of entries will returned via the callback(err, entries), with each
 * entry being an object holding the docker ps contents for one vm. Example:
 *  {
 *    container_id: 'db49fddba05e',
 *    image: 'nginx',
 *    command: '"nginx -g \'daemon of',
 *    created: '43 seconds ago',
 *    status: 'Up 31 seconds',
 *    ports: '443/tcp, 0.0.0.0:80->80/tcp',
 *    names: 'linkstest_nginx'
 *  }
 */
function cliPs(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.optionalString(opts.args, 'opts.args');

    ALICE.docker('ps ' + (opts.args || ''), function (err, stdout, stderr) {
        if (opts.expectedErr) {
            t.equal(stdout, '', 'stdout should be empty');
            common.expCliErr(t, stderr, opts.expectedErr, callback);
            return;
        } else {
            t.ifErr(err, 'docker ps' + (' ' + opts.args || ''));
            t.equal(stderr, '', 'stderr should be empty');
        }

        // Parse stdout using header columns.
        var parseOpts = {
            headerNamesWithSpaces: ['container id'],
            linesOnly: opts.linesOnly
        };
        var entries = common.parseOutputUsingHeader(stdout, parseOpts);

        common.done(t, callback, err, entries);
        return;
    });
}


/**
 * `docker delete <opts.args>`
 */
function cliRm(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('rm ' + opts.args, function (err, stdout, stderr) {
        t.ifErr(err, 'docker rm ' + opts.args);
        t.equal(stderr, '', 'stderr');

        callback(err);
    });
}


/**
 * `docker rmi <opts.args>`
 */
function cliRmi(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('rmi ' + opts.args, function (err, stdout, stderr) {
        t.ifErr(err, 'docker rmi ' + opts.args);
        t.equal(stderr, '', 'stderr');
        callback(err);
    });
}


/**
 * `docker stop <opts.args>`
 */
function cliStop(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('stop ' + opts.args, function (err, stdout, stderr) {
        t.ifErr(err, 'docker stop ' + opts.args);
        t.equal(stderr, '', 'stderr');
        callback(err);
    });
}


/**
 * `docker start <opts.args>`
 */
function cliStart(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('start ' + opts.args, function (err, stdout, stderr) {
        t.ifErr(err, 'docker start ' + opts.args);
        t.equal(stderr, '', 'stderr');
        callback(err);
    });
}


/**
 * `docker commit <opts.args>`
 */
function cliCommit(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('commit ' + opts.args, function (err, stdout, stderr) {
        var id;

        if (stdout) {
            id = stdout.split('\n')[0];
        }

        if (opts.expectedErr) {
            if (id) {
                t.ok(false, 'expected error but got ID: ' + id);
            }

            common.expCliErr(t, stderr, opts.expectedErr, callback);
            return;

        } else {
            t.ifErr(err, 'docker commit');
        }

        if (id) {
            t.ok(id, fmt('"docker commit %s" -> ID %s', opts.args, id));
        }

        common.done(t, callback, err, id);
    });
}

/**
 * `docker volume create <opts.args>`
 */
function cliCreateVolume(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.t, 'opts.t');
    assert.optionalString(opts.args, 'opts.args');

    var t = opts.t;
    var command = [
        'volume create'
    ];

    if (opts.args) {
        command.push(opts.args);
    }

    ALICE.docker(command.join(' '), function (err, stdout, stderr) {
        if (t) {
            t.ifErr(err, 'docker volume create ' + opts.args);
        }

        callback(err, stdout, stderr);
    });
}

/**
 * `docker volume rm <opts.args>`
 */
function cliDeleteVolume(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.t, 'opts.t');
    assert.string(opts.args, 'opts.args');

    var t = opts.t;

    ALICE.docker('volume rm ' + opts.args, function (err, stdout, stderr) {
        if (t) {
            t.ifErr(err, 'docker volume rm ' + opts.args);
        }

        callback(err, stdout, stderr);
    });
}

/**
 * `docker volume ls <opts.args>`
 */
function cliListVolumes(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.t, 'opts.t');
    assert.optionalString(opts.args, 'opts.args');

    var t = opts.t;
    var listVolumesCommand = 'volume ls';
    if (opts.args) {
        listVolumesCommand += ' ' + opts.args;
    }

    ALICE.docker(listVolumesCommand, function (err, stdout, stderr) {
        if (t) {
            t.ifErr(err, 'docker volume ls ' + opts.args);
        }

        callback(err, stdout, stderr);
    });
}

/**
 * `docker attach <id>`
 *
 * Attach to a running container.
 */

function cliAttach(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('attach ' + opts.args, function (err, stdout, stderr) {
        // pass errors back to caller
        common.done(t, callback, err);
    });
}


/*
 * `docker volume inspect <opts.args>`
 */
function cliInspectVolume(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.t, 'opts.t');
    assert.string(opts.args, 'opts.args');

    var t = opts.t;

    ALICE.docker('volume inspect ' + opts.args, function (err, stdout, stderr) {
        if (t) {
            t.ifErr(err, 'docker volume inspect ' + opts.args);
        }

        callback(err, stdout, stderr);
    });
}

module.exports = {
    commit: cliCommit,
    create: cliCreate,
    get accountUuid() {
        return ALICE.account.uuid;
    },
    get docker() {
        return ALICE.docker.bind(ALICE);
    },
    get exec() {
        return ALICE.exec.bind(ALICE);
    },
    init: cliInit,
    inspect: cliInspect,
    images: cliImages,
    get lastCreated() {
        return LAST_CREATED;
    },
    pull: cliPull,
    port: cliPort,
    ps: cliPs,
    rm: cliRm,
    rmi: cliRmi,
    rmAllCreated: cliRmAllCreated,
    run: cliRun,
    stop: cliStop,
    start: cliStart,
    attach: cliAttach
    createVolume: cliCreateVolume,
    rmVolume: cliDeleteVolume,
    listVolumes: cliListVolumes,
    inspectVolume: cliInspectVolume
};
