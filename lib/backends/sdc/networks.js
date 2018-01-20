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

var containers = require('../../containers');
var errors = require('../../errors');
var utils = require('./utils');

//---- globals

var ADMIN_NIC_TAG = 'admin';

// Label name used to set the external (public) network for a container.
var TRITON_PUBLIC_NETWORK_LABEL = 'triton.network.public';

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
function listNetworksForAccount(opts, callback) {
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

        networks = req.app.plugins.filterListNetworks({
            account: req.account
        }, networks);

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
 * List networks available to the req account holder.
 *
 * @param {Object} opts Options.
 * @param {Function} callback (err, networks) Array of docker network objects.
 */
function inspectNetwork(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.req, 'opts.req');
    assert.object(opts.req.network, 'opts.req.network');
    assert.object(opts.req.app, 'opts.req.app');
    assert.object(opts.req.app.config, 'opts.req.app.config');
    assert.object(opts.req.log, 'opts.req.log');

    napiNetworkToDockerNetwork(opts.req.network, {}, callback);
}

function getNetworksOrPools(params, opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.object(params, 'params');
    assert.ok(params.name || params.uuid, 'params name or uuid');
    assert.object(opts.config, 'opts.config');
    var napi = getNapiClient(opts.config.napi);
    var headers = {headers: {'x-request-id': opts.req_id}};

    vasync.tryEach([
        function listNets(cb) {
            napi.listNetworks(params, headers, function (err, res) {
                if (res && res.length === 0) {
                    cb(new Error('Empty List'));
                } else {
                    if (err && err.statusCode !== 404) {
                        cb(null, {err: err});
                    } else {
                        cb(err, {res: res});
                    }
                }
            });
        },
        function listFiltNets(cb) {
            /*
             * This is our fallback in case we are talking to an older version
             * of NAPI that does not support matching UUIDs by prefix.
             */
            if (params.name) {
                /* Can't prefix search names */
                cb(new Error('Net name not found'));
                return;
            }
            var uuid = params.uuid;
            var uuidPref = uuid.substring(0, (uuid.length - 1));
            var sz = uuidPref.length;
            if (uuid[(uuid.length - 1)] !== '*') {
                cb(new Error('Must be prefix'));
                return;
            }
            var newParams = {provisionable_by: params.provisionable_by};
            napi.listNetworks(newParams, headers, function (err, res) {
                if (res && res.length === 0) {
                    cb(new Error('Empty List'));
                } else {
                    if (err && err.statusCode !== 404) {
                        cb(null, {err: err});
                        return;
                    }
                    var filtered = res.filter(function (p) {
                        return (uuidPref === p.uuid.substring(0, sz));
                    });
                    if (filtered.length > 0) {
                        cb(null, {res: filtered});
                    } else {
                        cb(new Error('Network not found'));
                    }
                }
            });
        },
        function listNetPools(cb) {
            napi.listNetworkPools(params, headers, function (err, res) {
                if (res && res.length === 0) {
                    cb(new Error('Empty List'));
                } else {
                    if (err && err.statusCode !== 404) {
                        cb(null, {err: err});
                    } else {
                        cb(err, {res: res});
                    }
                }
            });
        },
        function listFiltNetPools(cb) {
            /*
             * This is our fallback in case we are talking to an older version
             * of NAPI that does not support matching UUIDs by prefix.
             */
            if (params.name) {
                /* Can't prefix search names */
                cb(new Error('Net name not found'));
                return;
            }
            var uuid = params.uuid;
            var uuidPref = uuid.substring(0, (uuid.length - 1));
            var sz = uuidPref.length;
            if (uuid[(uuid.length - 1)] !== '*') {
                cb(new Error('Must be prefix'));
                return;
            }
            var newParams = {provisionable_by: params.provisionable_by};
            napi.listNetworkPools(newParams, headers, function (err, res) {
                if (res && res.length === 0) {
                    cb(new Error('Empty List'));
                } else {
                    if (err && err.statusCode !== 404) {
                        cb(null, {err: err});
                        return;
                    }
                    var filtered = res.filter(function (p) {
                        return (uuidPref === p.uuid.substring(0, sz));
                    });
                    if (filtered.length > 0) {
                        cb(null, {res: filtered});
                    } else {
                        cb(new Error('Network pool not found'));
                    }
                }
            });
        },
        function final(cb) {
            cb(null, {res: []});
        }
    ], function (err, res) {
        assert(res.err || res.res);

        var networks = res.res;
        if (networks) {
            networks = opts.app.plugins.filterGetNetworksOrPools({
                account: opts.account
            }, networks);
        }

        callback(res.err, networks);
    });
}

/**
 * Find the NAPI network from the given name or id.
 *
 * @param {String} name The name or id of the network to look for.
 * @param {Object} opts Account and config options.
 * @param {Function} callback (err, network) Called with the found network.
 */
