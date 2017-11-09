/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * sdc-docker plugin API and manager.
 *
 * This file loads all enabled plugins listed in app.config.plugins, if any.
 * For each plugin, this class attempts to load a fixed set of supported named
 * functions (hooks); unrecognized hooks cause an exception.
 *
 * Plugin hooks are given a formal API by the plugin manager, through which
 * the plugins can interact with sdc-docker. Currently this consists of the
 * common bunyan log object and getNapiNetworksForAccount().
 *
 * Plugins are configured by adding the following to DOCKER_PLUGINS in sapi:
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
 * used to replace DOCKER_PLUGINS. E.g.:
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
var fs = require('fs');
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

    // This is the API of functions that sdc-docker makes available for use to
    // the plugins it imports.
    var pluginApi = {
        log: app.log,
        getNapiNetworksForAccount: function getNapiShim(obj, cb) {
            obj = jsprim.deepCopy(obj);
            obj.config = { napi: app.config.napi };
            app.backend.getNapiNetworksForAccount(obj, cb);
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
            assert.notEqual(supportedPluginHooks[apiName], -1,
                'supportedPluginFunctions[apiName]');

            var initedPlugin = plugin[apiName](pluginApi, pluginCfg);
            self.hooks[apiName].push(initedPlugin);
        });
    });
};


/*
 * This hooks into backends/sdc/networks.js, listNetworks(). It runs
 * runs after sdc-docker has retrieved an array from napi, but before
 * backends/sdc/networks.js returns the results any higher up the stack.
 */
PluginManager.prototype.filterListNetworks =
function filterListNetworks(opts, networks) {
    assert.object(opts, 'opts');
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
    assert.func(cb, 'cb');

    var hooks = this.hooks.findOwnerExternalNetwork;

    // Runs every plugin (if any) until a plugin succeeds (doesn't return an
    // error). If that plugin returned a network, use that network for the
    // external instead of the default overlay.externalPool.
    vasync.tryEach(hooks.map(function (p) {
        return p.bind(null, opts);
    }), cb);
};
