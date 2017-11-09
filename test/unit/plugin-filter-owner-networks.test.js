/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var test = require('tape').test;
var plugin = require('../../plugins/filter_owner_networks');


// --- Globals

var ACCOUNT = { uuid: '572c169e-a287-11e7-b95d-28cfe91f7d53' };
var OTHER_ACCOUNT = { uuid: '5cc54706-a287-11e7-b33c-28cfe91f7d53' };

var NETWORKS = [ {
    uuid: '22a0b5fa-a292-11e7-8911-28cfe91f7d53',
    owner_uuids: [ACCOUNT.uuid],
    nic_tag: 'internal'
}, {
    uuid: '2790d1e4-a292-11e7-8d23-28cfe91f7d53',
    owner_uuids: ['9ea6158e-a29a-11e7-a2c5-28cfe91f7d53'],
    nic_tag: 'internal'
}, {
    uuid: '9336f8d0-a29a-11e7-a744-28cfe91f7d53',
    nic_tag: 'interal'
}, {
    uuid: '4f854694-a35f-11e7-9574-28cfe91f7d53',
    nic_tag: 'internal'
}, {
    uuid: '3acc8d3e-a35f-11e7-8f64-28cfe91f7d53',
    owner_uuids: [ACCOUNT.uuid],
    nic_tag: 'external'
}  ];

var API = {
    getNapiNetworksForAccount: function () {},
    log: {
        info: function () {},
        debug: function () {}
    }
};

var FILTER_LIST_NETWORKS;
var FILTER_GET_NETWORKS_OR_POOLS;
var FIND_OWNER_EXTERNAL_NETWORK;


// --- Helpers

function clone(o) {
    return JSON.parse(JSON.stringify(o));
}


// --- Tests

test('Setup filterListNetworks without api',
function (t) {
    try {
        plugin.filterListNetworks();
    } catch (e) {
        t.equal(e.message, 'api (object) is required', 'err message');
        t.end();
    }
});


test('Setup filterListNetworks without cfg',
function (t) {
    try {
        plugin.filterListNetworks(API);
    } catch (e) {
        t.equal(e.message, 'cfg (object) is required', 'err message');
        t.end();
    }
});


test('Setup filterListNetworks with invalid cfg',
function (t) {
    try {
        plugin.filterListNetworks(API, { accounts: 'foo' });
    } catch (e) {
        t.equal(e.message, 'cfg.accounts ([uuid]) is required', 'err message');
        t.end();
    }
});


test('Setup filterListNetworks with valid cfg',
function (t) {
    FILTER_LIST_NETWORKS = plugin.filterListNetworks(API, {
        accounts: [ACCOUNT.uuid]
    });
    t.equal(typeof (FILTER_LIST_NETWORKS), 'function', 'func type');
    t.equal(FILTER_LIST_NETWORKS.name, 'filterOwnerListNetworks', 'func name');
    t.end();
});


test('filterListNetworks with non-owner account',
function (t) {
    var networks = FILTER_LIST_NETWORKS({
        account: OTHER_ACCOUNT
    }, clone(NETWORKS));

    t.deepEqual(networks, NETWORKS, 'networks');
    t.end();
});


test('filterListNetworks with owner account',
function (t) {
    var networks = FILTER_LIST_NETWORKS({ account: ACCOUNT }, clone(NETWORKS));
    t.deepEqual(networks, [
        NETWORKS[0],
        NETWORKS[4]
    ], 'networks');
    t.end();
});


test('Setup filterGetNetworksOrPools without api',
function (t) {
    try {
        plugin.filterGetNetworksOrPools();
    } catch (e) {
        t.equal(e.message, 'api (object) is required', 'err message');
        t.end();
    }
});


test('Setup filterGetNetworksOrPools without cfg',
function (t) {
    try {
        plugin.filterGetNetworksOrPools(API);
    } catch (e) {
        t.equal(e.message, 'cfg (object) is required', 'err message');
        t.end();
    }
});


test('Setup filterGetNetworksOrPools with invalid cfg',
function (t) {
    try {
        plugin.filterGetNetworksOrPools(API, { accounts: 'foo' });
    } catch (e) {
        t.equal(e.message, 'cfg.accounts ([uuid]) is required', 'err message');
        t.end();
    }
});


