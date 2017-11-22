/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

//
// Summary:
//
// These tests were added for DOCKER-1021 and ensure that when provisioning
// fails for a volapi storage VM, we get an error message from sdc-docker rather
// than a message telling us the creation was successful. We "break"
// provisioning for the 10g package by setting at trait which no CNs will have.
// The provision will then fail at the workflow job when we're trying to
// allocate a CN.
//
// In the future, when we have a better mechanism for forcing a provision to
// fail, we should use that so we don't impact other tests that might run in
// parallel.
//

var assert = require('assert-plus');
var common = require('../lib/common');
var mod_testVolumes = require('../lib/volumes');

var cli = require('../lib/cli');
var h = require('./helpers');
var volumesCli = require('../lib/volumes-cli');

var createTestVolume = mod_testVolumes.createTestVolume;
var test = mod_testVolumes.createTestFunc({
    checkTritonSupportsNfsVols: true,
    checkDockerClientSupportsNfsVols: true
});

var NFS_SHARED_VOLUME_NAMES_PREFIX =
    mod_testVolumes.getNfsSharedVolumesNamePrefix();

var ALICE_USER;
var PAPI;
var PAPI_PACKAGE;
var PAPI_ORIGINAL_TRAITS;

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, function onCliInit(err, env) {
            t.ifErr(err, 'Docker environment initialization should not err');
            if (env) {
                ALICE_USER = env.user;
            }
        });
    });

    tt.test('setup PAPI client', function (t) {
        h.createPapiClient(function (err, _papi) {
            t.ifErr(err, 'create PAPI client');
            PAPI = _papi;
            t.end();
        });
    });

    tt.test('getting 10g PAPI package', function (t) {
        PAPI.list('(&(name=sdc_volume_nfs_10)(active=true))',
            {},
            function _onResults(err, pkgs, count) {
                t.ifErr(err, 'get PAPI package');

                // Ensure that if there are multiple results, the output
                // includes the list of uuids so we can investigate, hence
                // the pkgs.map() here when pkgs is defined.
                t.equal(count, 1, 'should be 1 result '
                    + JSON.stringify(pkgs ? pkgs.map(function mapUuids(pkg) {
                        return pkg.uuid;
                    }) : []));

                if (count === 1 && pkgs && pkgs.length === 1) {
                    PAPI_PACKAGE = pkgs[0].uuid;
                    PAPI_ORIGINAL_TRAITS = pkgs[0].traits;
                }
                t.end();
            }
        );
    });

    tt.test('breaking provisioning w/ 10g package', function (t) {
        PAPI.update(PAPI_PACKAGE, {traits: {broken_by_docker_tests: true}}, {},
            function onUpdated(err) {
                t.ifErr(err, 'update PAPI setting broken traits');
                t.end();
            }
        );
    });
});

test('Volume creation should fail when provision fails', function (tt) {
    var testVolumeName =
        common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);

    tt.test('creating volume ' + testVolumeName + ' should fail with '
        + 'appropriate error message',
        function (t) {
            volumesCli.createTestVolume(ALICE_USER, {
                size: '10G',
                name: testVolumeName
            }, function volumeCreated(err, stdout, stderr) {
                var expectedErr = 'Error response from daemon: (InternalError) '
                    + 'volume creation failed';
                var matches;

                // Make a RegExp from the expectedErr but we need to escape the
                // '(' and ')' characters to '\(' and '\)' so that the regex
                // will not treat that as a grouping.
                var re = new RegExp(expectedErr.replace(/[()]/g, '\\$&'));

                matches = stderr.match(re);

                t.ok(err, 'volume creation should not succeed');
                // with this, we get the actual error message if it fails
                t.equal((matches ? matches[0] : stderr), expectedErr,
                    'expected InternalError');

                t.end();
            });
        }
    );
});

test('teardown', function (tt) {
    tt.test('un-breaking provisioning w/ 10g package', function (t) {
        var newTraits = {};

        if (PAPI_ORIGINAL_TRAITS) {
            newTraits = PAPI_ORIGINAL_TRAITS;
        }

        PAPI.update(PAPI_PACKAGE, {traits: newTraits}, {},
            function onUpdated(err) {
                t.ifErr(err, 'update PAPI setting original traits: '
                    + JSON.stringify(newTraits));
                t.end();
            }
        );
    });
});
