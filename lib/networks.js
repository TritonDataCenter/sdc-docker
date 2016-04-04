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


/* Add networks to the payload. Dispatches to one of these supported networking
 * configurations:
 *   1. without fabrics configured: external networking only.
 *
 *   With fabrics enabled:
 *   2. 'bridge' or nothing specified provisions on the user's default network,
 *      potentially also with the external network.
 *   3. Specifying a network name will provision to the named *fabric* network.
 *   4. Specifying a network id (or portion) will provision to that *fabric*
 *      network.
 *
 *   Docker resolves name/id collisions in the following way:
 *     - a name is preferred to a partial id
 *     - a full id is preferred to a name
 */
function addNetworksToPayload(opts, container, payload, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.config.overlay, 'opts.config.overlay');

    assert.optionalString(opts.config.overlay.externalPool,
        'opts.config.overlay.externalPool');
    assert.optionalBool(opts.config.overlay.enabled,
        'opts.config.overlay.enabled');
    assert.func(callback, 'callback');

    /*
     * currently there are four network possibilities:
     *  - no fabrics configured -> external network.
     *  - fabrics configured and...
     *    - 'bridge' or no network specified: default fabric
     *    - 'fabric' name or id specified: that specific fabric
     */
    if (!opts.config.overlay.enabled) {
        return externalNetworkByName(opts, payload, callback);
    } else {
        if (container.HostConfig.NetworkMode === 'bridge'
            || container.HostConfig.NetworkMode === 'default'
            || common.objEmpty(container.HostConfig.NetworkMode)) {
            return defaultFabricNetwork(opts, payload, callback);
        } else {
            return namedNetwork(opts, container, payload, callback);
        }
    }
}

/*
 * When fabrics are not configured, we will use the named
 * network, defaulting to 'external'.
 */
function externalNetworkByName(opts, payload, callback) {
    assert.object(opts.config, 'opts.config');
    assert.optionalString(opts.config.externalNetwork,
        'opts.config.externalNetwork');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.account.uuid, 'opts.account.uuid');
    assert.object(payload, 'payload');
    assert.func(callback, 'callback');

    var log = opts.log;
    var listParams = {
        name: opts.config.externalNetwork || 'external',
        fabric: false,
        provisionable_by: opts.account.uuid
    };

    log.debug({ listParams: listParams },
        format('Networks: fabrics not configured, using network %s',
        listParams.name));

    listNetworks(opts, listParams, function (err, networks) {
        log.debug({ err: err, res: networks },
            format('Networks: listNetworks result for %s', listParams.name));

        if (err) {
            callback(errors.napiErrorWrap(err,
                format('Networks: problem listing network %s',
                    listParams.name)));
            return;
        }

        if (networks.length < 1) {
            log.error({ networks: networks, params: listParams },
                format('Networks: network %s provisionable by %s not found',
                    listParams.name, listParams.provisionable_by));
            callback(new errors.NetworkNotFoundError(listParams.name));
            return;
        }

        payload.networks = [ { uuid: networks[0].uuid, primary: true} ];
        callback();
        return;
    });
}

/*
 * When fabrics are configured, but no specific network is supplied,
 * or if 'bridge' is supplied, we will use the user's default fabric
 * network, stored in UFDS.
 *
 * Additionally, if the user is publishing ports or we have the
 * `fabricRequireExternal` option (currently used by docker build,
 * see DOCKER-705), we will also attach to configured network pool
 * (typically the external/public pool).
 */
function defaultFabricNetwork(opts, payload, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.app.config, 'opts.app.config');
    assert.string(opts.app.config.datacenterName,
        'opts.app.config.datacenterName');
    assert.object(opts.log, 'opt.log');
    assert.object(payload, 'payload');
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

        payload.networks = [ { uuid: conf.defaultnetwork, primary: true } ];

        callback();
        return;
    });
}

/*
 * When fabrics are configured and a specific network name is supplied,
 * we will find and use the specified network.
 */
