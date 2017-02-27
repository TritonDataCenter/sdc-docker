/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for docker labels.
 */

var h = require('./helpers');
var cli = require('../lib/cli');
var common = require('../../lib/common');
var fs = require('fs');
var libuuid = require('libuuid');
var vm = require('../lib/vm');
var test = require('tape');
var vasync = require('vasync');



// --- Globals

var IMAGE_NAME = 'busybox';
var CONTAINER_PREFIX = 'sdcdockertest_packagelabels_';

var cliVersion = process.env.DOCKER_CLI_VERSION;
var containers = {};
var opts = {};
var packageA;
var packageB;
var packageC;
var papi;


// --- Disable these tests if too old

if (cliVersion) {
    /*
     * We don't emit content to stdout because strict TAP parsing must
     * see the "TAP version 13" line of output before "# comments ...".
     * Eventually <https://github.com/substack/tape/pull/197> would allow
     * `opts.skip` to be a string reason included in the TAP output.
     */
    cliVersion = cliVersion.split('.')[0] + '.' + cliVersion.split('.')[1];
    if (common.apiVersionCmp(cliVersion, 1.8) < 0) {
        opts.skip = true;
    }
}


// --- Tests

test('note if we are skipping due to old CLI version', function (tt) {
    if (opts.skip) {
        tt.comment('skipping tests because CLI version is < 1.8: it is '
            + process.env.DOCKER_CLI_VERSION);
    }
    tt.end();
});

test('setup docker environment/cli', opts, function (tt) {
    h.createPapiClient(function (err, _papi) {
        tt.ifErr(err, 'create PAPI client');
        papi = _papi;
        tt.test('DockerEnv: alice init', cli.init);
        tt.end();
    });
});

test('find packages for test', opts, function (tt) {
    h.getSortedPackages(function (err, pkgs) {
        tt.ifErr(err, 'getSortedPackages');
        tt.ok(pkgs.length >= 2, 'need at least 2 packages, got ' + pkgs.length);

        packageA = pkgs[1]; // 2nd smallest
        packageB = pkgs[0]; // smallest

        tt.ok(packageA.name, 'packageA: ' + packageA.name);
        tt.ok(packageB.name, 'packageB: ' + packageB.name);

        tt.end();
    });
});

/*
 * We create a package with a made-up owner so that we know that this should not
 * be provisionable by our test user. Later on we'll attempt to provision with
 * it which should fail.
 */
test('create package with bogus owner', opts, function (tt) {
    papi.add({
        active: true,
        cpu_cap: 100,
        default: false,
        max_lwps: 1000,
        max_physical_memory: 64,
        max_swap: 128,
        name: 'docker-test-packageC',
        owner_uuids: [libuuid.create()],
        quota: 10240,
        uuid: libuuid.create(),
        version: '42.0.0',
        zfs_io_priority: 100
    }, {}, function _papiAddCb(err, pkg) {
        tt.ifError(err, 'create packageC' + (err ? '' : ' ' + pkg.uuid));
        if (!err) {
            packageC = pkg;
        }
        tt.end();
    });
});

test('create test containers', opts, function (tt) {
    var vms = [ {
        name: CONTAINER_PREFIX + 'pkgA_byname',
        pkgLabel: '--label com.joyent.package=' + packageA.name,
        packageName: packageA.name
    }, {
        name: CONTAINER_PREFIX + 'pkgA_byuuid',
        pkgLabel: '--label com.joyent.package=' + packageA.uuid,
        packageName: packageA.name
    }, {
        name: CONTAINER_PREFIX + 'pkgA_byshort',
        pkgLabel: '--label com.joyent.package=' + packageA.uuid.substr(0, 8),
        packageName: packageA.name
    }, {
        name: CONTAINER_PREFIX + 'pkgB_byuuid',
        pkgLabel: '--label com.joyent.package=' + packageB.uuid,
        packageName: packageB.name
    }];

    vasync.forEachPipeline({
        inputs: vms,
        func: function _createContainer(vmspec, cb) {
            var cmdline = '--name ' + vmspec.name + ' ' + vmspec.pkgLabel
                + ' ' + IMAGE_NAME + ' sleep 3600';

            cli.create(tt, {args: cmdline}, function (err, id) {
                tt.ifErr(err, 'expect no error for create');
                if (!err) {
                    tt.ok(true, 'created ' + id);
                    containers[vmspec.name] = {
                        dockerId: id,
                        packageName: vmspec.packageName
                    };
                }
                cb(err);
            });
        }
    }, function _createdContainers(err) {
        tt.ifError(err, 'created containers');
        tt.end();
    });
});