function findNetworkOrPoolByNameOrId(name, opts, callback) {
    assert.string(name, 'name');
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.req_id, 'opts.req_id');
    assert.func(callback, 'callback');

    // need to search on networks by: name, fabric-true, owner_uuid
    var log = opts.log;

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

                getNetworksOrPools(listParams, opts, cb);
            },
            function byName(cb) {
                var listParams = {
                    name: name,
                    provisionable_by: opts.account.uuid
                };

                log.debug({ listParams: listParams },
                    util.format('Networks: searching for network %s',
                        listParams.name));

                getNetworksOrPools(listParams, opts, cb);
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

                getNetworksOrPools(listParams, opts, cb);
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

/*
 * When fabrics are configured, but no specific network is supplied,
 * or if 'bridge' is supplied, we will use the user's default fabric
 * network, stored in UFDS.
 */
function getDefaultFabricNetwork(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.app.config, 'opts.app.config');
    assert.string(opts.app.config.datacenterName,
        'opts.app.config.datacenterName');
    assert.object(opts.log, 'opt.log');
    assert.func(callback, 'callback');

    var dc = opts.app.config.datacenterName;
    var log = opts.log;

    log.debug('Networks: using default fabric network');

    opts.app.ufds.getDcLocalConfig(opts.account.uuid, dc, function (err, conf) {
        log.debug({err: err, conf: conf, account: opts.account.uuid},
            'Networks: get DC local config');

        if (err || !conf || !conf.defaultnetwork) {
            callback(errors.ufdsErrorWrap(err,
                'Networks: could not get default network'));
            return;
        }

        callback(null, conf.defaultnetwork);
    });
}

/*
 * Add the required external network to the payload.networks.
 */
function externalNetworkByName(opts, container, payload, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.optionalString(opts.config.externalNetwork,
        'opts.config.externalNetwork');
    assert.object(opts.account, 'opts.account');
    assert.uuid(opts.account.uuid, 'opts.account.uuid');
    assert.uuid(opts.req_id, 'opts.req_id');
    assert.object(payload, 'payload');
    assert.func(callback, 'callback');

    var externalNetworkName;
    var labels = container.Labels || {};
    var log = opts.log;

    if (Object.prototype.hasOwnProperty.call(labels,
        TRITON_PUBLIC_NETWORK_LABEL))
    {
        externalNetworkName = labels[TRITON_PUBLIC_NETWORK_LABEL];
    }

    if (!payload.hasOwnProperty('networks')) {
        payload.networks = [];
    } else {
        // Ensure the external network is the *only* primary network.
        payload.networks.forEach(function (nw) {
            delete nw.primary;
        });
    }

    // When fabrics are enabled and no external name has been specified, use the
    // opts.config.overlay.externalPool uuid for the default external network.
    if (!externalNetworkName && opts.config.overlay.enabled) {
        assert.string(opts.config.overlay.externalPool,
            'opts.config.overlay.externalPool');
        return opts.app.plugins.findOwnerExternalNetwork({
            account: opts.account,
            req_id: opts.req_id
        }, function (err, externalNetwork) {
            if (err) {
                callback(err);
                return;
            }

            var netUuid = externalNetwork ?
                externalNetwork.uuid : opts.config.overlay.externalPool;

            payload.networks.push({
                uuid: netUuid,
                primary: true
            });

            callback();
            return;
        });
    }

    // Find the external network using the given (or default) network name.
    var listParams = {
        name: externalNetworkName || opts.config.externalNetwork || 'external',
        provisionable_by: opts.account.uuid
    };

    log.debug({ listParams: listParams },
        util.format('Networks: fabrics not configured, using network %s',
            listParams.name));

    getNetworksOrPools(listParams, opts, function (err, networks) {
        log.debug({ err: err, res: networks },
            util.format('Networks: listNetworks result for %s',
                listParams.name));

        if (err) {
            callback(errors.napiErrorWrap(err,
                util.format('Networks: problem listing network %s',
                    listParams.name)));
            return;
        }

        if (networks.length < 1) {
            log.error({ networks: networks, params: listParams },
                util.format('Networks: network %s provisionable by %s not '
                    + 'found', listParams.name, listParams.provisionable_by));
            callback(new errors.NetworkNotFoundError(listParams.name));
            return;
        }

        payload.networks.push({uuid: networks[0].uuid, primary: true});

        callback();
        return;
    });
}

/**
 * Add network configurations (fabrics and external) to the payload.
 *
 *  Fabrics:
 *
 *   When fabrics are enabled, the fabric network is selected in these ways:
 *    1. When 'bridge' or nothing specified, will use the user's default network
 *    2. Specifying a network name will provision to the named *fabric* network
 *    3. Specifying a network id (or portion) will provision to that *fabric*
 *       network
 *
 *   Docker resolves name/id collisions in the following way:
 *     - a name is preferred to a partial id
 *     - a full id is preferred to a name
 *
 *  External:
 *
 *   An external network is added in these cases:
 *    1. fabrics are *not* enabled, or
 *    2. fabrics are enabled and the user wants to expose ports
 *
 *   The user can specify which external network is used by setting the
 *   'triton.network.public' container label (tag), this specifies the external
 *   network *name*, all other cases will use the default external network,
 *   which for fabrics is opts.config.overlay.externalPool (uuid), or
 *   opts.config.externalNetwork (string name) when there are no fabrics.
 */