function namedNetwork(opts, container, payload, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.account.uuid, 'opts.account.uuid');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.object(container, 'container');
    assert.object(container.HostConfig, 'container.HostConfig');
    assert.string(container.HostConfig.NetworkMode,
        'container.HostConfig.NetworkMode');
    assert.notEqual(container.HostConfig.NetworkMode, '',
        'NetworkMode is empty');
    assert.func(callback, 'callback');

    // need to search on networks by: name, fabric-true, owner_uuid
    var log = opts.log;
    var query = container.HostConfig.NetworkMode;
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
                if (query.substr(0, 32) !== query.substr(32)) {
                    log.debug({ query: query },
                        'Networks: impossible exactId: %s, skipping', query);
                    setImmediate(cb, null, []);
                    return;
                }
                var uuid = utils.shortNetworkIdToUuidPrefix(query);

                // XXX - ldapEscape required to work around NAPI-367
                var listParams = {
                    uuid: utils.ldapEscape(uuid),
                    fabric: true,
                    owner_uuid: opts.account.uuid
                };

                napi.listNetworks(listParams,
                    { headers: { 'x-request-id': opts.req_id }}, cb);
            },
            function byName(cb) {
                var listParams = {
                    name: query,
                    fabric: true,
                    owner_uuid: opts.account.uuid
                };

                log.debug({ listParams: listParams },
                    format('Networks: searching for network %s',
                        listParams.name));

                napi.listNetworks(listParams,
                    { headers: {'x-request-id': opts.req_id }}, cb);
            },
            function byDockerId(cb) {
                // we assume the 'double uuid' convention for networks here,
                // that is, dockerId = (uuid + uuid).replace(/-/g, '').
                // So if we have a query.length > 31, 32... must be a prefix of
                // 0..31. If not, the id supplied is impossible in our system.
                if (query.length >= 32) {
                    // this must be a prefix of the first half of the input
                    var secondHalf = query.substr(32);
                    var firstHalf = query.substr(0, 31);

                    if (secondHalf.length >= firstHalf.length
                        || secondHalf !==
                        firstHalf.substr(0, secondHalf.length)) {

                        log.info({ query: query },
                            'Networks: impossible network id %s, skipping',
                            query);
                        setImmediate(cb, null, []);
                        return;
                    }
                }

                // To perform the search, we transform the provided query to
                // a (potentially partial) UUID, and perform a wildcard search
                // on it.
                // XXX - ldapEscape required to work around NAPI-367
                var uuidSearchStr = utils.ldapEscape(
                    utils.shortNetworkIdToUuidPrefix(query)) + '*';

                var listParams = {
                    uuid: uuidSearchStr,
                    fabric: true,
                    owner_uuid: opts.account.uuid
                };

                log.debug({ listParams: listParams },
                    format('Networks: searching for network %s',
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
                acc.err = new errors.AmbiguousDockerNetworkIdPrefixError(query);
                break;
            }
            return acc;
        }, { err: null, result: null });

        if (bestMatch.err) {
            // found an error before a result.
            log.error({ err: bestMatch.err, query: query },
                format('Networks: Error finding network to match %s', query));
            callback(bestMatch.err);
            return;
        }

        if (!bestMatch.err && !bestMatch.result) {
            log.info({ query: query, user: opts.account.uuid },
                format('Networks: no results for query %s', query));
            callback(new errors.NetworkNotFoundError(query));
            return;
        }

        if (!bestMatch.err && err) {
            // found result before an error, but did have errs.
            log.warn({ err: err },
                'Networks: non-critical error searching NAPI');
        }

        log.debug({ network: bestMatch.result }, 'Networks: chose %s/%s',
            bestMatch.result.name, bestMatch.result.uuid);

        payload.networks = [ { uuid: bestMatch.result.uuid, primary: true } ];
        log.debug({ payload: payload }, format('Networks: built payload'));

        callback();
        return;
    });
}

module.exports = {
    addNetworksToPayload: addNetworksToPayload
};