test('inspect test containers', opts, function (tt) {
    vasync.forEachPipeline({
        inputs: Object.keys(containers),
        func: function _inspectContainer(cname, cb) {
            var container = containers[cname];

            cli.inspect(tt, {
                id: container.dockerId,
                compareMessage: 'expect label com.joyent.package='
                    + container.packageName,
                partialExp: {
                    Config: {
                        Labels: {'com.joyent.package': container.packageName}
                    }
                }
            }, cb);
        }
    }, function _inspectedContainers(err) {
        tt.ifError(err, 'inspected containers');
        tt.end();
    });
});

test('test ps filtering on package', opts, function (tt) {
    var expectedResults = {};

    // for each key in expectedResults, we'll check that all the containers with
    // packageName === value are in the ps output when we filter on that label.
    //
    // So when we say:
    //
    //     expectedResults[packageA.uuid] = packageA.name;
    //
    // it means that when we do:
    //
    //     docker ps --filter=label=com.joyent.package=<packageA.uuid>
    //
    // that all the containers which have packageA.name as their packageName
    // should be in the output.
    expectedResults[packageA.name] = packageA.name;
    expectedResults[packageA.uuid] = packageA.name;
    expectedResults[packageA.uuid.substr(0, 8)] = packageA.name;
    expectedResults[packageB.name] = packageB.name;
    expectedResults[packageB.uuid] = packageB.name;
    expectedResults[packageB.uuid.substr(0, 8)] = packageB.name;

    vasync.forEachPipeline({
        inputs: Object.keys(expectedResults),
        func: function _performFilteredPs(pkg, cb) {
            var argstring = '--filter "label=com.joyent.package=' + pkg + '"'
                + ' --all';

            cli.ps(tt, {
                args: argstring
            }, function (err, entries) {
                var createdContainers = [];
                var expectedContainers = [];
                var foundContainers = [];

                if (err) {
                    cb(err);
                    return;
                }

                createdContainers = Object.keys(containers).map(function (k) {
                    return containers[k].dockerId.substr(0, 12);
                });

                expectedContainers = Object.keys(containers).map(function (k) {
                    // first we make an array of the *values*
                    // container: "[pkgA_byname] [object Object]"
                    return (containers[k]);
                }).filter(function (container) {
                    // then we filter out those that don't have the package
                    // we're looking for.
                    if (container.packageName === expectedResults[pkg]) {
                        return true;
                    }
                    return false;
                }).map(function (container) {
                    // then we turn into array of just shortened Ids
                    return container.dockerId.substr(0, 12);
                }).sort();

                foundContainers = entries.map(function (entry) {
                    // map the entries we found to an array of short Ids
                    return entry.container_id;
                }).filter(function (container) {
                    // filter out those we didn't create
                    if (createdContainers.indexOf(container) !== -1) {
                        return true;
                    }
                    return false;
                }).sort();

                tt.deepEqual(foundContainers, expectedContainers, 'should only '
                    + 'see containers with package ' + expectedResults[pkg]);

                cb();
            });
        }
    }, function _performedFilteredPs(err) {
        tt.ifError(err, 'performed filtered ps tests');
        tt.end();
    });
});

test('test creation w/ invalid package names', opts, function (tt) {
    var invalidPrefix = 'Error response from daemon: invalid value for '
        + 'com.joyent.package: ';
    var labels = [];
    var nonexistErr = 'Error response from daemon: no packages match '
        + 'parameters';

    labels = [
        {
            name: '_bacon', // leading underscore invalid
            errPrefix: invalidPrefix
        }, {
            name: 'bacon-', // trailing '-' is invalid
            errPrefix: invalidPrefix
        }, {
            name: 'bacon!', // '!' is invalid
            errPrefix: invalidPrefix
        }, {
            name: '💩', // non-ASCII should not be allowed
            errPrefix: invalidPrefix
        }, {
            name: '	', // tabs -- like poo -- are not allowed
            errPrefix: invalidPrefix
        }, {
            name: '.', // can't start or end with '.'
            errPrefix: invalidPrefix
        }, {
            name: '', // empty name should be invalid
            errPrefix: invalidPrefix
        }, {
            name: 'hello--world', // consecutive '-' not allowed
            errPrefix: invalidPrefix
        }, {
            name: 'package-that-does-not-exist',
            errString: nonexistErr
        }
    ];

    vasync.forEachPipeline({
        inputs: labels,
        func: function _createContainer(label, cb) {
            var cmdline = '--label com.joyent.package="' + label.name + '" '
                + IMAGE_NAME + ' sleep 3600';

            cli.create(tt, {
                args: cmdline,
                expectedErr: (
                    label.errString
                    ? label.errString
                    : label.errPrefix + label.name
                )
            }, function (err, id) {
                tt.ok(err, 'expected error for create');
                cb();
            });
        }
    }, function _createdContainers(err) {
        tt.ifError(err, 'tried to create containers');
        tt.end();
    });
});

