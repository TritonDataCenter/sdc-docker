/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Forces specific accounts to only use networks or network pools which belong
 * to that account. Specifically, it filters out networks and network pools in
 * backends/sdc/networks.js, which later prevents the listing of non-owner
 * networks or pools, and prevent the creation of containers with those networks
 * or pools too. It also hooks into backends/sdc/container.js to override the
 * default external network.
 *
 * Each network or pool has an optional array of UUIDs associated with users.
 * When filtering networks, we check that the UUID of the current account
 * matches any of the UUIDs in the requested network or pool's owner_uuids
 * array. If not, it is rejected.
 *
 * To configure this plugin, add the UUIDs of the account that should be
 * filtered:
 *
 * {
 *    "name": "filter_owner_networks",
 *    "enabled": true,
 *    "config": {
 *        "accounts": [ ... list of UUIDs here ... ],
 *    }
 * }
 * This is added to DOCKER_PLUGINS, serialized to JSON, and PUT to sdc-docker's
 * sapi service. E.g.:
 *
 * sdc-sapi /services/$(sdc-sapi /services?name=docker | json -Ha uuid) -X PUT
 * -d '{
 *    "metadata": {
 *         "DOCKER_PLUGINS": "[{\"name\":\"filter_owner_networks\", \
 *         \"enabled\": true, \"config\": {\"accounts\": \
 *         [\"fb7f31ad-52d6-4e92-83d2-9f9d94ceef3f\"]}}]"
 *    }
 * }'
 */

var assert = require('assert-plus');


var EXTERNAL_NIC_TAG = 'external';


/*
 * This hook runs after sdc-docker has retrieved an array from napi, but before
 * backends/sdc/networks.js returns the results any higher up the stack. It
 * filters 'networks' so that it only contains networks or network pools which
 * have the account UUID in their owner_uuids.
 */
function filterListNetworks(api, cfg) {
    assert.object(api, 'api');
    assert.object(api.log, 'api.log');
    assert.object(cfg, 'cfg');
    assert.arrayOfUuid(cfg.accounts, 'cfg.accounts');

    var log = api.log;

    return function filterOwnerListNetworks(opts, networks) {
        assert.object(opts, 'opts');
        assert.object(opts.account, 'opts.account');
        assert.arrayOfObject(networks, 'networks');

        log.debug('Running ' + filterOwnerListNetworks.name);

        var accountUuid = opts.account.uuid;
        if (cfg.accounts.indexOf(accountUuid) === -1) {
            return networks;
        }

        log.debug('Filtering networks for account', accountUuid);

        return networks.filter(function filterOwner(network) {
            var owners = network.owner_uuids;
            return owners && owners.indexOf(accountUuid) !== -1;
        });
    };
}


/*
 * This hook is run when creating a container, before assigning
 * a default external network to that container. The default network
 * may not belong to the account creating the container, then this
 * gets invoked. It finds a pools or network which is owned by an
 * account, and has an 'external' nic tag.
 */
function findOwnerExternalNetwork(api, cfg) {
    assert.object(api, 'api');
    assert.object(api.log, 'api.log');
    assert.func(api.getNapiNetworksForAccount, 'api.getNapiNetworksForAccount');
    assert.object(cfg, 'cfg');
    assert.arrayOfUuid(cfg.accounts, 'cfg.accounts');

    var log = api.log;

    return function findExternalNetworkWithOwnerUuid(opts, cb) {
        assert.object(opts, 'opts');
        assert.object(opts.account, 'opts.account');
        assert.uuid(opts.req_id, 'opts.req_id');

        log.debug('Running ' + findExternalNetworkWithOwnerUuid.name);

        var accountUuid = opts.account.uuid;
        if (cfg.accounts.indexOf(accountUuid) === -1) {
            return cb();
        }

        log.debug('Looking up external pools and networks for account',
            accountUuid);

        api.getNapiNetworksForAccount({
            accountUuid: accountUuid,
            reqId: opts.req_id,
            log: log
        }, function onAccountNetworks(err, networks) {
            if (err) {
                return cb(err);
            }

            var owned = networks.filter(function filterOwner(network) {
                var owners = network.owner_uuids;
                return owners && owners.indexOf(accountUuid) !== -1;
            })

            var external = owned.filter(function filterExternal(network) {
                var tags = network.nic_tags_present;
                return network.nic_tag === EXTERNAL_NIC_TAG ||
                    (tags && tags.indexOf(EXTERNAL_NIC_TAG) !== -1);
            });

            if (external.length === 0) {
                var msg = 'Found no external network accessible to account'
                return cb(new Error(msg));
            }

            return cb(null, external[0]);
        });
    };
}


module.exports = {
    filterGetNetworksOrPools: filterListNetworks,
    filterListNetworks: filterListNetworks,
    findOwnerExternalNetwork: findOwnerExternalNetwork
};
