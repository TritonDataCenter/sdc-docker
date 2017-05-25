/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var vasync = require('vasync');
var verror = require('verror');

var errors = require('../../errors');
var mod_networks = require('./networks');

/*
 * This function polls VOLAPI for the volume specified by volumeUuid.
 *
 * It ignores any VOLAPI errors, and retries every second until either one of
 * the states (array of string states e.g. ['failed', 'ready']) is seen as the
 * volume's state, or until 100 attempts have been made.
 *
 * Calls callback(err, volume) with volume being the last-loaded state (if any)
 * and err being either an Error object or null.
 */
function pollVolumeState(volumeUuid, volapiClient, states, callback) {
    assert.uuid(volumeUuid, 'volumeUuid');
    assert.object(volapiClient, 'volapiClient');
    assert.arrayOfString(states, 'states');
    assert.func(callback, 'callback');

    var nbVolumeStatePolled = 0;
    var MAX_NB_VOLUME_STATE_POLLS = 100;
    var VOLUME_STATE_POLL_INTERVAL_IN_MS = 1000;

    function doPollVolumeStateChange() {
        ++nbVolumeStatePolled;

        volapiClient.getVolume({
            uuid: volumeUuid
        }, function onGetVolume(err, updatedVolume) {
            if (err && verror.hasCauseWithName(err, 'VOLUME_NOT_FOUNDError')) {
                // If the VM is not found, no use in polling further and we
                // return the error in case the caller wanted to know when the
                // volume disappeared.
                callback(err);
                return;
            }

            if (updatedVolume && states.indexOf(updatedVolume.state) !== -1) {
                callback(null, updatedVolume);
            } else {
                if (nbVolumeStatePolled > MAX_NB_VOLUME_STATE_POLLS) {
                    callback(new Error('Timed out polling for '
                        + 'volume state change'), updatedVolume);
                } else {
                    setTimeout(doPollVolumeStateChange,
                        VOLUME_STATE_POLL_INTERVAL_IN_MS);
                }
            }
        });
    }

    doPollVolumeStateChange();
}

function createVolume(volumeParams, options, callback) {
    assert.object(volumeParams, 'params');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.app, 'options.app');
    assert.func(callback, 'callback');

    var self = this;
    var log = options.log;
    var volapiClient = options.app.volapi;

    var payload = jsprim.deepCopy(volumeParams);
    payload.owner_uuid = options.account.uuid;

    log.debug({payload: volumeParams},
        'Sending request to VOLAPI for volume creation');

    var context = {};
    vasync.pipeline({funcs: [
        function setupNetwork(ctx, done) {
            var networkOpts = {
                config: self.config,
                account: options.account,
                app: options.app,
                log: log,
                req_id: options.reqId
            };

            if (payload.network === undefined) {
                mod_networks.getDefaultFabricNetwork(networkOpts,
                    function onGetDefaultFabricNet(getDefaultFabricNetErr,
                        defaultFabricNetwork) {
                        if (!getDefaultFabricNetErr) {
                            payload.networks = [defaultFabricNetwork];
                        }
                        done(getDefaultFabricNetErr);
                    });
            } else {
                mod_networks.getNamedNetwork(networkOpts, payload.network,
                    function onGetNamedNetwork(getNetworkErr, network) {
                        payload.networks = [network];
                        done(getNetworkErr);
                    });
            }
        },
        function doCreateVolume(ctx, done) {
            volapiClient.createVolume(payload, {
                headers: {'x-request-id': options.reqId}
            }, function onVolumeCreated(err, volume) {
                log.debug({err: err, volume: volume},
                    'Got response from VOLAPI');

                if (err) {
                    callback(errors.volapiErrorWrap(err,
                        'problem creating volume'));
                    return;
                }

                ctx.volume = volume;
                pollVolumeState(volume.uuid, volapiClient,
                    ['ready', 'failed'],
                    function _onPollComplete(pollErr, vol) {
                        var createErr = pollErr;

                        if (!pollErr && vol && vol.state === 'failed') {
                            createErr = new errors.InternalError(
                                'volume creation failed');
                        }

                        ctx.volume = vol;
                        done(createErr);
                    }
                );
            });
        }
    ], arg: context
    }, function allDone(err) {
        callback(err, context.volume);
    });
}

