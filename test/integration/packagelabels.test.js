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
var vm = require('../lib/vm');
var test = require('tape');
var vasync = require('vasync');



// --- Globals

var IMAGE_NAME = 'busybox';

var containers = {};
var packageA;
var packageB;



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
    var papi;

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
                var expectedContainers = [];
                var foundContainers = [];

                if (err) {
                    cb(err);
                    return;
                }

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

test('teardown', cli.rmAllCreated);
