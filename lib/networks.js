/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var NAPI = require('sdc-clients').NAPI;

var errors = require('./errors');

/**
 * List networks in NAPI, filtering by params
 */
function listNetworks(opts, params, callback) {
    var napi = new NAPI(opts.config.napi);

    napi.listNetworks(params, {headers: {'x-request-id': opts.req_id}},
        callback);
}

/**
 * Add the user's default fabric network to the payload.  If they've specified
 * ports to publish, add an external network as well.
 */
function addFabricNetworksToPayload(opts, payload, callback) {
    assert.object(opts, 'opts');
    assert.object(payload, 'payload');
    assert.func(callback, 'callback');

    var dc = opts.app.config.datacenterName;
    var log = opts.log;
    var requireExternal = false;

    if (opts.fabricRequireExternal) {
        requireExternal = true;
    }

    opts.app.ufds.getDcLocalConfig(opts.account.uuid, dc, function (err, conf) {
        log.debug({err: err, conf: conf, account: opts.account.uuid},
            'get DC local config');

        if (err || !conf || !conf.defaultnetwork) {
            callback(errors.ufdsErrorWrap(err,
                'could not get default network'));
            return;
        }

        payload.networks = [ {uuid: conf.defaultnetwork} ];

        if (requireExternal) {
            payload.networks.push({uuid: opts.config.overlay.externalPool});
        }

        payload.networks[payload.networks.length - 1].primary = true;
        return callback();
    });
}

/**
 * Add networks to the payload: 'external' if no fabrics are enabled.  If
 * fabrics are enabled, then add the user's default fabric network.  If
 * fabrics are enabled and the container is publishing ports, also add the
 * NAT pool as a public-facing network.
 */
function addNetworksToPayload(opts, payload, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.object(payload, 'payload');
    assert.func(callback, 'callback');

    if (opts.config.overlay.enabled) {
        opts.log.debug('Fabrics configured: using for networking');
        return addFabricNetworksToPayload(opts, payload, callback);
    }

    var log = opts.log;
    log.debug('Fabrics not configured: using external network');

    // No fabrics configured - fall back to provisioning on the external
    // network

    var netName = opts.config.externalNetwork || 'external';
    listNetworks(opts, {name: netName}, function (err, networks) {
        var external_net;
        log.debug({err: err, res: networks}, 'list external networks');

        if (err) {
            callback(errors.napiErrorWrap(err, 'problem listing networks'));
            return;
        }

        networks.forEach(function (n) {
            if (!external_net
                && n.name === netName) {

                external_net = n.uuid;
            }
        });

        if (!external_net) {
            callback(new errors.DockerError(
                'unable to find "'+netName+'" network uuid'));
            return;
        }

        payload.networks = [ {uuid: external_net, primary: true} ];
        return callback();
    });
}

module.exports = {
    addNetworksToPayload: addNetworksToPayload
};