test('test lookup w/ invalid package names', opts, function (tt) {
    var labels = [
        '_bacon', // leading underscore invalid
        'bacon-', // trailing '-' is invalid
        'bacon!', // '!' is invalid
        '💩', // non-ASCII should not be allowed
        '.', // can't start or end with '.'
        'hello--world' // consecutive '-' not allowed
    ];

    vasync.forEachPipeline({
        inputs: labels,
        func: function _lookupContainer(label, cb) {
            var argstring = '--format "{{.ID}}:\t{{.Labels}}" '
                + '--filter "label=com.joyent.package=' + label + '" '
                + ' --all';

            cli.ps(tt, {
                args: argstring,
                expectedErr: 'Error response from daemon: invalid value for '
                    + 'com.joyent.package: ' + label
            }, function (err, entries) {
                tt.ok(err, 'expected error for ps (' + label + ')');
                tt.equal(entries, undefined, 'expected no entries in output');
                cb();
            });
        }
    }, function _lookedupContainers(err) {
        tt.ifError(err, 'tried to lookup containers w/ filter');
        tt.end();
    });
});

/*
 * packageC we created with a random owner, so we shouldn't be able to provision
 * with it because that random owner is not us.
 */
test('test creation w/ non-owned package', opts, function (tt) {
    var cmdline;

    if (!packageC || !packageC.uuid) {
        tt.ok(false, 'packageC was not created, cannot provision');
        tt.end();
        return;
    }

    cmdline = '--label com.joyent.package="' + packageC.uuid + '" '
        + IMAGE_NAME + ' sleep 3600';

    cli.create(tt, {
        args: cmdline,
        expectedErr: 'Error response from daemon: no packages match parameters'
    }, function (err, id) {
        tt.ok(err, 'expected error for create');
        tt.end();
    });
});

/*
 * When a VM is created with 2 labels, the second will take precendence and a VM
 * should be created with that package.
 */
test('test creation w/ two package labels', opts, function (tt) {
    var cmdline;

    cmdline = '--label com.joyent.package="' + packageA.uuid + '" '
        + '--label com.joyent.package="' + packageB.uuid + '" '
        + IMAGE_NAME + ' sleep 3600';

    cli.create(tt, {args: cmdline}, function (err, id) {
        var argstring = '--filter "label=com.joyent.package=' + packageB.name
            + '" --all --format '
            + '\"{{.ID}},{{.Label \\\"com.joyent.package\\\"}}\"';
        var shortId;

        tt.ifErr(err, 'expect no error for create');

        if (!err) {
            tt.ok(true, 'created ' + id);
            shortId = id.substr(0, 12);

            // Need to ensure that this got the right package (packageB)
            // This also ensures that the container list via `docker ps` is
            // including the package name correctly.
            cli.ps(tt, {
                args: argstring,
                linesOnly: true
            }, function (e, entries) {
                var wrongPackages = [];

                tt.ifError(e, 'list containers after creation');
                tt.ok(entries.indexOf(shortId + ',' + packageB.name) !== -1,
                    '`docker ps` shows ' + shortId + ' with packageB');
                entries.forEach(function _checkEachPkg(entry) {
                    if (entry.split(',')[1] !== packageB.name) {
                        wrongPackages.push(entry);
                    }
                });
                tt.deepEqual(wrongPackages, [], 'expected all packages to be '
                    + packageB.name);
                tt.end();
            });
        } else {
            tt.end();
        }
    });
});

test('teardown', opts, function (tt) {
    // cleanup the package we created
    vasync.pipeline({funcs: [
        function _rmCreatedPackages(_, cb) {
            if (!packageC || !packageC.uuid) {
                tt.ok(true, 'no packageC to delete');
                cb();
                return;
            }
            papi.del(packageC.uuid, {force: true}, function _papiDelCb(err) {
                tt.ifError(err, 'papi delete packageC');
                cb();
            });
        }, function _rmCreatedContainers(_, cb) {
            // this must come last in the 'funcs' because it ends the test on us
            cli.rmAllCreated(tt);
            cb();
        }
    ]}, function _teardownComplete() {
        // cli.rmAllCreated() ends our test, so nothing more to do
        return;
    });
});
