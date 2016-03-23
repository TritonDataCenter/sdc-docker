/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker copy`
 */

var semver = require('semver');
var sprintf = require('sprintf').sprintf;
var test = require('tape');
var path = require('path');
var vasync = require('vasync');
var crypto = require('crypto');
var exec = require('child_process').exec;
var fs = require('fs');
var util = require('util');

var cli = require('../lib/cli');
var h = require('./helpers');
var vm = require('../lib/vm');


/* BEGIN JSSTYLED */
/**
 * TODO: Docker copy scenarios to support.
 *
 * # Docker copy 'out' of container:
 *
 * Single file:
 *
 *   Src:                  Dst:                  Result:
 *   --------------------  --------------------  -------------------
 *   /directory/file1.txt  .                     file1.txt
 *   /directory/file1.txt  file2.txt             file2.txt
 *   /directory/file1.txt  local-dir             local-dir/file1.txt
 *   /directory/file1.txt  local-dir/file2.txt   local-dir/file2.txt
 *
 * Directory:
 *
 *   /directory            .                     directory/
 *   /directory            local-dir             local-dir/directory
 *   /directory            local-dir/directory2  local-dir/directory2
 *
 *
 * # Docker copy 'into' container:
 *
 * Single file:
 *
 *   Src:                  Dst:                  Result:
 *   --------------------  --------------------  --------------------
 *   file1.txt             .                     file1.txt
 *   /directory/file1.txt  file2.txt             file2.txt
 *   /directory/file1.txt  remote-dir            remote-dir/file1.txt
 *   /directory/file1.txt  remote-dir/file2.txt  remote-dir/file2.txt
 *
 *
 * Copy out:
 *   * of a running container:
 *      - single file (and permuted permisisons)
 *      - directory structure with sub directories and files (and permuted
 *        permissions)
 *
 *   * of a stopped container:
 *      - single file (and permuted permisisons)
 *      - directory structure with sub directories and files (and permuted
 *        permissions)
 *
 * Copy in:
 *   * of a running container:
 *      - single file (and permuted permissions)
 *        - permuted permisisons
 *        - permuted date
 *      - directory structure with sub directories and files (and permuted
 *        permissions)
 *
 *   * of a stopped container:
 *      - single file (and permuted permisisons)
 *      - directory structure with sub directories and files (and permuted
 *        permissions)
 */
/* END JSSTYLED */


var CONTAINER_PREFIX = 'sdcdockertest_copy_';

// --- Globals

var log = require('../lib/log');
var state = {
    log: log
};

var nginxName = CONTAINER_PREFIX + 'nginx';
var nginxName2 = CONTAINER_PREFIX + 'nginx2';



/**
 * Setup
 */

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', cli.init);
    tt.test('vmapi client', vm.init);
});


test('test initialization', function (tt) {

    removeNginxTestContainers(tt);

    vasync.forEachParallel({
        inputs: [nginxName, nginxName2],
        func: function (name, next) {
            tt.test('create container ' + name, function (t) {
                t.plan(3);
                cli.run(t, { args: '-d --name ' + name + ' nginx' },
                function (err, id) {
                    t.ifErr(err, 'docker run ' + name);
                    t.end();
                    next();
                });
            });
        }
    }, function (err) {
        tt.end();
    });
});



/**
 * Tests
 */


test('copy out of container file placement', function (tt) {
    var cliVer = process.env.DOCKER_CLI_VERSION;
    if (cliVer && semver.lt(cliVer, '1.8.0')) {
        tt.skip('Docker copy out not supported in client ' + cliVer);
        tt.end();
        return;
    }

    tt.plan(16);

    var directoryName = 'local-dir-' + process.pid;

    // XXX do this for running and shutdown containers
    var testcases = [
        {
            src: '/etc/nginx/nginx.conf',
            dst: '.',
            result: 'nginx.conf'
        },
        {
            src: '/etc/nginx/nginx.conf',
            dst: 'file2.conf',
            result: 'file2.conf'
        },
        {
            src: '/etc/nginx/nginx.conf',
            dst: directoryName,
            result: path.join(directoryName, 'nginx.conf')
        },
        {
            src: '/etc/nginx/nginx.conf',
            dst: path.join(directoryName, 'file2.conf'),
            result: path.join(directoryName, 'file2.conf')
        },
        {
            src: '/etc/nginx/',
            dst: '.',
            result: 'nginx'
        },
        {
            src: '/etc/nginx',
            dst: 'nginx2',
            result: 'nginx2'
        },
        {
            src: '/etc/nginx',
            dst: directoryName,
            result: path.join(directoryName, 'nginx')
        }
    ];


    vasync.waterfall([
        initializeFixtures,
        executeTestCases
    ], function (err) {
        tt.end();
    });


    function initializeFixtures(callback) {
        vasync.waterfall([
            function createDir(next) {
                cli.execInTestZone(sprintf('mkdir -p %s', directoryName),
                function (err, stdout, stderr) {
                    tt.ifErr(err, 'creating test directory');
                    tt.comment('created ' + directoryName);
                    next(err);
                });
            }
        ],
        function (err) {
            tt.ifErr(err);
            callback(err);
        });
    }

    function executeTestCases(callback) {
        vasync.forEachPipeline({
            inputs: testcases,
            func: executeCopyOutTestcase
        },
        function (err) {
            callback(err);
        });
    }

    function executeCopyOutTestcase(tc, callback) {
        var src = tc.src;
        var dst = tc.dst;
        var result = tc.result;
        var args = sprintf(
            'cp %s:%s %s',
            nginxName, src, dst);
        tt.comment(args);
        var execOpts = { maxBuffer: 1024*1024+1, encoding: 'binary' };
        cli.docker(args, { execOpts: execOpts }, onDocker);
        function onDocker(err, stdout, stderr) {
            tt.ifErr(err, 'no `docker copy` error');

            // TODO better mechanism for checking existence of resulting file
            cli.execInTestZone(sprintf('ls %s', result), function (execErr) {
                tt.ifErr(execErr,
                    'checking for existence of resulting docker copy file');
                callback();
            });
        }
    }
});


test('copy a file out of running container', function (tt) {
    var cliVer = process.env.DOCKER_CLI_VERSION;
    if (cliVer && semver.lt(cliVer, '1.8.0')) {
        tt.skip('Docker copy out not supported in client ' + cliVer);
        tt.end();
        return;
    }

    tt.plan(7);
    var fnbase = '/var/tmp';
    var fn = 'copyout.test';
    var ffn = fnbase + '/' + fn;
    var hash;

    vasync.waterfall([
        function (next) {
            createCopyOutFile(tt, ffn, nginxName, function (err, sha1) {
                tt.ifErr(err, 'creating copy out file');
                hash = sha1;
                tt.comment('hash was ' + hash);
                next();
            });
        },
        function (next) {
            copyFileOut(tt, ffn, fn, nginxName, function (err) {
                tt.ifErr(err, 'copying file out');
                next();
            });
        },
        function (next) {
            checkFileCopiedOut(tt, ffn, nginxName, hash, function (err) {
                tt.ifErr(err, 'copying file out');
                next();
            });
        }
    ], function (err) {
        tt.end();
    });
});


test('copy a file out of stopped container', function (tt) {
    var cliVer = process.env.DOCKER_CLI_VERSION;
    if (cliVer && semver.lt(cliVer, '1.8.0')) {
        tt.skip('Docker copy out not supported in client ' + cliVer);
        tt.end();
        return;
    }

    tt.plan(9);

    var fnbase = '/var/tmp';
    var fn = 'copyout.test';
    var ffn = fnbase + '/' + fn;
    var hash;

    vasync.waterfall([
        function (next) {
            createCopyOutFile(tt, ffn, nginxName2, function (err, sha1) {
                tt.ifErr(err, 'creating copy out file');
                hash = sha1;
                next();
            });
        },
        function (next) {
            stopContainer(tt, nginxName2, function (err) {
                tt.ifErr(err, 'stopping copy out container');
                next();
            });
        },
        function (next) {
            copyFileOut(tt, ffn, fn, nginxName2, function (err, sha1) {
                tt.ifErr(err, 'copying file out');
                tt.equal(sha1, hash);
                next();
            });
        }
    ], function (err) {
        tt.end();
    });
});

test('copy a file into running container', function (tt) {
    tt.plan(7);

    var fnbase = '/var/tmp';
    var fn = 'copy-in.test';
    var ffn = fnbase + '/' + fn;

    var hash;

    vasync.waterfall([
        function (next) {
            createCopyInFile(tt, ffn, function (err, sha1) {
                tt.ifErr(err, 'creating copy in file (running container)');
                hash = sha1;
                tt.comment('running container file sha1 ' + sha1);
                next();
            });
        },
        function (next) {
            copyFileIn(tt, ffn, fn, nginxName, function (err) {
                tt.ifErr(err, 'copying file in');
                next();
            });
        },
        function (next) {
            checkFileCopiedIn(tt, ffn, fn, nginxName, hash, function (err) {
                tt.ifErr(err, 'checking file copied in');
                next();
            });
        }
    ], function (err) {
        tt.end();
    });
});


test('copy a file into stopped container', function (tt) {
    tt.plan(15);

    var fnbase = '/var/tmp';
    var fn = 'copy-in.test';
    var ffn = fnbase + '/' + fn;

    var hash;

    vasync.waterfall([
        function (next) {
            createCopyInFile(tt, ffn, function (err, sha1) {
                tt.ifErr(err, 'creating copy in file (stopped container)');
                hash = sha1;
                next();
            });
        },
        function (next) {
            stopContainer(tt, nginxName2, function (err) {
                tt.ifErr(err, 'error stopping container');
                next();
            });
        },
        function (next) {
            copyFileIn(tt, ffn, fn, nginxName2, function (err) {
                tt.ifErr(err, 'copying file in');
                next();
            });
        },
        function (next) {
            startContainer(tt, nginxName2, function (err) {
                tt.ifErr(err, 'error stopping container');
                next();
            });
        },
        function (next) {
            checkFileCopiedIn(tt, ffn, fn, nginxName2, hash, function (err) {
                tt.ifErr(err, 'checking file copied in');
                next();
            });
        }
    ], function (err) {
        tt.end();
    });
});


/**
 * Cleanup.
 */
test('copy container cleanup', function (tt) {
    removeNginxTestContainers(tt);
});



/**
 * Support functions
 */

function stopContainer(tt, containerName, callback) {
    cli.stop(tt, { args: containerName }, function (err) {
        tt.ifErr(err, 'stopping container');
        callback(err);
    });
}


function startContainer(tt, containerName, callback) {
    cli.start(tt, { args: containerName }, function (err) {
        tt.ifErr(err, 'starting container');
        callback(err);
    });
}


function removeNginxTestContainers(tt) {
    tt.test('remove old containers', function (t) {
        cli.ps(t, {args: '-a'}, function (err, entries) {
            t.ifErr(err, 'docker ps');

            var oldContainers = entries.filter(function (entry) {
                return (entry.names.substr(0, CONTAINER_PREFIX.length)
                        === CONTAINER_PREFIX);
            });

            vasync.forEachParallel({
                inputs: oldContainers,
                func: function _delOne(entry, cb) {
                    cli.rm(t, {args: '-f ' + entry.container_id},
                            function (err2)
                    {
                        t.ifErr(err2, 'rm container ' + entry.container_id);
                        cb();
                    });
                }
            }, function () {
                t.end();
            });
        });
    });
}


/**
 * Copy out test auxillary support functions
 */

function createCopyOutFile(tt, ffn, containerName, callback) {
    // Create a file and get a checksum of it
    var inside = [
        'dd if=/dev/urandom count=1024 bs=1024',
        'tee ' + ffn,
        '/native/usr/bin/sum -x sha1'
    ].join('| \\\n');
    var args = sprintf('exec %s bash -c "%s"', containerName, inside);
    cli.docker(args, onDocker);

    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        callback(err, stdout.toString().trim());
    }
}


function copyFileOut(tt, ffn, fn, containerName, callback) {
    var args = sprintf(
        'cp %s:%s - | tar xOf - %s',
        containerName, ffn, fn);
    var execOpts = { maxBuffer: 1024*1024+1, encoding: 'binary' };
    cli.docker(args, { execOpts: execOpts }, onDocker);
    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        var str = stdout.toString();
        var hash =
            crypto.createHash('sha1').update(str, 'binary').digest('hex');
        callback(err, hash);
    }
}

function checkFileCopiedOut(tt, ffn, containerName, hash, callback) {
    var args = sprintf('exec %s /native/usr/bin/sum -x sha1 %s',
        containerName, ffn);
    cli.docker(args, onDocker);
    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        var actHash = stdout.toString().trim().split(' ')[0];
        tt.equal(actHash, hash);
        callback();
    }
}


function createCopyInFile(tt, ffn, callback) {
    var hash;
    var cmd = sprintf(
        'dd if=/dev/urandom of=%s '
        + 'count=1024 bs=1024 >/dev/null && '
        + '/native/usr/bin/sum -x sha1 %s | awk "{ print $1 }"',
        ffn, ffn);
    cli.execInTestZone(cmd, function (err, stdout, stderr) {
        tt.ifErr(err);
        hash = stdout.toString();
        callback(err, hash);
    });
}


function copyFileIn(tt, ffn, fn, containerName, callback) {
    var args = sprintf('cp %s %s:%s', ffn, containerName, ffn);
    var execOpts = { maxBuffer: 1024*1024*2, encoding: 'binary' };
    cli.docker(args, { execOpts: execOpts }, onDocker);
    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        callback(err);
    }
}

function checkFileCopiedIn(tt, ffn, fn, containerName, hash, callback) {
    var args =
        sprintf('exec %s /native/usr/bin/sum -x sha1 %s', containerName, ffn);
    cli.docker(args, onDocker);
    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        tt.comment('sha1 before ' + hash);
        tt.comment('sha1 after ' + stdout.toString());
        tt.equal(stdout.toString(), hash);
        callback(err);
    }
}
