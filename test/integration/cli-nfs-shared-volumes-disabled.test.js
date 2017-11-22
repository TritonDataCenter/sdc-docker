/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Tests that clients get expected messages when NFS volumes disabled.
 */

var restify = require('restify');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var testVolumes = require('../lib/volumes');
var volumesCli = require('../lib/volumes-cli');

var disabled_nfs_volumes = false;

var errorMeansNFSSharedVolumeSupportDisabled =
    testVolumes.errorMeansNFSSharedVolumeSupportDisabled;

var test = testVolumes.createTestFunc({
    checkDockerClientSupportsNfsVols: true
});

var ALICE_USER;
var NFS_SHARED_VOLUME_NAMES_PREFIX =
    testVolumes.getNfsSharedVolumesNamePrefix();
var SAPI_CLIENT;
var SAPI_APP;
var STATE_RETRIES = 120;

// wait for /admin/config to have state either 'enabled' or 'disabled' for
// experimental_docker_nfs_shared_volumes
function waitForState(tt, state, callback) {
    var dockerAdminClient;
    var retries = STATE_RETRIES;

    tt.ok(process.env.DOCKER_ADMIN_URL, 'should have DOCKER_ADMIN_URL, got: '
        + JSON.stringify(process.env.DOCKER_ADMIN_URL));

    dockerAdminClient = restify.createJsonClient({
        url: process.env.DOCKER_ADMIN_URL
    });

    function checkState() {
        dockerAdminClient.get('/admin/config',
            function onConfig(err, req, res, cfg) {
                var enabled;

                if (!err && cfg) {
                    if (cfg.experimental_docker_nfs_shared_volumes === true) {
                        enabled = true;
                    } else {
                        enabled = false;
                    }
                }

                retries--;

                if (!err && state === 'enabled' && enabled) {
                    tt.comment('saw "enabled" after '
                        + (STATE_RETRIES - retries) + ' seconds');
                    callback(null, 'enabled');
                    return;
                } else if (!err && state === 'disabled' && !enabled) {
                    tt.comment('saw "disabled" after '
                        + (STATE_RETRIES - retries) + ' seconds');
                    callback(null, 'disabled');
                    return;
                }

                if (retries <= 0) {
                    callback(new Error('Timed out waiting for NFS volumes to be'
                        + ' ' + state));
                    return;
                }

                // try again
                setTimeout(checkState, 1000);
            });
    }

    checkState();
}

test('setup', function (tt) {
    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, function onCliInit(err, env) {
            t.ifErr(err, 'Docker environment initialization should not err');
            if (env) {
                ALICE_USER = env.user;
            }
        });
    });

    // Ensure the busybox image is around.
    tt.test('pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });

    tt.test('disable NFS volumes', function (t) {
        t.ok(process.env.SAPI_URL, 'have SAPI_URL ('
            + JSON.stringify(process.env.SAPI_URL) + ')');

        SAPI_CLIENT = restify.createJsonClient({
            url: process.env.SAPI_URL
        });

        SAPI_CLIENT.get('/applications?name=sdc',
            function onApp(err, req, res, appList) {
                var app;
                var nfsVolumeSupportKey =
                    'experimental_docker_nfs_shared_volumes';

                t.ifErr(err, 'should succeed to GET app from SAPI');
                t.ok(appList, 'should have an appList object');
                t.ok(Array.isArray(appList), 'appList should be an array');
                t.equal(appList.length, 1, 'should have one sdc app');

                app = appList[0];
                t.ok(app.uuid, 'app should have uuid, got: '
                    + JSON.stringify(app.uuid));
                SAPI_APP = app.uuid;
                t.ok(app.metadata, 'app should have metadata');
                if (app.metadata.hasOwnProperty(nfsVolumeSupportKey)) {
                    t.comment('current value of '
                        + 'experimental_docker_nfs_shared_volumes is: '
                        + app.metadata.experimental_docker_nfs_shared_volumes);
                }

                if (app.metadata.experimental_docker_nfs_shared_volumes ===
                    false) {
                    t.comment('NFS volumes support already disabled, no need '
                        + 'to turn it off');
                    t.end();
                    return;
                }

                SAPI_CLIENT.put('/applications/' + SAPI_APP, {
                    action: 'update',
                    metadata: {
                        experimental_docker_nfs_shared_volumes: false
                    }
                }, function onPut(sapiPutErr, sapiPutReq, sapiPutRes, obj) {
                    t.ifErr(sapiPutErr, 'should succeed to PUT app to SAPI');
                    t.equal(sapiPutRes.statusCode, 200, 'expected 200');

                    disabled_nfs_volumes = true;
                    waitForState(t, 'disabled',
                        function onDisabled(waitStateErr) {
                            t.ifErr(waitStateErr,
                                'expected state to be disabled');
                            t.end();
                        });
                });
            });
        });
});

test('test with NFS volumes disabled', function (tt) {
    var volumeName;

    tt.test(' create docker volume should fail', function (t) {
        volumeName = common.makeResourceName(NFS_SHARED_VOLUME_NAMES_PREFIX);

        volumesCli.createVolume({
            user: ALICE_USER,
            args: '--name ' + volumeName
        }, function onVolumeCreated(err, stdout, stderr) {
            t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr),
                'expected create to fail w/ volumes disabled');
            t.end();
        });
    });

    tt.test(' inspect docker volume should fail', function (t) {
        volumesCli.inspectVolume({
            user: ALICE_USER,
            args: volumeName
        }, function onInspect(err, stdout, stderr) {
            t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr),
                'expected inspect to fail w/ volumes disabled');
            t.end();
        });
    });

    tt.test(' listing volumes should fail', function (t) {
        volumesCli.listVolumes({
            user: ALICE_USER
        }, function onVolumesListed(err, stdout, stderr) {
            t.ok(errorMeansNFSSharedVolumeSupportDisabled(err, stderr),
                'expected list to fail w/ volumes disabled');
            t.end();
        });
    });
});

test('teardown', function (tt) {
    if (!disabled_nfs_volumes) {
        tt.ok(true, 'NFS volumes were already disabled, no need to re-enable');
        tt.end();
        return;
    }

    // re-enable NFS volumes if we disabled them
    SAPI_CLIENT.put('/applications/' + SAPI_APP, {
        action: 'update',
        metadata: {
            experimental_docker_nfs_shared_volumes: true
        }
    }, function onPut(sapiPutErr, req, res, obj) {
        tt.ifErr(sapiPutErr, 'should succeed to PUT app to SAPI');
        tt.equal(res.statusCode, 200, 'expected 200');

        waitForState(tt, 'enabled', function onEnabled(waitStateErr) {
            tt.ifErr(waitStateErr, 'expected state to be enabled');
            tt.end();
        });
    });
});
