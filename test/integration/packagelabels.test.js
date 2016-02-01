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
var fs = require('fs');
var libuuid = require('libuuid');
var vm = require('../lib/vm');
var test = require('tape');
var vasync = require('vasync');



// --- Globals

var IMAGE_NAME = 'busybox';

var containers = {};
var packageA;
var packageB;
var packageC;
var papi;



// --- Tests


test('setup docker environment/cli', function (tt) {
    tt.test('DockerEnv: alice init', cli.init);
});

/*
 * Because of the disaster we have with cpu_cap and no-cpu_cap packages, we
 * can't just create our own packages and expect anything to work. So we'll pull
 * out the packagePrefix then pick the smallest 2 packages that match that for
 * use when testing here.
 */
test('find packages for test', function (tt) {
    var configFile = __dirname + '/../../etc/config.json';
    var packagePrefix;

    packagePrefix = JSON.parse(fs.readFileSync(configFile)).packagePrefix;

    tt.ok(packagePrefix, 'found packagePrefix: ' + packagePrefix);

    vasync.pipeline({funcs: [
        function _createPapiClient(_, cb) {
            h.createPapiClient(function (err, _papi) {
                tt.ifErr(err, 'create PAPI client');
                papi = _papi;
                cb(err);
            });
        }, function _getPackages(_, cb) {
            papi.list('name=' + packagePrefix + '*', {}, function (err, pkgs) {
                var cleanedPkgs;

                tt.ifError(err, 'list packages');

                if (err) {
                    cb(err);
                    return;
                }

                cleanedPkgs = pkgs.filter(function _filterPkgs(pkg) {
                    return (Boolean(pkg.active));
                }).sort(function _cmpPkgMemory(a, b) {
                    return (a.max_physical_memory - b.max_physical_memory);
                });

                tt.ok(cleanedPkgs.length >= 2, 'need at least 2 packages, have '
                    + cleanedPkgs.length);

                packageA = cleanedPkgs[1]; // 2nd smallest
                packageB = cleanedPkgs[0]; // smallest

                tt.ok(packageA.name, 'packageA: ' + packageA.name);
                tt.ok(packageB.name, 'packageB: ' + packageB.name);

                cb();
            });
        }
    ]}, function _afterPkgPipeline(err) {
        tt.ifError(err, 'found packages');
        tt.end();
    });
});

/*
 * We create a package with a made-up owner so that we know that this should not
 * be provisionable by our test user. Later on we'll attempt to provision with
 * it which should fail.
 */
test('create package with bogus owner', function (tt) {
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
        tt.ifError(err, 'create packageC' + (err ? '' : pkg.uuid));
        if (!err) {
            packageC = pkg;
        }
        tt.end();
    });
});

test('create test containers', function (tt) {
    var vms = [ {
        name: 'pkgA-byname',
        pkgLabel: '--label com.joyent.package=' + packageA.name,
        packageName: packageA.name
    }, {
        name: 'pkgA-byuuid',
        pkgLabel: '--label com.joyent.package=' + packageA.uuid,
        packageName: packageA.name
    }, {
        name: 'pkgA-byshort',
        pkgLabel: '--label com.joyent.package=' + packageA.uuid.substr(0, 8),
        packageName: packageA.name
    }, {
        name: 'pkgB-byuuid',
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

test('inspect test containers', function (tt) {
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

test('test ps filtering on package', function (tt) {
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
            var argstring = '--filter "label=com.joyent.package=' + pkg + '"';

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
                    // container: "[pkgA-byname] [object Object]"
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

test('test creation w/ invalid package names', function (tt) {
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
            name: '💩', // nope
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

test('test lookup w/ invalid package names', function (tt) {
    var labels = [
        '_bacon', // leading underscore invalid
        'bacon-', // trailing '-' is invalid
        'bacon!', // '!' is invalid
        '💩', // nope
        '.', // can't start or end with '.'
        'hello--world' // consecutive '-' not allowed
    ];

    vasync.forEachPipeline({
        inputs: labels,
        func: function _lookupContainer(label, cb) {
            var argstring = '--format "{{.ID}}:\t{{.Labels}}" '
                + '--filter "label=com.joyent.package=' + label + '"';

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
test('test creation w/ non-owned package', function (tt) {
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
test('test creation w/ two package labels', function (tt) {
    var cmdline;

    cmdline = '--label com.joyent.package="' + packageA.uuid + '" '
        + '--label com.joyent.package="' + packageB.uuid + '" '
        + IMAGE_NAME + ' sleep 3600';

    cli.create(tt, {args: cmdline}, function (err, id) {
        var argstring = '--filter "label=com.joyent.package=' + packageB.name
            + '" --format '
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

test('teardown', function (tt) {
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
