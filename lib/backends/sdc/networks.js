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
var util = require('util');
var vasync = require('vasync');

var errors = require('../../errors');
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
function napiNetworkToDockerNetwork(network, opts, callback) {

    // TODO: Lookup 'Containers' that are using this network. Note that
    // `docker network ls` doesn't display these containers, it will be visible
    // in `docker network inspect foo`, though docker is sending the same JSON
    // data for both ls and inspect.

    var isNetworkPool = Array.isArray(network.networks);
    var scope;

    if (isNetworkPool) {
        scope = 'pool';
    } else if (network.fabric) {
        scope = 'overlay';
    } else {
        scope = 'external';
    }

    var result = {
        Driver: 'Triton',
        Id: utils.networkUuidToDockerId(network.uuid),
        IPAM: {
            Driver: 'default',
            Options: null
        },
        Name: network.name,
        Options: {},
        Scope: scope
    };

    // Note: Network pools don't have specific subnet or mtu details, just a
    // collection of network uuids that reside in the pool.
    if (isNetworkPool) {
        callback(null, result);
        return;
    }

    result.Config = [
        {
            Subnet: network.subnet,
            Gateway: network.gateway
        }
    ];
    if (network.mtu) {
        result.Options['com.docker.network.driver.mtu']
            = network.mtu.toString();
    }

    callback(null, result);
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
            pool.networks.forEach(function (network_uuid) {
                networksInPools[network_uuid] = true;
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


/**
 * Find the NAPI network from the given name or id.
 *
 * @param {String} name The name or id of the network to look for.
 * @param {Object} opts Accont and config options.
 * @param {Function} callback (err, network) Called with the found network.
 */
function findNetworkByNameOrId(name, opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.account.uuid, 'opts.account.uuid');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    // need to search on networks by: name, fabric-true, owner_uuid
    var log = opts.log;
    var napi = getNapiClient(opts.config.napi);

    // NOTE: the order of the functions in this parallel() call is significant;
    // they are ordered by how docker prefers to resolve IDs:
    // 1. exact id match
    // 2. exact name match
    // 3. partial id match
    vasync.parallel({
        funcs: [
            function byExactId(cb) {
                // length === 64, and 0..31 === 32..63, or it's an 'impossible'
                // id under our double-uuid convention, and we can skip it.
                if (name.substr(0, 32) !== name.substr(32)) {
                    log.debug({ name: name },
                        'Networks: impossible exactId: %s, skipping', name);
                    setImmediate(cb, null, []);
                    return;
                }
                var uuid = utils.shortNetworkIdToUuidPrefix(name);

                // XXX - ldapEscape required to work around NAPI-367
                var listParams = {
                    uuid: utils.ldapEscape(uuid),
                    provisionable_by: opts.account.uuid
                };

                napi.listNetworks(listParams,
                    { headers: { 'x-request-id': opts.req_id }}, cb);
            },
            function byName(cb) {
                var listParams = {
                    name: name,
                    provisionable_by: opts.account.uuid
                };

                log.debug({ listParams: listParams },
                    util.format('Networks: searching for network %s',
                        listParams.name));

                napi.listNetworks(listParams,
                    { headers: {'x-request-id': opts.req_id }}, cb);
            },
            function byDockerId(cb) {
                // we assume the 'double uuid' convention for networks here,
                // that is, dockerId = (uuid + uuid).replace(/-/g, '').
                // So if we have a name.length > 31, 32... must be a prefix of
                // 0..31. If not, the id supplied is impossible in our system.
                if (name.length >= 32) {
                    // this must be a prefix of the first half of the input
                    var secondHalf = name.substr(32);
                    var firstHalf = name.substr(0, 31);

                    if (secondHalf.length >= firstHalf.length
                        || secondHalf !==
                        firstHalf.substr(0, secondHalf.length)) {

                        log.info({ name: name },
                            'Networks: impossible network id %s, skipping',
                            name);
                        setImmediate(cb, null, []);
                        return;
                    }
                }

                // To perform the search, we transform the provided name to
                // a (potentially partial) UUID, and perform a wildcard search
                // on it.
                // XXX - ldapEscape required to work around NAPI-367
                var uuidSearchStr = utils.ldapEscape(
                    utils.shortNetworkIdToUuidPrefix(name)) + '*';

                var listParams = {
                    uuid: uuidSearchStr,
                    provisionable_by: opts.account.uuid
                };

                log.debug({ listParams: listParams },
                    util.format('Networks: searching for network %s',
                        listParams.uuid));

                napi.listNetworks(listParams,
                    { headers: {'x-request-id': opts.req_id }}, cb);
            }
        ]
    }, function _listedNetworks(err, results) {
        // results.operations is ordered per the funcs array provided
        // to vasync.parallel (see vasync docs). We can tolerate partial
        // errors as long as they are lower in the preference chain.
        // IOW, we callback with the err/result of the most-preferred
        // search, and log any additional errors.
        var bestMatch = results.operations.reduce(function (acc, op) {
            if (acc.err || acc.result) {
                return acc;
            }
            if (op.err) {
                acc.err = op.err;
                return acc;
            }
            // all match funcs are listNetworks, contract is to return an
            // err (handled above) or array.
            switch (op.result.length) {
                case 0:
                    break;
                case 1:
                    acc.result = op.result[0];
                    break;
                default:
                    acc.err = new errors.AmbiguousDockerNetworkIdPrefixError(
                        name);
                    break;
            }
            return acc;
        }, { err: null, result: null });

        if (bestMatch.err) {
            // found an error before a result.
            log.error({ err: bestMatch.err, name: name },
                util.format('Networks: Error finding network to match %s',
                    name));
            callback(bestMatch.err);
            return;
        }

        if (!bestMatch.err && !bestMatch.result) {
            log.info({ name: name, user: opts.account.uuid },
                util.format('Networks: no results for name %s', name));
            callback(new errors.NetworkNotFoundError(name));
            return;
        }

        if (!bestMatch.err && err) {
            // found result before an error, but did have errs.
            log.warn({ err: err },
                'Networks: non-critical error searching NAPI');
        }

        log.debug({ network: bestMatch.result }, 'Networks: chose %s/%s',
            bestMatch.result.name, bestMatch.result.uuid);

        callback(null, bestMatch.result);
    });
}


module.exports = {
    findNetworkByNameOrId: findNetworkByNameOrId,
    listNetworks: listNetworks
};
