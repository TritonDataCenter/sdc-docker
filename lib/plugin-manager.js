/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * sdc-docker/cloudapi plugin API and manager. sdc-docker and cloudapi present
 * the same API. Any changes made here must have their equivalents in
 * cloudapi's plugin manager.
 *
 * This file loads all enabled plugins listed in app.config.plugins, if any.
 * For each plugin, this class attempts to load a fixed set of supported named
 * functions (hooks); unrecognized hooks cause an exception.
 *
 * Plugin hooks are given a formal API by the plugin manager, through which
 * the plugins can interact with sdc-docker and sdc-cloudapi.
 *
 * Plugins are configured by adding the following to
 * DOCKER_PLUGINS/CLOUDAPI_PLUGINS in sapi:
 *
 * {
 *    "name": "<name of plugin>",
 *    "enabled": true,
 *    "config":{
 *        <this is specific to each plugin>
 *    }
 * }
 *
 * The above object is added to the plugin array, then serialized to JSON and
 * used to replace DOCKER_PLUGINS and CLOUDAPI_PLUGINS. E.g.:
 *
 * sdc-sapi /services/$(sdc-sapi /services?name=docker | json -Ha uuid) -X PUT \
 * -d '
 * {
 *     "metadata": {
 *         "DOCKER_PLUGINS": "[{\"name\":\"...\", \
 *         \"enabled\":true,\"config\":{ ... }}]"
 *      }
 * }
 * '
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var path = require('path');
var vasync = require('vasync');


var PluginManager = module.exports =
function init(app) {
    var self = this;

    assert.object(app, 'app');
    assert.object(app.log, 'app.log');
    assert.object(app.backend, 'app.backend');
    assert.object(app.config, 'app.config');

    // if we don't have a wrapper function in this class, we don't support
    // the import of functions with the same name from a plugin
    var supportedPluginHooks = Object.keys(PluginManager.prototype);

    self.hooks = {};
    supportedPluginHooks.forEach(function addPluginArray(apiName) {
        self.hooks[apiName] = [];
    });

    var cfg = app.config.plugins;
    if (cfg === undefined) {
        return;
    }
    assert.arrayOfObject(cfg, 'cfg');

    // this is here to minimize differences with cloudapi's plugin manager
    var clients = app;

    // This is the API of functions that sdc-docker and cloudapi make available
    // for use to the plugins they import.
    self.api = {
        log: app.log,
        datacenterName: app.config.datacenterName,
        service: 'docker',
        NotAuthorizedError: require('./errors').UnauthorizedError,
        getNapiNetworksForAccount: function getNapiShim(obj, cb) {
            assert.object(obj, 'obj');
            assert.object(obj.account, 'obj.account');
            assert.uuid(obj.req_id, 'obj.req_id');
            assert.func(cb, 'cb');

            obj = jsprim.deepCopy(obj);
            obj.config = { napi: app.config.napi };
            obj.reqId = obj.req_id;
            obj.req_id = undefined;
            obj.accountUuid = obj.account.uuid;
            obj.account = undefined;

            app.backend.getNapiNetworksForAccount(obj, cb);
        },
        getActiveVmsForAccount: function getActiveVmsShim(opts, cb) {
            assert.object(opts, 'opts');
            assert.object(opts.account, 'opts.account');
            assert.optionalString(opts.brand, 'opts.brand');
            assert.optionalString(opts.fields, 'opts.fields');
            assert.uuid(opts.req_id, 'opts.req_id');
            assert.func(cb, 'cb');

            var args = {
                owner_uuid: opts.account.uuid,
                state: 'active'
            };

            if (opts.brand) {
                args.brand = opts.brand;
            }

            if (opts.fields) {
                args.fields = opts.fields;
            }

            var reqOpts = { headers: {'x-request-id': opts.req_id } };

            clients.vmapi.listVms(args, reqOpts, cb);
        },
        getImage: function getImageShim(opts, cb) {
            assert.object(opts, 'opts');
            assert.object(opts.image, 'opts.image');
            assert.uuid(opts.image.uuid, 'opts.image.uuid');
            assert.uuid(opts.req_id, 'opts.req_id');
            assert.func(cb, 'cb');

            var reqOpts = { headers: {'x-request-id': opts.req_id } };

            clients.imgapi.getImage(opts.image.uuid, reqOpts, cb);
        },
        listImages: function listImageShim(opts, cb) {
            assert.object(opts, 'opts');
            assert.uuid(opts.req_id, 'opts.req_id');
            assert.func(cb, 'cb');

            var reqOpts = { headers: {'x-request-id': opts.req_id } };
            opts.req_id = undefined;

            clients.imgapi.listImages(opts, reqOpts, cb);
        }
    };

    cfg.forEach(function loadPlugin(description) {
        assert.object(description, 'description');
        assert.string(description.name, 'description.name');

        if (!description.enabled) {
            return;
        }

        app.log.info('Loading plugin: %s', description.name);

        var pluginCfg = description.config;
        var pPath = path.resolve(__dirname, '../plugins', description.name);
        var plugin = require(pPath);

        Object.keys(plugin).forEach(function (apiName) {
            // Allow a plugin to export names that are not a known plugin
            // function by prefixing with an underscore. This is used for
            // testing.
            if (apiName[0] === '_') {
                return;
            }

            assert.notEqual(supportedPluginHooks.indexOf(apiName), -1,
                'supportedPluginFunctions["' + apiName + ']"');

            var initedPlugin = plugin[apiName](self.api, pluginCfg);
            self.hooks[apiName].push(initedPlugin);
        });
    });
};