function addNetworksToContainerPayload(opts, container, payload, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.req_id, 'opts.req_id');
    assert.object(opts.config.overlay, 'opts.config.overlay');
    assert.optionalString(opts.config.overlay.externalPool,
        'opts.config.overlay.externalPool');
    assert.optionalBool(opts.config.overlay.enabled,
        'opts.config.overlay.enabled');
    assert.func(callback, 'callback');

    var log = opts.log;
    var networkMode;

    vasync.pipeline({ funcs: [
        function addFabricNetworks(_, next) {
            if (!opts.config.overlay.enabled) {
                next();
                return;
            }
            networkMode = container.HostConfig.NetworkMode;
            if (!networkMode || networkMode === 'bridge'
                    || networkMode === 'default') {
                getDefaultFabricNetwork(opts,
                    function onGetDefaultFabricNet(getDefaultFabricNetErr,
                        defaultFabricNet) {
                            payload.networks =
                                [ {uuid: defaultFabricNet, primary: true} ];
                            next(getDefaultFabricNetErr);
                        });
            } else {
                findNetworkOrPoolByNameOrId(networkMode, opts,
                    function (findErr, network)
                {
                    if (findErr) {
                        next(findErr);
                        return;
                    }
                    payload.networks = [ {uuid: network.uuid, primary: true} ];
                    next();
                });
            }
        },

        function addExternalNetwork(_, next) {
            if (opts.config.overlay.enabled
                && !containers.publishingPorts(container)) {
                // DOCKER-1045: for fabrics, it is an error if the
                // triton.network.public label is used and no ports are being
                // published.
                var labels = container.Labels || {};
                if (Object.prototype.hasOwnProperty.call(labels,
                        TRITON_PUBLIC_NETWORK_LABEL)) {
                    next(new errors.ValidationError(util.format(
                        '%s label requires a container with published ports',
                        TRITON_PUBLIC_NETWORK_LABEL)));
                    return;
                }
                next();
                return;
            }
            externalNetworkByName(opts, container, payload, next);
        }
    ]}, function (err) {
        if (!err) {
            log.debug({ networks: payload.networks }, 'payload.networks');
        } else {
            log.error({error: err},
                'Error when adding networks to container payload');
        }

        callback(err);
    });
}



/**
 * Get CNS information for the given array of network objects.
 *
 * @param {Array(String)} networks The vmapi network objects.
 * @param {Object} opts Configurable options for this call
 * @param {Function} callback invoked as fn(err, dnsSearchSuffixes)
 *      where dnsSearchSuffixes is an array of strings.
 */
function getCnsDnsSearchEntriesForNetworks(networks, opts, callback) {
    assert.arrayOfObject(networks, 'networks');
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.func(callback, 'callback');

    if (!opts.app.cns || opts.account.triton_cns_enabled !== 'true') {
        // CNS is not enabled.
        callback();
        return;
    }

    /*
     * Ask CNS for the DNS suffixes we should add.
     *
     * This lets machines on a CNS-enabled account have a DNS which resolves
     * other machines on the account in the same DC by their service names.
     */
    var cnsOpts = {
        headers: {
            'x-request-id': opts.req_id,
            'accept-version': '~1'
        }
    };
    var log = opts.log;
    var netUuids = new Set();

    networks.forEach(function (network) {
        if (network.ipv4_uuid) {
            netUuids.add(network.ipv4_uuid);
        }
        if (network.ipv6_uuid) {
            netUuids.add(network.ipv6_uuid);
        }
        if (network.uuid) {
            netUuids.add(network.uuid);
        }
    });

    opts.app.cns.getSuffixesForVM(opts.account.uuid, Array.from(netUuids),
        cnsOpts,
        function _getSuffixesForVMCb(err, result) {

        if (err) {
            if (err.name === 'NotFoundError'
                || err.name === 'ResourceNotFoundError') {

                log.warn('failed to retrieve DNS suffixes from '
                    + 'CNS REST API because the endpoint is not supported'
                    + ' (have you updated CNS?)');
                callback();
                return;
            }

            log.error(err, 'failed to retrieve DNS suffixes from CNS REST API');
            callback(new errors.InternalError('Triton CNS API failed'));
            return;
        }

        log.trace({result: result}, 'CNS result');

        if (!result.suffixes || result.suffixes.length === 0) {
            log.info('no suffixes returned from CNS REST API');
            callback();
            return;
        }

        callback(null, result.suffixes);
    });
}


module.exports = {
    addNetworksToContainerPayload: addNetworksToContainerPayload,
    findNetworkOrPoolByNameOrId: findNetworkOrPoolByNameOrId,
    getCnsDnsSearchEntriesForNetworks: getCnsDnsSearchEntriesForNetworks,
    getNapiNetworksForAccount: getNapiNetworksForAccount,
    getDefaultFabricNetwork: getDefaultFabricNetwork,
    getNetworksOrPools: getNetworksOrPools,
    inspectNetwork: inspectNetwork,
    listNetworksForAccount: listNetworksForAccount
};
