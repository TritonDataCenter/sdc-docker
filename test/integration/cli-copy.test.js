/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
var configLoader = require('../../lib/config-loader.js');

var STATE = {
    log: require('../lib/log')
};
var ALICE;

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


// --- Globals

var log = require('../lib/log');
var state = {
    log: log
};

var CONTAINER_PREFIX = 'sdcdockertest_copy_';
var CONTAINER_NAME_NGINX = CONTAINER_PREFIX + 'nginx';
var CONTAINER_NAME_NGINX2 = CONTAINER_PREFIX + 'nginx2';
var CONTAINER_NAME_ALPINE = CONTAINER_PREFIX + 'alpine';

var CONTAINERS_TO_CREATE = [
    { name: CONTAINER_NAME_NGINX,  image: 'nginx' },
    { name: CONTAINER_NAME_NGINX2, image: 'nginx' },
    { name: CONTAINER_NAME_ALPINE, image: 'alpine', cmd: 'sleep 1000000' }
];



/**
 * Setup
 */

test('setup', function (tt) {
    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('DockerEnv: alice init', cli.init);
    tt.test('vmapi client', vm.init);

    tt.test('pull nginx image', function (t) {
        h.ensureImage({
            name: 'nginx:latest',
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling image');
            t.end();
        });
    });
});