test('Setup filterGetNetworksOrPools with valid cfg',
function (t) {
    FILTER_GET_NETWORKS_OR_POOLS = plugin.filterGetNetworksOrPools(API, {
        accounts: [ACCOUNT.uuid]
    });
    t.equal(typeof (FILTER_LIST_NETWORKS), 'function', 'func type');
    t.equal(FILTER_LIST_NETWORKS.name, 'filterOwnerListNetworks', 'func name');
    t.end();
});


test('filterGetNetworksOrPools with non-owner account',
function (t) {
    var networks = FILTER_GET_NETWORKS_OR_POOLS({
        account: OTHER_ACCOUNT
    }, clone(NETWORKS));

    t.deepEqual(networks, NETWORKS, 'networks');
    t.end();
});


test('filterGetNetworksOrPools with owner account',
function (t) {
    var networks = FILTER_GET_NETWORKS_OR_POOLS({
        account: ACCOUNT
    }, clone(NETWORKS));

    t.deepEqual(networks, [
        NETWORKS[0],
        NETWORKS[4]
    ], 'networks');

    t.end();
});


test('Setup findOwnerExternalNetwork without api',
function (t) {
    try {
        plugin.findOwnerExternalNetwork();
    } catch (e) {
        t.equal(e.message, 'api (object) is required', 'err message');
        t.end();
    }
});


test('Setup findOwnerExternalNetwork without cfg',
function (t) {
    try {
        plugin.findOwnerExternalNetwork(API);
    } catch (e) {
        t.equal(e.message, 'cfg (object) is required', 'err message');
        t.end();
    }
});


test('Setup findOwnerExternalNetwork with invalid cfg',
function (t) {
    try {
        plugin.findOwnerExternalNetwork(API, { accounts: 'foo' });
    } catch (e) {
        t.equal(e.message, 'cfg.accounts ([uuid]) is required', 'err message');
        t.end();
    }
});


test('Setup findOwnerExternalNetwork with valid cfg',
function (t) {
    FIND_OWNER_EXTERNAL_NETWORK = plugin.findOwnerExternalNetwork(API, {
        accounts: [ACCOUNT.uuid]
    });
    t.equal(typeof (FIND_OWNER_EXTERNAL_NETWORK), 'function', 'func type');
    t.equal(FIND_OWNER_EXTERNAL_NETWORK.name,
        'findExternalNetworkWithOwnerUuid', 'func name');
    t.end();
});


test('findOwnerExternalNetwork with non-owner account',
function (t) {
    function failStub(opts, cb) {
        t.fail('this should not be called');
    }

    // admittedly evil mutating a global like this...
    API.getNapiNetworksForAccount = failStub;

    FIND_OWNER_EXTERNAL_NETWORK({
        account: OTHER_ACCOUNT,
        req_id: '1180af02-a8ee-11e7-86c1-28cfe91f7d53'
    }, function (err, network) {
        t.equal(err, undefined, 'err');
        t.equal(network, undefined, 'network');
        t.end();
    });
});


test('findOwnerExternalNetwork with owner account',
function (t) {
    function getNapiNetworksForAccountStub(opts, cb) {
        t.deepEqual(opts, {
            log: API.log,
            reqId: '1180af02-a8ee-11e7-86c1-28cfe91f7d53',
            accountUuid: ACCOUNT.uuid
        }, 'stub opts');

        var nets = NETWORKS.filter(function (network) {
            return !network.owner_uuids
                || network.owner_uuids.indexOf(ACCOUNT.uuid) !== -1;
        });

        return cb(null, nets);
    }

    API.getNapiNetworksForAccount = getNapiNetworksForAccountStub;

    FIND_OWNER_EXTERNAL_NETWORK({
        account: ACCOUNT,
        req_id: '1180af02-a8ee-11e7-86c1-28cfe91f7d53'
    }, function (err, network) {
        t.equal(err, null, 'err');
        t.deepEqual(network, NETWORKS[4], 'network');
        t.end();
    });
});