/*
 * This hooks into backends/sdc/networks.js, listNetworks(). It runs
 * runs after sdc-docker has retrieved an array from napi, but before
 * backends/sdc/networks.js returns the results any higher up the stack.
 *
 * For cloudapi, it hooks into middleware/networks.js, but otherwise behaves
 * the same. Specifically, it affects req.networks/internal_networks/
 * external_networks.
 */
PluginManager.prototype.filterListNetworks =
function filterListNetworks(opts, networks) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.array(networks, 'networks');

    this.hooks.filterListNetworks.forEach(function runPlugin(plugin) {
        networks = plugin(opts, networks);
    });

    return networks;
};


/*
 * This hooks into backends/sdc/networks.js, getNetworksOrPools(). That
 * function is used several places in network.js, and is exported as well.
 */
PluginManager.prototype.filterGetNetworksOrPools =
function filterGetNetworksOrPools(opts, networks) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.array(networks, 'networks');

    this.hooks.filterGetNetworksOrPools.forEach(function runPlugin(plugin) {
        networks = plugin(opts, networks);
    });

    return networks;
};


/*
 * This hook is run when creating a container, before assigning
 * a default external network to that container. The default network
 * may not belong to the account creating the container, then this
 * gets invoked.
 */
PluginManager.prototype.findOwnerExternalNetwork =
function findOwnerExternalNetwork(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.uuid(opts.req_id, 'opts.req_id');
    assert.func(cb, 'cb');

    var hooks = this.hooks.findOwnerExternalNetwork;

    // Runs every plugin (if any) until a plugin succeeds (doesn't return an
    // error). If that plugin returned a network, use that network for the
    // external instead of the default overlay.externalPool.
    vasync.tryEach(hooks.map(function (p) {
        return p.bind(null, opts);
    }), cb);
};


/*
 * This hook is run before the creation of a contain is initiated. It checks
 * that various preconditions have been fulfilled before allowing the creation
 * to proceed further.
 */
PluginManager.prototype.allowProvision =
function allowProvision(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.image, 'opts.image');
    assert.object(opts.pkg, 'opts.pkg');
    assert.uuid(opts.req_id, 'opts.req_id');
    assert.func(cb, 'cb');

    var hooks = this.hooks.allowProvision;
    var funcs = hooks.map(function wrapFunc(func) {
        return function (_, next) {
            func(opts, next);
        };
    });

    // Runs every plugin (if any) until a plugin fails. Any failure indicates
    // that the provision should not be allowed.
    vasync.pipeline({ funcs: funcs }, function (err, results) {
        cb(err);
    });
};


/*
 * This hook is run after the creation of a container. It performs no checks,
 * and returns no error, since the provision is already made.
 */
PluginManager.prototype.postProvision =
function postProvision(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.instance, 'opts.instance');
    assert.uuid(opts.req_id, 'opts.req_id');
    assert.func(cb, 'cb');

    var hooks = this.hooks.postProvision;
    var funcs = hooks.map(function wrapFunc(func) {
        return function (_, next) {
            func(opts, next);
        };
    });

    // Runs every plugin (if any).
    function callfuncs() {
        if (funcs.length === 0) {
            return cb();
        }

        var func = funcs.pop();
        return func(opts, callfuncs);
    }

    callfuncs();
};


/*
 * This hook is run during provisioning, just before the creation of a
 * container. It performs no checks, and returns no error. It modifies the
 * opts.networks argument.
 */
PluginManager.prototype.modifyProvisionNetworks =
function modifyProvisionNetworks(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.arrayOfObject(opts.networks, 'opts.networks');
    assert.uuid(opts.req_id, 'opts.req_id');
    assert.func(cb, 'cb');

    var hooks = this.hooks.modifyProvisionNetworks;
    var funcs = hooks.map(function wrapFunc(func) {
        return function (_, next) {
            func(opts, next);
        };
    });

    // Runs every plugin (if any).
    function callfuncs() {
        if (funcs.length === 0) {
            return cb();
        }

        var func = funcs.pop();
        return func(opts, callfuncs);
    }

    callfuncs();
};