function listVolumes(params, options, callback) {
    assert.object(params, 'params');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var log = options.log;
    var volapiClient = options.app.volapi;

    params.owner_uuid = options.account.uuid;
    params.predicate = JSON.stringify({
        eq: ['state', 'ready']
    });

    volapiClient.listVolumes(params, {
        headers: {
            'x-request-id': options.reqId
        }
    }, function onVolumesListed(err, volumes) {
        log.debug({err: err, volumes: volumes},
            'Response from volapi ListVolumes');
        if (err) {
            callback(errors.volapiErrorWrap(err,
                'problem listing volumes'));
            return;
        }

        callback(null, volumes);
    });
}

function deleteVolume(params, options, callback) {
    assert.object(params, 'params');
    assert.string(params.name, 'params.name');
    assert.object(options, 'options');
    assert.object(options.account, 'options.account');
    assert.uuid(options.account.uuid, 'options.account.uuid');
    assert.func(callback, 'callback');

    var log = options.log;
    var volapiClient = options.app.volapi;

    var volumeName = params.name;
    var volumeOwnerUuid = options.account.uuid;

    var context = {};

    vasync.pipeline({funcs: [
        function _findVolumeByName(ctx, next) {
            var volumeReadyPredicate = {
                eq: ['state', 'ready']
            };

            var listVolumesParams = {
                name: volumeName,
                owner_uuid: volumeOwnerUuid,
                predicate: JSON.stringify(volumeReadyPredicate)
            };

            volapiClient.listVolumes(listVolumesParams, {
                headers: {'x-request-id': options.reqId}
            }, function volumesListed(volumesListErr, volumes) {
                var err;

                if (!volumesListErr && volumes) {
                    if (volumes.length === 0) {
                        err = new errors.DockerError('Could not find volume '
                            + 'with name: ' + params.name);
                    } else if (volumes.length !== 1) {
                        err = new errors.DockerError('More than one volume '
                            + 'with name: ' + params.name);
                    } else {
                        ctx.volumeToDeleteUuid = volumes[0].uuid;
                    }
                }

                next(err);
            });
        },
        function _deleteVolume(ctx, next) {
            assert.uuid(ctx.volumeToDeleteUuid, 'ctx.volumeToDeleteUuid');

            var volumeUuid = ctx.volumeToDeleteUuid;

            var deleteVolumeParams = {
                uuid: volumeUuid,
                owner_uuid: volumeOwnerUuid
            };

            volapiClient.deleteVolume(deleteVolumeParams, {
                headers: {'x-request-id': options.reqId}
            }, function onVolumeDeleted(volumeDeletionErr) {
                var err;

                log.debug({err: volumeDeletionErr},
                    'Response from volapi.deleteVolume');

                if (volumeDeletionErr) {
                    err = errors.volapiErrorWrap(volumeDeletionErr,
                        'problem deleting volume');
                    next(err);
                    return;
                }

                pollVolumeState(volumeUuid, volapiClient, ['failed'],
                    function _onPollComplete(pollErr, vol) {
                        var deleteErr = pollErr;

                        if (pollErr && verror.hasCauseWithName(pollErr,
                            'VOLUME_NOT_FOUNDError')) {
                            // The volume disappeared, which is what we wanted,
                            // so nothing further to do.
                            next();
                            return;
                        }

                        if (!pollErr && vol && vol.state === 'failed') {
                            deleteErr = new errors.InternalError(
                                'volume deletion failed');
                        }

                        next(deleteErr);
                    }
                );
            });
        }
    ],
    arg: context
    }, callback);
}

function inspectVolume(params, options, callback) {
    assert.object(params, 'params');
    assert.string(params.name, 'params.name');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var err;
    var log = options.log;
    var volapiClient = options.app.volapi;

    params.owner_uuid = options.account.uuid;

    volapiClient.listVolumes(params, {headers: {'x-request-id': options.reqId}},
        function onVolume(volapiErr, volumes) {
            var volume = volumes[0];

            log.debug({err: err}, 'Response from volapi.getVolume');

            if (volapiErr) {
                err = errors.volapiErrorWrap(volapiErr,
                    'problem getting volume');
            }

            callback(err, volume);
        });
}

module.exports = {
    createVolume: createVolume,
    listVolumes: listVolumes,
    deleteVolume: deleteVolume,
    inspectVolume: inspectVolume
};