test('test initialization', function (tt) {
    cli.rmContainersWithNamePrefix(tt, CONTAINER_PREFIX);

    vasync.forEachParallel({
        inputs: CONTAINERS_TO_CREATE,
        func: function (create, next) {
            var name = create.name;
            var image = create.image;
            var cmd = create.cmd;

            tt.test('create container ' + name, function (t) {
                t.plan(3);

                var args = sprintf(
                    '-d --name %s %s %s', name, image, cmd || '');
                cli.run(t, { args: args},
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
 * Tests ---------------------------------------------------------------------
 */

test('copy out of container file with funky name', function (tt) {
    /**
     * Test that we can copy in and copy out files that have variety of
     * characters, some of which could be considered "problematic".  Previous
     * version of sdc-docker escaped some of these characters in filenames, but
     * this was deemed unnecessary in DOCKER-994, so this escaping was removed.
     * Here we want to check that filenames with funky characters continue to
     * work.
     */

    var remoteFilenames = [
        'period.txt',
        'under_score',
        '(openparen',
        '^caret',
        'doyouwantobuilda☃',
        '#filltheswamp',
        'loudnoises\\!',
        'equal=sign',
        '\\"double-quote',
        'has space',
        'ast*risk'
    ];

    var remoteDir = '/var/tmp/';
    var localFn = remoteDir + '/local.txt';
    var contents = 'here come dat boi';

    vasync.waterfall([
        function (next) {
            createLocalFile(localFn, contents, next);
        },
        function (next) {
            copyFilesIn(localFn, remoteDir, next);
        },
        function (next) {
            copyFilesOutAndCheckContents(remoteDir, contents, next);
        }
    ],
    function (err) {
        tt.ifErr(err, 'no errors copying files out with funky name');
        tt.end();
    });


    function createLocalFile(local, fileContents, cb) {
        var cmd = sprintf('echo "%s" > %s', fileContents, local);
        cli.exec(cmd, function (execErr) {
            tt.ifErr(execErr, 'creating file to be copied');
            cb(execErr);
        });
    }


    function copyFilesIn(local, remote, cb) {
        vasync.forEachPipeline({
            inputs: remoteFilenames,
            func: function (filename, next) {
                copyFileIn(tt, local,
                            remote + filename, CONTAINER_NAME_ALPINE, next);
            }
        }, function (err) {
            tt.ifErr(err, 'no error copying test files into container');
            cb();
        });
    }


    function copyFilesOutAndCheckContents(remote, fileContents, cb) {
        vasync.forEachPipeline({
            inputs: remoteFilenames,
            func: function (filename, next) {
                copyFileOutGetContents(
                    tt, remote + filename, filename, CONTAINER_NAME_ALPINE,
                    onCopyOut);

                function onCopyOut(err, str) {
                    tt.equal(str, fileContents, 'file contents matched');
                    next();
                }
            }
        }, function (err) {
            tt.ifErr(err, 'no errors copying out and checking test files');
            cb();
        });
    }

});


test('copy out of container file placement', function (tt) {
    var directoryName = 'local-dir-' + process.pid;
    var testcases = [
        {
            src: '/etc/nginx/nginx.conf',
            dst: '.',
            result: 'nginx.conf'
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
            src: '/etc/init.d/',
            dst: '.',
            result: 'init.d'
        },
        {
            src: '/etc/init.d',
            dst: 'init.d2',
            result: 'init.d2'
        },
        {
            src: '/etc/init.d',
            dst: directoryName,
            result: path.join(directoryName, 'init.d')
        }
    ];

    var plan = 14;
    var cliVer = process.env.DOCKER_CLI_VERSION;

    if (cliVer && !semver.lt(cliVer, '1.8.0')) {
        // In earlier docker versions this test does not work in the same way.
        // It creates a "file2.conf" directory and places our file within it.
        testcases.push({
            src: '/etc/nginx/nginx.conf',
            dst: 'file2.conf',
            result: 'file2.conf'
        });
        plan += 2;
    }
    tt.plan(plan);

    vasync.waterfall([
        initializeFixtures,
        executeTestCases
    ],
    function (err) {
        tt.end();
    });

    function initializeFixtures(callback) {
        vasync.waterfall([
            function createDir(next) {
                cli.exec(sprintf('mkdir -p %s', directoryName),
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
            CONTAINER_NAME_NGINX, src, dst);
        tt.comment(args);
        var execOpts = { encoding: 'binary' };
        cli.docker(args, { execOpts: execOpts }, onDocker);
        function onDocker(err, stdout, stderr) {
            tt.ifErr(err, 'no `docker copy` error');

            // TODO better mechanism for checking existence of resulting file
            cli.exec(sprintf('ls %s', result), function (execErr) {
                tt.ifErr(execErr,
                    'checking for existence of resulting docker copy file');
                callback();
            });
        }
    }
});


test('copy a file out of running container', function (tt) {
    tt.plan(7);
    var fnbase = '/var/tmp';
    var fn = 'copyout.test';

    var remotefn = fnbase + '/' + fn;

    var hash;

    vasync.waterfall([
        function (next) {
            createCopyOutFile(tt, remotefn, CONTAINER_NAME_NGINX,
            function (err, sha1) {
                tt.ifErr(err, 'creating copy out file');
                hash = sha1;
                tt.comment('hash was ' + hash);
                next();
            });
        },
        function (next) {
            copyFileOut(tt, remotefn, fn, CONTAINER_NAME_NGINX,
            function (err) {
                tt.ifErr(err, 'copying file out');
                next();
            });
        },
        function (next) {
            checkFileCopiedOut(tt, remotefn, hash, CONTAINER_NAME_NGINX,
            function (err) {
                tt.ifErr(err, 'copying file out');
                next();
            });
        }
    ], function (err) {
        tt.end();
    });
});


test('copy a file out of stopped container', function (tt) {
    tt.plan(9);

    var fnbase = '/var/tmp';
    var fn = 'copyout.test';

    var remotefn = fnbase + '/' + fn;

    var hash;

    vasync.waterfall([
        function (next) {
            createCopyOutFile(tt, remotefn, CONTAINER_NAME_NGINX2,
            function (err, sha1) {
                tt.ifErr(err, 'creating copy out file');
                hash = sha1;
                next();
            });
        },
        function (next) {
            stopContainer(tt, CONTAINER_NAME_NGINX2,
            function (err) {
                tt.ifErr(err, 'stopping copy out container');
                next();
            });
        },
        function (next) {
            copyFileOut(tt, remotefn, fn, CONTAINER_NAME_NGINX2,
            function (err, sha1) {
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
    var cliVer = process.env.DOCKER_CLI_VERSION;
    if (cliVer && semver.lt(cliVer, '1.8.0')) {
        tt.skip('Docker copy out not supported in client ' + cliVer);
        tt.end();
        return;
    }

    tt.plan(7);

    var fnbase = '/var/tmp';
    var fn = 'copy-in.test';

    var remotefn = fnbase + '/' + fn;
    var localfn = fnbase + '/' + fn;

    var hash;

    vasync.waterfall([
        function (next) {
            createCopyInFile(tt, localfn, function (err, sha1) {
                tt.ifErr(err, 'creating copy in file (running container)');
                hash = sha1;
                tt.comment('running container file sha1 ' + sha1);
                next();
            });
        },
        function (next) {
            copyFileIn(tt, localfn, remotefn, CONTAINER_NAME_NGINX,
            function (err) {
                tt.ifErr(err, 'copying file in');
                next();
            });
        },
        function (next) {
            checkFileCopiedIn(tt, remotefn, CONTAINER_NAME_NGINX, hash,
            function (err) {
                tt.ifErr(err, 'checking file copied in');
                next();
            });
        }
    ], function (err) {
        tt.end();
    });
});


test('copy a file into stopped container', function (tt) {
    var cliVer = process.env.DOCKER_CLI_VERSION;
    if (cliVer && semver.lt(cliVer, '1.8.0')) {
        tt.skip('Docker copy out not supported in client ' + cliVer);
        tt.end();
        return;
    }

    tt.plan(15);

    var fnbase = '/var/tmp';
    var fn = 'copy-in.test';

    var localfn = fnbase + '/' + fn;
    var remotefn = fnbase + '/' + fn;

    var hash;

    vasync.waterfall([
        function (next) {
            createCopyInFile(tt, localfn, function (err, sha1) {
                tt.ifErr(err, 'creating copy in file (stopped container)');
                hash = sha1;
                next();
            });
        },
        function (next) {
            stopContainer(tt, CONTAINER_NAME_NGINX2, function (err) {
                tt.ifErr(err, 'error stopping container');
                next();
            });
        },
        function (next) {
            copyFileIn(tt, localfn, remotefn, CONTAINER_NAME_NGINX2,
            function (err) {
                tt.ifErr(err, 'copying file in');
                next();
            });
        },
        function (next) {
            startContainer(tt, CONTAINER_NAME_NGINX2, function (err) {
                tt.ifErr(err, 'error stopping container');
                next();
            });
        },
        function (next) {
            checkFileCopiedIn(tt, remotefn, CONTAINER_NAME_NGINX2, hash,
            function (err) {
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
    cli.rmContainersWithNamePrefix(tt, CONTAINER_PREFIX);
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


/**
 * Copy out test auxillary support functions
 */

function createCopyOutFile(tt, remotefn, containerName, callback) {
    // Create a file and get a checksum of it
    var inside = [
        'dd if=/dev/urandom count=1024 bs=1024',
        'tee ' + remotefn,
        '/native/usr/bin/sum -x sha1'
    ].join('| \\\n');
    var args = sprintf('exec %s bash -c "%s"', containerName, inside);
    cli.docker(args, onDocker);

    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        callback(err, stdout.toString().trim());
    }
}


function copyFileOut(tt, remotefn, localfn, containerName, callback) {
    var args = sprintf(
        'cp "%s:%s" - | tar xOf - "%s"',
        containerName, remotefn, localfn);
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

function checkFileCopiedOut(tt, remotefn, hash, containerName, callback) {
    var args = sprintf('exec %s /native/usr/bin/sum -x sha1 %s',
                        containerName, remotefn);
    cli.docker(args, onDocker);
    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        var actHash = stdout.toString().trim().split(' ')[0];
        tt.equal(actHash, hash);
        callback();
    }
}


function createCopyInFile(tt, localfn, callback) {
    var hash;
    var cmd = sprintf(
        'dd if=/dev/urandom of=%s '
        + 'count=1024 bs=1024 >/dev/null && '
        + '/native/usr/bin/sum -x sha1 %s | awk "{ print $1 }"',
        localfn, localfn);
    cli.exec(cmd, function (err, stdout, stderr) {
        tt.ifErr(err);
        hash = stdout.toString();
        callback(err, hash);
    });
}


function copyFileIn(tt, localfn, remotefn, containerName, callback) {
    var args = sprintf('cp %s "%s:%s"', localfn, containerName, remotefn);
    var execOpts = { maxBuffer: 1024*1024*2, encoding: 'binary' };
    cli.docker(args, { execOpts: execOpts }, onDocker);
    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        callback(err);
    }
}

function checkFileCopiedIn(tt, remotefn, containerName, hash, callback) {
    var args =
        sprintf('exec %s /native/usr/bin/sum -x sha1 %s',
                containerName, remotefn);
    cli.docker(args, onDocker);
    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        tt.comment('sha1 before ' + hash);
        tt.comment('sha1 after ' + stdout.toString());
        tt.equal(stdout.toString().split(' ')[0], hash.split(' ')[0]);
        callback(err);
    }
}

function
copyFileOutGetContents(tt, remotefn, extractfn, containerName, callback) {
    var args = sprintf('cp "%s:%s" - | tar xOf - "%s"',
        containerName, remotefn, extractfn);
    var execOpts = { maxBuffer: 1024*1024+1, encoding: 'binary' };
    cli.docker(args, { execOpts: execOpts }, onDocker);
    function onDocker(err, stdout, stderr) {
        tt.ifErr(err);
        var str = stdout.toString().trim();

        callback(err, str);
    }
}
