/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Triton networks use a uuid as the identifier, whilst docker generally uses
 * a 64 character length string for the identifier. To make them compatible,
 * we double-up the Triton uuid and remove the dashes to create a 64-char id.
 */

var assert = require('assert-plus');
var NAPI = require('sdc-clients').NAPI;
var vasync = require('vasync');

var utils = require('./utils');

//---- globals

var ADMIN_NIC_TAG = 'admin';

var _napiClientCache; // set in `getNapiClient`


//---- internal support routines

function getNapiClient(config) {
    if (!_napiClientCache) {
        // intentionally global
        _napiClientCache = new NAPI(config);
    }
    return _napiClientCache;
}

// Convert the list of Triton networks into docker format.
//
// Example of docker network object:
//
// {
//    "Name": "bridge",
//    "Id": "f2de39df4171b0dc8...63041c0f34030aa3977566",
//    "Created": "2016-10-19T06:21:00.416543526Z",
//    "Scope": "local",
//    "Driver": "bridge",
//    "EnableIPv6": false,
//    "Internal": false,
//    "IPAM": {
//        "Driver": "default",
//        "Options": null,
//        "Config": [{
//                "Subnet": "172.17.0.0/16",
//                "Gateway": "172.17.0.1"
//        }]
//    },
//    "Containers": {
//        "39b69226f9d79f5fb...90bcc167065867": {
//            "EndpointID": "ed2419a97c1d995b4...36b80a7db8d98b442eda",
//            "MacAddress": "02:42:ac:11:00:02",
//            "IPv4Address": "172.17.0.2/16",
//            "IPv6Address": ""
//        }
//    },
//    "Options": {
//        "com.docker.network.bridge.default_bridge": "true",
//        "com.docker.network.bridge.enable_icc": "true",
//        "com.docker.network.bridge.enable_ip_masquerade": "true",
//        "com.docker.network.bridge.host_binding_ipv4": "0.0.0.0",
//        "com.docker.network.bridge.name": "docker0",
//        "com.docker.network.driver.mtu": "1500"
//    },
//    "Labels": null
// }
function napiNetworkToDockerNetwork(net, opts, callback) {

    // TODO: Lookup 'Containers' that are using this network. Note that
    // `docker network ls` doesn't display these containers, it will be visible
    // in `docker network inspect foo`, though docker is sending the same JSON
    // data for both ls and inspect.

    callback(null, {
        Driver: 'Triton',
        Id: utils.networkUuidToDockerId(net.uuid),
        IPAM: {
            Driver: 'default',
            Options: null,
            Config: [ {
                Subnet: net.subnet,
                Gateway: net.gateway
            } ]
        },
        Name: net.name,
        Options: {
            'com.docker.network.driver.mtu': net.mtu.toString()
        },
        Scope: net.fabric ? 'overlay' : 'external'
    });
}

/**
 * Return the networks that are provisionable by the given account.
 * This includes network pools, but not the networks that belong to a pool.
 *
 * Dev note: This is the same approach/code that CloudAPI uses.
 *
 * @param {Object} opts Options.
 * @param {Function} callback (err, networks) Array of NAPI network objects.
 */
function getNapiNetworksForAccount(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.reqId, 'opts.reqId');
    assert.uuid(opts.accountUuid, 'opts.accountUuid');

    var accountUuid = opts.accountUuid;
    var log = opts.log;
    var napi = getNapiClient(opts.config.napi);
    var reqOpts = {headers: {'x-request-id': opts.reqId}};

    function listNetworkPoolsCb(err, pools) {
        if (err) {
            callback(err);
            return;
        }

        var networks = [];
        var networksInPools = {};

        // Always skip admin network pools:
        pools = pools.filter(function (pool) {
            return (pool.nic_tag !== ADMIN_NIC_TAG);
        });

        // Add pools to the list of networks, track networks in the pool, as we
        // want to later filter out all networks that are in a pool.
        pools.forEach(function (pool) {
            networks.push(pool);
            pool.networks.forEach(function (net) {
                networksInPools[net.uuid] = true;
            });
        });

        function listNetworksCb(err2, nets) {
            if (err2) {
                callback(err2);
                return;
            }

            // Always skip admin networks, and don't add networks which are
            // already in contained pools:
            nets = nets.filter(function (net) {
                if (net.nic_tag === ADMIN_NIC_TAG) {
                    return false;
                }
                if (networksInPools[net.uuid]) {
                    return false;
                }
                return true;
            });

            networks = networks.concat(nets);

            log.debug({
                networks: networks
            }, 'getNapiNetworksForAccount');

            callback(null, networks);
        }

        napi.listNetworks({provisionable_by: accountUuid}, reqOpts,
            listNetworksCb);
    }

    napi.listNetworkPools({provisionable_by: accountUuid}, reqOpts,
        listNetworkPoolsCb);
}


/**
 * List networks available to the req account holder.
 *
 * @param {Object} opts Options.
 * @param {Function} callback (err, networks) Array of docker network objects.
 */
function listNetworks(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.req, 'opts.req');
    assert.object(opts.req.account, 'opts.req.account');
    assert.object(opts.req.app, 'opts.req.app');
    assert.object(opts.req.app.config, 'opts.req.app.config');
    assert.object(opts.req.log, 'opts.req.log');

    var req = opts.req;
    var reqId = req.getId();
    var log = req.log;
    var params = {
        accountUuid: req.account.uuid,
        config: req.app.config,
        log: log,
        reqId: reqId
    };

    function getNapiNetworksForAccountCb(err, networks) {
        if (err) {
            callback(err);
            return;
        }
        log.debug('listNetworks: %d networks found', networks.length);
        // Convert networks into the docker format.
        vasync.forEachParallel({
            inputs: networks,
            func: function (net, cb) {
                napiNetworkToDockerNetwork(net, opts, cb);
            }
        }, function (verr, results) {
            callback(verr, results && results.successes);
        });
    }

    getNapiNetworksForAccount(params, getNapiNetworksForAccountCb);
}


module.exports = {
    listNetworks: listNetworks
};
