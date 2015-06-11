/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Helpers for running the docker CLI in tests
 */

var assert = require('assert-plus');
var common = require('./common');
var fmt = require('util').format;
var h = require('../integration/helpers');
var vasync = require('vasync');



// --- Globals


var ALICE;
var CREATED = [];
var LAST_CREATED;
var LOG = require('../lib/log');
var state = {
    log: LOG
};


// --- Exports


/**
 * Initialize the alice DockerEnv
 */
function cliInit(t) {
    h.getDockerEnv(t, state, {account: 'sdcdockertest_alice'},
            function (err, env) {
        t.ifErr(err);
        t.ok(env, 'have a DockerEnv for alice');
        ALICE = env;

        t.end();
        return;
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

        t.ifErr(err, 'docker inspect');
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

        try {
            // This returns an array for some reason:
            obj = JSON.parse(stdout)[0];
        } catch (parseErr) {
            common.done(t, callback, parseErr);
            return;
        }

        common.partialExp(t, opts, obj);
        common.expected(t, opts, obj);

        common.done(t, callback, err, obj);
        return;
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
 * `docker run <cmd>`
 */
function cliRun(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.args, 'opts.args');

    ALICE.docker('run ' + opts.args, function (err, stdout, stderr) {
        var id;

        if (stdout) {
            id = stdout.split('\n')[0];
        }

        if (opts.expectedErr) {
            if (id) {
                t.ok(false, 'expected error but got ID: ' + id);
            }

            common.expErr(t, stderr, opts.expectedErr, callback);
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

        common.done(t, callback, err, id);
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
        var id;

        t.ifErr(err, 'docker ps');
        t.equal(stderr, '', 'stderr');

        // Parse stdout.
        var lines = stdout.split('\n');
        var entries = [];
        var re = /\s+/;
        var headerLine = lines[0].toLowerCase();
        headerLine = headerLine.replace('container id', 'container_id');
        var header = headerLine.split(re);

        // From header, determine where each section begins/ends:
        var headerStartEnds = header.map(function (val, idx) {
            var nextval = header[idx+1];
            if (idx+1 == header.length) {
                return [headerLine.indexOf(val), 100000];
            } else {
                return [headerLine.indexOf(val), headerLine.indexOf(nextval)];
            }
        });
        //console.log('header:', header, 'startEnds', headerStartEnds);

        // Split the output lines:
        for (var i=1; i < lines.length; i++) {
            var entry = {};
            var line = lines[i].trim();
            if (!line) {
                continue;
            }
            for (j=0; j < header.length; j++) {
                var se = headerStartEnds[j];
                entry[header[j]] = line.substring(se[0], se[1]).trim();
            }
            entries.push(entry);
            //console.log('entry: ', entry);
        }

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
        var id;

        t.ifErr(err, 'docker rm ' + opts.args);
        t.equal(stderr, '', 'stderr');

        callback(err);
    });
}


module.exports = {
    get accountUuid() {
        return ALICE.account.uuid;
    },
    get docker() {
        return ALICE.docker.bind(ALICE);
    },
    init: cliInit,
    inspect: cliInspect,
    get lastCreated() {
        return LAST_CREATED;
    },
    pull: cliPull,
    port: cliPort,
    ps: cliPs,
    rm: cliRm,
    rmAllCreated: cliRmAllCreated,
    run: cliRun
};
