/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var vasync = require('vasync');

var errors = require('../../errors');
var networks = require('../../networks');

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
    vasync.pipeline({
        funcs: [
            function setupNetwork(ctx, done) {
                networks.addNetworksToPayload({
                    config: self.config,
                    account: options.account,
                    app: options.app,
                    log: log,
                    reqId: options.reqId
                }, payload, done);
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
                        done();
                    });
            }
        ],
        arg: context
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

    volapiClient.listVolumes(params, {headers: {'x-request-id': options.reqId}},
        function onVolumesListed(err, volumes) {
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
    assert.string(params.uuid, 'params.uuid');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var log = options.log;
    var volapiClient = options.app.volapi;

    params.owner_uuid = options.account.uuid;

    volapiClient.deleteVolume(params, {
            headers: {'x-request-id': options.reqId}
        }, function onVolumeDeleted(err) {
            log.debug({err: err}, 'Response from volapi.deleteVolume');
            if (err) {
                callback(errors.volapiErrorWrap(err,
                    'problem deleting volume'));
                return;
            }

            callback();
        });
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

            if (!volumes || volumes.length === 0) {
                err = new Error('Could not find volume with name: '
                    + params.name);
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
