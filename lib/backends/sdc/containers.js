/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var child_process = require('child_process');
var execFile = child_process.execFile;
var once = require('once');
var spawn = child_process.spawn;
var libuuid = require('libuuid');
var LineStream = require('lstream');
var CNAPI = require('sdc-clients').CNAPI;
var FWAPI = require('sdc-clients').FWAPI;
var IMGAPI = require('sdc-clients').IMGAPI;
var NAPI = require('sdc-clients').NAPI;
var PAPI = require('sdc-clients').PAPI;
var vasync = require('vasync');
var VMAPI = require('sdc-clients').VMAPI;
var net = require('net');
var restify = require('restify');
var util = require('util'),
    fmt = util.format;
var path = require('path');

var common = require('../../../lib/common');
var errors = require('../../../lib/errors');
var images = require('./images');
var Link = require('../../models/link');
var utils = require('./utils');
var validate = require('../../validate');



//---- globals

var _cnapiClientCache; // set in `getCnapiClient`
var _fwapiClientCache; // set in `getFwapiClient`
var _imgapiClientCache; // set in `getImgapiClient`
var _napiClientCache; // set in `getNapiClient`
var _papiClientCache; // set in `getPapiClient`
var _vmapiClientCache; // set in `getVmapiClient`

// Number of exposed ports per protocol (TCP, UDP) to allow
var MAX_EXPOSED_PORTS = 128;
// The number of ports we can support in one rule
var MAX_PORTS_PER_RULE = 8;
var VM_DEFAULT_KERNEL_VERSION = '3.13.0';

var MAX_DATA_VOLUMES = 8; // volumes that are local to this VM
var MAX_VOLUMES_FROM = 1; // number of --volumes-from allowed


//---- internal support routines

function getCnapiClient(config) {
    if (!_cnapiClientCache) {
        // intentionally global
        _cnapiClientCache = new CNAPI(config);
    }
    return _cnapiClientCache;
}

function getFwapiClient(config) {
    if (!_fwapiClientCache) {
        // intentionally global
        _fwapiClientCache = new FWAPI(config);
    }
    return _fwapiClientCache;
}

function getImgapiClient(config) {
    if (!_imgapiClientCache) {
        // intentionally global
        _imgapiClientCache = new IMGAPI(config);
    }
    return _imgapiClientCache;
}

function getVmapiClient(config) {
    if (!_vmapiClientCache) {
        // intentionally global
        _vmapiClientCache = new VMAPI(config);
    }
    return _vmapiClientCache;
}

function getNapiClient(config) {
    if (!_napiClientCache) {
        // intentionally global
        _napiClientCache = new NAPI(config);
    }
    return _napiClientCache;
}

function getPapiClient(config) {
    if (!_papiClientCache) {
        // intentionally global
        _papiClientCache = new PAPI(config);
    }
    return _papiClientCache;
}


/**
 * Return rules that expose ports for a given account and protocol
 */
function generateExposeRules(account, vm, proto, ports) {
    var protoRules = [];

    // Each FWAPI rule only supports 8 ports
    for (var i = 0; i < MAX_EXPOSED_PORTS; i += MAX_PORTS_PER_RULE) {
        var rulePorts = ports.slice(i, i + MAX_PORTS_PER_RULE);
        if (rulePorts.length === 0) {
            break;
        }

        protoRules.push({
            enabled: true,
            owner_uuid: account.uuid,
            rule: util.format('FROM any to vm %s ALLOW %s (port %s)',
                vm, proto, rulePorts.sort().join(' AND port ')),
            uuid: libuuid.create()
        });
    }

    return protoRules;
}


/**
 * List networks in NAPI, filtering by params
 */
function listNetworks(opts, params, callback) {
    var napi = getNapiClient(opts.config.napi);

    napi.listNetworks(params, {headers: {'x-request-id': opts.req_id}},
        callback);
}

/**
 * Add the user's default fabric network to the payload.  If they've specified
 * ports to publish, add an external network as well.
 */
function addFabricNetworksToPayload(opts, container, payload, callback) {
    var dc = opts.app.config.datacenterName;
    var log = opts.log;
    var requireExternal = false;

    if (publishingPorts(container)) {
        requireExternal = true;
    }

    opts.app.ufds.getDcLocalConfig(opts.account.uuid, dc, function (err, conf) {
        log.debug('conf:', conf);
        log.debug({
            err: err,
            conf: conf,
            account: opts.account.uuid},
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
 * Add the "EXPOSE" firewall rules to the payload.  Note that we open up all
 * ports between docker hosts right now, since this is what other inter-host
 * docker networking solutions do.  This ends up adding two rules to the
 * VMAPI payload (necessary since many docker startup scripts require
 * a connection to other containers): one opening all TCP ports, and one
 * for all UDP ports.
 */
function addExposeFirewallRules(opts, payload, callback) {
    var fwapi = getFwapiClient(opts.config.fwapi);
    var listParams = {
        fields: ['parsed.action', 'parsed.ports', 'parsed.protocol',
            'parsed.tags'],
        owner_uuid: opts.account.uuid,
        tag: 'sdc_docker'
    };
    var listOpts = {
        headers: {'x-request-id': opts.req_id}
    };

    fwapi.listRules(listParams, listOpts, function (listErr, rules) {
        var parsed;
        var rulesToAdd = [];
        var tcpRuleFound;
        var udpRuleFound;

        if (listErr) {
            callback(errors.fwapiErrorWrap(listErr,
                'problem listing firewall rules'));
            return;
        }

        opts.log.debug({ rules: rules }, 'rules found');

        // Try to find rules that allow traffic on all ports between docker
        // VMs.  We're looking for two: one for TCP and one for UDP.
        for (var r in rules) {
            parsed = rules[r].parsed;

            if (!parsed || !parsed.hasOwnProperty('ports')
                    || !parsed.hasOwnProperty('protocol')
                    || !parsed.hasOwnProperty('fromtags')
                    || !parsed.hasOwnProperty('totags')) {
                continue;
            }

            if (!rules[r].enabled) {
                continue;
            }

            if (parsed.action !== 'allow') {
                continue;
            }

            if (!parsed.fromtags.sdc_docker
                    || !parsed.fromtags.sdc_docker.all) {
                continue;
            }

            if (!parsed.totags.sdc_docker || !parsed.totags.sdc_docker.all) {
                continue;
            }

            if (parsed.protocol === 'tcp' && !tcpRuleFound) {
                tcpRuleFound = true;
                opts.log.debug({ rule: rules[r] },
                    'TCP docker expose rule found: not adding');
                addRulesToPayload(payload, rules[r]);
            }

            if (parsed.protocol === 'udp' && !udpRuleFound) {
                udpRuleFound = true;
                opts.log.debug({ rule: rules[r] },
                    'UDP docker expose rule found: not adding');
                addRulesToPayload(payload, rules[r]);
            }
        }

        if (!tcpRuleFound) {
            opts.log.debug('TCP docker expose rule not found: adding');
            rulesToAdd.push({
                enabled: true,
                owner_uuid: opts.account.uuid,
                rule:
                    'FROM tag sdc_docker TO tag sdc_docker ALLOW tcp PORT all'
            });
        }

        if (!udpRuleFound) {
            opts.log.debug('UDP docker expose rule not found: adding');
            rulesToAdd.push({
                enabled: true,
                owner_uuid: opts.account.uuid,
                rule:
                    'FROM tag sdc_docker TO tag sdc_docker ALLOW udp PORT all'
            });
        }

        addRulesToFWAPI(opts, rulesToAdd, payload, callback);
    });
}

/**
 * If the user has requested ports to be published, create firewall rules that
 * open up those ports.
 *
 * These ports are also added to the VM's internal metadata, so that they show
 * up in `docker inspect` and `docker ps` correctly.  The keys that can be
 * added are:
 *
 * - docker:{tcp,udp}_published_ports - These are all of the ports that are
 *   published, either by specifying `-P` (publish all) or `-p port` on the
 *   commandline.
 *
 * - docker:{tcp,udp}_bound_ports - These are the explicit list of ports that
 *   were bound using `-p port` on the commandline.  This list needs to be
 *   recorded since a user can specify both `-P` and `-p` on the commandline,
 *   but HostConfig.PortBindings will only show the ports exposed with `-p`.
 *
 * - docker:{tcp,udp}_all_ports - These are all of the exposed ports (defined
 *   on the container), plus all of the explicitly bound ports. This list is
 *   recorded to make it easier for links to expose port environment variables.
 *
 * - docker:publish_all_ports - This is set to true if `-P` is passed on the
 *   commandline - it's needed to populate HostConfig.PublishAllPorts.
 */
function addPublishFirewallRules(opts, container, img, payload, callback) {
    var e;
    var exposed;
    var hostConf = container.HostConfig;
    var imageExposedPorts = img.config && img.config.ExposedPorts || {};
    var publishAllPorts = hostConf.PublishAllPorts;
    var log = opts.log;
    var addToFWAPI = [];
    var boundPorts = {
        tcp: [],
        udp: []
    };
    var exposedPorts = {
        tcp: [],
        udp: []
    };
    // All ports are the exposed and non-exposed ports.
    var allPorts = {
        tcp: [],
        udp: []
    };

    if (!publishingPorts(container) && common.objEmpty(imageExposedPorts)) {
        // Nothing to publish externally and no ports exposed internally, so
        // there's no point in adding the firewall rules
        log.info('no ports used, so not adding publish firewall rules');
        callback();
        return;
    }

    function addPort(port, portVal, bound) {
        var portNum;
        var proto;
        var split = port.split('/');

        portNum = Number(split[0]);
        proto = split[1].toLowerCase();

        if (allPorts[proto].indexOf(portNum) === -1) {
            allPorts[proto].push(portNum);
        }

        // If it's not being bound/published, then nothing else to do here.
        if (!bound && !publishAllPorts) {
            return;
        }

        exposedPorts[proto].push(portNum);
        if (exposedPorts[proto].length > MAX_EXPOSED_PORTS) {
            throw new errors.DockerError(util.format(
                'only support exposing %d %s ports',
                MAX_EXPOSED_PORTS, proto.toUpperCase()));
        }

        if (bound) {
            boundPorts[proto].push(portNum);
            if (portVal && portVal[0] && portVal[0].HostPort
                    && portVal[0].HostPort !== split[0]) {
                throw new errors.DockerError(
                    'remapping of port numbers not allowed');
            }
        }
    }

    exposed = imageExposedPorts;
    log.info({ exposed: exposed }, 'image ExposedPorts');

    try {
        // This has been done for hostConf.PortBindings already in
        // validateCreateContainer(), but we need to do it for the image
        // as well:
        validate.assert.portBindings(exposed, 'Image ExposedPorts');
    } catch (valErr) {
        callback(valErr);
        return;
    }

    for (e in exposed) {
        try {
            addPort(e, exposed[e], false);
        } catch (addErr) {
            callback(new errors.DockerError(
                'Image ExposedPorts: ' + addErr.message));
            return;
        }
    }

    exposed = hostConf.PortBindings || {};
    log.info({ exposed: exposed }, 'image HostConfig.PortBindings');
    for (e in exposed) {
        try {
            addPort(e, exposed[e], true);
        } catch (addErr) {
            callback(new errors.DockerError(
                'publish port: ' + addErr.message));
            return;
        }
    }

    ['tcp', 'udp'].forEach(function (portProto) {

        if (allPorts[portProto].length > 0) {
            payload.internal_metadata['docker:' + portProto + '_all_ports'] =
                JSON.stringify(allPorts[portProto]);
        }

        // The "bound ports" don't actually affect any connectivity between
        // hosts, since we don't remap ports or have the concept of a host
        // that we're binding to - they're just for populating
        // HostConfig.PortBindings correctly.

        if (boundPorts[portProto].length !== 0) {
            payload.internal_metadata['docker:' + portProto + '_bound_ports'] =
                JSON.stringify(boundPorts[portProto]);
        }

        var ports = exposedPorts[portProto];

        if (ports.length === 0) {
            return;
        }

        var protoRules = generateExposeRules(opts.account, payload.uuid,
            portProto, ports);
        if (protoRules.length === 0) {
            return;
        }

        log.info({ ports: ports, rules: protoRules },
            'Publishing %s ports', portProto.toUpperCase());
        addToFWAPI = addToFWAPI.concat(protoRules);
        payload.internal_metadata['docker:' + portProto + '_published_ports'] =
            JSON.stringify(ports);
    });

    if (publishAllPorts) {
        payload.internal_metadata['docker:publish_all_ports'] = true;
    }

    addRulesToFWAPI(opts, addToFWAPI, payload, callback);
}


/**
 * Create the given rules in FWAPI.  If successful, adds them to the payload.
 */
function addRulesToFWAPI(opts, rules, payload, callback) {
    if (rules.length === 0) {
        callback();
        return;
    }

    var fwapi = getFwapiClient(opts.config.fwapi);

    function _addFwRule(rule, cb) {
        fwapi.createRule(rule, {
            headers: {'x-request-id': opts.req_id}
        }, function (createErr, created) {
            if (createErr) {
                opts.log.error({ err: createErr, rule: rule },
                    'Error creating firewall rule');
            }

            if (created) {
                opts.log.info({ rule: created }, 'Created firewall rule');
            }

            cb(createErr, created);
            return;
        });
    }

    vasync.forEachParallel({
        func: _addFwRule,
        inputs: rules
    }, function (vErr, results) {
        if (vErr) {
            callback(errors.fwapiErrorWrap(vErr,
                'problem adding firewall rules'));
            return;
        }

        if (results.successes.length !== 0) {
            addRulesToPayload(payload, results.successes);
        }

        callback();
        return;
    });
}


/**
 * Add networks to the payload: 'external' if no fabrics are enabled.  If
 * fabrics are enabled, then add the user's default fabric network.  If
 * fabrics are enabled and the container is publishing ports, also add the
 * NAT pool as a public-facing network.
 */
function addNetworksToPayload(opts, container, payload, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    if (opts.config.overlay.enabled) {
        opts.log.debug('Fabrics configured: using for networking');
        return addFabricNetworksToPayload(opts, container, payload, callback);
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

/**
 * Add a rule or rules to payload.firewall_rules
 */
function addRulesToPayload(payload, rules) {
    var rulesArr = util.isArray(rules) ? rules : [ rules ];

    if (!payload.firewall_rules) {
        payload.firewall_rules = [];
    }

    payload.firewall_rules = payload.firewall_rules.concat(
        // Clean up any rules with extra parsed data (from doing listRules
        // with extra fields)
        rulesArr.map(function (r) {
            delete r.parsed;
            return r;
        }));
}

/**
 * Updates the internal docker: metadata to include link information, and
 * returns the link details via the callback.
 */
function getLinkDetails(opts, configLinks, vm_payload, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.app.vmapi, 'opts.app.vmapi');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    if (!configLinks) {
        callback();
        return;
    }

    var log = opts.log;

    log.debug('getLinkDetails for: %s', configLinks);

    function getLinkEnvForVm(link, vmobj) {
        var targetEnvArray;
        var envArray = [];
        var uAlias = link.alias.toUpperCase().replace('-', '_');
        var im = vmobj.internal_metadata;
        var bestMatch = null;

        // Add linked targetEnv variables to the envArray.
        // <alias>_NAME = /<container_name>/<target_name>
        envArray.push(uAlias + '_NAME=/' + vm_payload.alias + '/' + link.alias);

        // Add environment variables from the linked container.
        if (im['docker:env']) {
            targetEnvArray = JSON.parse(im['docker:env']);
            targetEnvArray.forEach(function (e) {
                var targetEnvName = e.split('=', 1)[0];
                // Ignore a few variables that are added during docker build
                // (and not really relevant to linked containers).
                if (targetEnvName === 'HOME' || targetEnvName === 'PATH') {
                    return;
                }
                // <alias>_ENV_<variable>
                envArray.push(uAlias + '_ENV_' + e);
            });
        }

        function addLinkedNetworkPortsToEnv(nic, proto, port) {
            // Adds these env names:
            //   <alias>_PORT_<port>_<protocol>
            //   <alias>_PORT_<port>_<protocol>_ADDR
            //   <alias>_PORT_<port>_<protocol>_PORT
            //   <alias>_PORT_<port>_<protocol>_PROTO
            var e = uAlias + '_PORT_' + port + '_' + proto.toUpperCase();
            log.debug('Adding linked env port: ' + e);
            envArray.push(e + '=' + proto + '://' + nic.ip + ':' + port);
            envArray.push(e + '_ADDR=' + nic.ip);
            envArray.push(e + '_PORT=' + port);
            envArray.push(e + '_PROTO=' + proto);
        }

        // Add network ports and /etc/hosts entry.
        vmobj.nics.forEach(function (nic) {
            // Look for network tag with a '/' in it - as that signifies an
            // internal network, which containers can best communicate over.
            if (bestMatch === null || nic.nic_tag.indexOf('/') >= 0) {
                bestMatch = nic;
            }
        });

        if (bestMatch) {
            // Add exposed network ports.
            ['tcp', 'udp'].forEach(function (proto) {
                var imKey = 'docker:' + proto + '_all_ports';
                if (im[imKey]) {
                    JSON.parse(im[imKey]).forEach(function (port) {
                        addLinkedNetworkPortsToEnv(bestMatch, proto, port);
                    });
                }
            });
        }

        return envArray;
    }

    // Generate the /etc/hosts entries.
    function getLinkHostnamesForVm(link, vmobj) {
        var bestMatch = null;
        var hosts = '';

        vmobj.nics.forEach(function (nic) {
            // Look for network tag with a '/' in it - as that signifies an
            // internal network, which containers can best communicate over.
            if (bestMatch === null || nic.nic_tag.indexOf('/') >= 0) {
                bestMatch = nic;
            }
        });

        if (bestMatch) {
            // There are three host entries per linked vm.
            hosts += bestMatch.ip + '\t'
                    + link.alias.replace('-', '_') + ' '
                    + vmobj.hostname.replace('-', '_') + ' '
                    + vmobj.alias.replace('-', '_') + '\n';
        }

        return hosts;
    }

    /*
     * Ensure that each link exists, the HostConfig.Links array looks like:
     *   `["web:aliasweb", "db:db"]`
     */
    function getLinkDetail(linkconfig, cb) {
        var target;
        var alias;
        var idx = linkconfig.indexOf(':');
        if (idx <= 0) {
            return cb(new errors.DockerError(
                    'Invalid link config entry found: ' + linkconfig
                    + ', expected to find a colan character.'));
        }
        target = linkconfig.slice(0, idx);
        alias = linkconfig.slice(idx+1);

        // Find machines matching these targets.
        getVmById(target, {
            log: log,
            req_id: opts.req_id,
            account: opts.account,
            vmapi: opts.app.vmapi
        }, function (find_err, vmobj) {

            if (find_err) {
                return cb(new errors.DockerError(
                        'Could not get container for ' + target));
            }

            log.debug('found link target: %s, uuid: %s', target, vmobj.uuid);

            // Found container, store a link.
            var link = {
                owner_uuid: opts.account.uuid,
                container_uuid: vm_payload.uuid,
                container_name: vm_payload.alias,
                target_uuid: vmobj.uuid,
                target_name: target,
                alias: alias
            };
            var envArray = getLinkEnvForVm(link, vmobj);
            var hosts = getLinkHostnamesForVm(link, vmobj);
            var result = { link: link, envArray: envArray, hosts: hosts };

            cb(null, result);
        });
    }

    vasync.forEachParallel({
        'func': getLinkDetail,
        'inputs': configLinks
    }, function (err, results) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, results.successes);
    });
}

/**
 * Apply the link data to the container metadata.
 */
function applyLinksToMetadata(im, linkDetails) {
    var hosts = '';
    var envArray = [];

    // Merge all link entries into one env and host setting.
    linkDetails.forEach(function (details) {
        envArray = envArray.concat(details.envArray);
        hosts += details.hosts;
    });
    im['docker:linkHosts'] = hosts;
    im['docker:linkEnv'] = JSON.stringify(envArray);
}

function storeLinks(opts, linkDetails, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.object(linkDetails, 'linkDetails');
    assert.func(callback, 'callback');

    if (!linkDetails) {
        return callback();
    }

    function createLink(linkDetail, cb) {
        Link.create(opts.app, opts.log, linkDetail.link, cb);
    }

    vasync.forEachParallel({
        'func': createLink,
        'inputs': linkDetails
    }, function (err) {
        if (err) {
            return callback(err);
        }
        callback();
    });
}

function deleteLinks(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.vm, 'opts.vm');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var linksToDelete = [];

    function findLinkCallbackWrapper(cb) {
        return function (err, links) {
            if (err) {
                log.warn('Error finding links for %s: %s', opts.vm.uuid, err);
            } else if (links && links.length > 0) {
                linksToDelete = linksToDelete.concat(links);
            }
            cb();
        };
    }

    vasync.pipeline({ funcs: [
        function (_, cb) {
            // Find links whose target container is being deleted.
            var params = {
                owner_uuid: opts.account.uuid,
                target_uuid: opts.vm.uuid
            };
            Link.find(opts.app, log, params, findLinkCallbackWrapper(cb));
        },
        function (_, cb) {
            // Find links for the container being deleted.
            var params = {
                owner_uuid: opts.account.uuid,
                container_uuid: opts.vm.uuid
            };
            Link.find(opts.app, log, params, findLinkCallbackWrapper(cb));
        },
        function (_, cb) {
            // Delete the links we found.
            log.info('deleteLinks: found ' + linksToDelete.length + ' links');
            linksToDelete.forEach(function (l) {
                Link.del(opts.app, log, l, function () {});
            });
        }
    ]});
}

function renameLinks(opts, newName, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;

    vasync.waterfall([
        _findContainerLinks,
        _updateContainerLinks,
        _findTargetLinks,
        _updateTargetLinks
    ], _done);

    function _findContainerLinks(next) {
        // Find all links this container uses.
        var params = {
            container_uuid: opts.vm.uuid,
            owner_uuid: opts.account.uuid
        };
        Link.find(opts.app, log, params, next);
    }

    function _updateContainerName(link, next) {
        log.debug('updating link container name from [%s] to [%s]',
                    link.container_name, newName);
        link.container_name = newName;
        link.save(opts.app, next);
    }

    function _updateContainerLinks(links, next) {
        if (!links || links.length === 0) {
            return next();
        }
        // Update all links this container uses.
        vasync.forEachParallel({
            func: _updateContainerName,
            inputs: links
        }, function (err, results) {
            next(err);
        });
    }

    function _findTargetLinks(next) {
        // Find all links this container is referenced by.
        var params = {
            target_uuid: opts.vm.uuid,
            owner_uuid: opts.account.uuid
        };
        Link.find(opts.app, log, params, next);
    }

    function _updateTargetName(link, next) {
        log.debug('updating link target name from [%s] to [%s]',
                    link.target_name, newName);
        link.target_name = newName;
        link.save(opts.app, next);
    }

    function _updateTargetLinks(links, next) {
        if (!links || links.length === 0) {
            return next();
        }
        // Update all links this container is referenced by.
        vasync.forEachParallel({
            func: _updateTargetName,
            inputs: links
        }, function (err, results) {
            next(err);
        });
    }

    function _done(err) {
        callback(err);
    }
}

function getPackage(opts, container, callback) {
    assert.func(callback, 'callback');
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.papi, 'opts.config.papi');
    assert.number(opts.config.defaultMemory, 'opts.config.defaultMemory');
    assert.string(opts.config.packagePrefix, 'opts.config.packagePrefix');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.account, 'opts.account');
    assert.number(opts.clientApiVersion, 'opts.clientApiVersion');

    var log = opts.log;
    var papi = getPapiClient(opts.config.papi);

    papi.list('name=' + opts.config.packagePrefix + '*', {
        headers: {'x-request-id': opts.req_id}
    }, function (err, pkgs, count) {
            var candidate = {};
            var constraints = {};
            var memory;
            // Starting with docker API v1.18, the memory value
            // for the host is passed in the container.HostConfig object,
            // not directly in the container object.
            if (opts.clientApiVersion < 1.18) {
                if (container.Memory)
                    memory = Number(container.Memory);
            } else {
                if (container.HostConfig && container.HostConfig.Memory)
                    memory = Number(container.HostConfig.Memory);
            }

            if (memory) {
                // Values always come in bytes from client, but we want MiB.
                constraints.memory = common.humanSizeFromBytes(memory);
                memory = memory / (1024 * 1024);
            }

            if (isNaN(memory)) {
                // value of default is in MiB
                memory = opts.config.defaultMemory;
                log.warn({memory: memory}, 'using default memory value');
            }

            log.info({
                account: opts.account.uuid,
                memory: memory
            }, 'looking for minimal package that meets parameters');
            log.trace({count: count, err: err, pkgs: pkgs}, 'listPackages');

            if (err) {
                callback(new errors.papiErrorWrap(
                    err, 'problem listing packages'));
                return;
            }

            if (count === 0) {
                callback(new errors.DockerError('no packages found'));
                return;
            }

            pkgs.forEach(function (pkg) {

                if (pkg.owner_uuids && (pkg.owner_uuids.length > 0)) {
                    if (!opts.account || !opts.account.uuid) {
                        log.warn({candidate: pkg}, 'skipping candidate because'
                            + ' cannot identify owner');
                        return;
                    } else if (pkg.owner_uuids.indexOf(opts.account.uuid)
                        === -1) {

                        log.debug({
                            account_uuid: opts.account.uuid,
                            candidate: pkg
                        }, 'skipping candidate because owner does not match');
                        return;
                    }
                }

                if (!pkg.active) {
                    log.info({
                        account_uuid: opts.account.uuid,
                        candidate: pkg
                    }, 'skipping candidate because package is not active');
                    return;
                }

                if (pkg.max_physical_memory >= memory) {
                    if (!candidate.hasOwnProperty('max_physical_memory')) {
                        candidate = pkg;
                        log.trace({
                            account: opts.account.uuid,
                            candidate: candidate,
                            target_memory: memory
                        }, 'initial candidate');
                    } else if (pkg.max_physical_memory
                        < candidate.max_physical_memory) {

                        candidate = pkg;
                        log.trace({
                            account: opts.account.uuid,
                            candidate: candidate,
                            target_memory: memory
                        }, 'new candidate');
                    }
                } else {
                    log.trace({
                        account: opts.account.uuid,
                        candidate: pkg,
                        target_memory: memory
                    }, 'unacceptable candidate');
                }
            });

            if (!candidate.uuid) {
                callback(new errors.NoSufficientPackageError(constraints));
                return;
            }

            log.debug({pkg: candidate}, 'selected package for VM');
            callback(null, candidate.uuid);
        }
    );
}


function listDockerVms(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.vmapi, 'opts.vmapi'); // vmapi client
    assert.object(opts.log, 'opts.log');
    assert.optionalBool(opts.all, 'opts.all'); // docker ps -a
    assert.optionalBool(opts.one, 'opts.one'); // docker stop/start
    assert.func(callback, 'callback');

    var params = {};

    // query for one vm or all vms must include running/stopped
    if (opts.one || opts.all) {
        params.predicate = JSON.stringify({
            and: [
                { eq: [ 'docker', true ] },
                { and:
                    [
                        { ne: [ 'state', 'failed' ] },
                        { ne: [ 'state', 'destroyed' ] }
                    ]
                },
                { eq: [ 'owner_uuid', opts.account.uuid ] }
            ]
        });
    } else {
        params.predicate = JSON.stringify({
            and: [
                { eq: [ 'docker', true ] },
                { eq: [ 'state', 'running' ] },
                { eq: [ 'owner_uuid', opts.account.uuid ] }
            ]
        });
    }

    // XXX should we need headers?
    opts.vmapi.listVms(params, {
        fields: '*',
        headers: {'x-request-id': opts.req_id}
    }, function _listVmsCb(err, vms, _req, _res) {
        if (err) {
            opts.log.error(err, 'Error retrieving Virtual Machines');
            return callback(errors.vmapiErrorWrap(
                err, 'problem retrieving virtual machines'));
        }

        opts.log.debug('Found ' + vms.length + ' VMs');
        callback(null, vms);
    });
}

function ltrim(str, chars)
{
    chars = chars || '\\s';
    str = str || '';
    return str.replace(new RegExp('^[' + chars + ']+', 'g'), '');
}

/**
 * Returns true if the container is publishing ports
 */
function publishingPorts(container) {
    var hostConf = container.HostConfig;

    if (hostConf.PublishAllPorts || !common.objEmpty(hostConf.PortBindings)) {
        return true;
    }

    return false;
}

/**
 * Build the VM payload for a new docker container.
 *
 * On error, this calls back with one of the errors exported by 'errors.js'.
 * IOW, callers of this function don't need to wrap the error for response
 * to the user.
 */
function buildVmPayload(opts, container, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.image, 'opts.image');
    assert.object(opts.vmapi, 'opts.vmapi'); // vmapi client
    assert.object(container, 'container');
    assert.number(opts.clientApiVersion, 'opts.clientApiVersion');

    var binds;
    var dockerid;
    var imgConfig = opts.image.config || {};
    var log = opts.log;
    var logConfig;
    var logDriver;
    var simple_map = {
        Hostname: 'hostname',
        Domainname: 'dns_domain'
    };
    var payload = {
        firewall_enabled: true,
        owner_uuid: opts.account.uuid
    };
    var restartPolicy;
    var volumesFrom;

    Object.keys(simple_map).forEach(function (k) {
        if (container.hasOwnProperty(k) && container[k].length > 0) {
            payload[simple_map[k]] = container[k];
        }
    });

    // generate a uuid + dockerid
    payload.uuid = libuuid.create();
    dockerid = (payload.uuid + libuuid.create()).replace(/-/g, '');

    // If there was no hostname passed, use the first 12 characters of dockerid
    // like docker does.
    if (!payload.hasOwnProperty('hostname')) {
        payload.hostname = dockerid.substr(0, 12);
    }

    payload.alias = ltrim(container.Name, '/');
    payload.internal_metadata = {
        'docker:id': dockerid
    };

    payload.tags = {
        'sdc_docker': true
    };
    // Add docker labels as prefixed tags on the vm.
    if (imgConfig.Labels) {
        Object.keys(imgConfig.Labels).forEach(function (key) {
            payload.tags[common.LABELTAG_PREFIX + key] = imgConfig.Labels[key];
        });
    }
    if (container.Labels) {
        Object.keys(container.Labels).forEach(function (key) {
            payload.tags[common.LABELTAG_PREFIX + key] = container.Labels[key];
        });
    }

    if (container.Cmd) {
        payload.internal_metadata['docker:cmd'] = JSON.stringify(container.Cmd);
    }

    if (container.Entrypoint) {
        payload.internal_metadata['docker:entrypoint']
            = JSON.stringify(container.Entrypoint);
    }

    if (container.Tty) {
        payload.internal_metadata['docker:tty'] = true;
    }

    if (container.AttachStdin) {
        payload.internal_metadata['docker:attach_stdin'] = true;
    }

    if (container.AttachStdout) {
        payload.internal_metadata['docker:attach_stdout'] = true;
    }

    if (container.AttachStderr) {
        payload.internal_metadata['docker:attach_stderr'] = true;
    }

    if (container.OpenStdin) {
        payload.internal_metadata['docker:open_stdin'] = true;
    }

    if (container.Env) {
        if (container.Env.length > 0) {
            payload.internal_metadata['docker:env'] =
                JSON.stringify(container.Env);
        }
    }

    if (container.User) {
        payload.internal_metadata['docker:user'] = container.User;
    }

    if (container.WorkingDir) {
        payload.internal_metadata['docker:workdir'] = container.WorkingDir;
    }

    restartPolicy = container.RestartPolicy
        || container.HostConfig && container.HostConfig.RestartPolicy;
    if (restartPolicy && restartPolicy.Name) {
        if (restartPolicy.Name === 'always') {
            payload.internal_metadata['docker:restartpolicy'] = 'always';
        } else if (restartPolicy.Name === 'on-failure') {
            if (restartPolicy.MaximumRetryCount) {
                payload.internal_metadata['docker:restartpolicy'] =
                    'on-failure:' + restartPolicy.MaximumRetryCount.toString();
            } else {
                payload.internal_metadata['docker:restartpolicy']
                    = 'on-failure';
            }
        }
    }

    // This was already validated in lib/validate.js
    if (container.HostConfig && container.HostConfig.LogConfig) {
        if (container.HostConfig.LogConfig.Type.length > 0) {
            payload.internal_metadata['docker:logdriver']
                = container.HostConfig.LogConfig.Type;
        } else {
            payload.internal_metadata['docker:logdriver'] = 'json-file';
        }

        logDriver
            = common.LOG_DRIVERS[payload.internal_metadata['docker:logdriver']];
        logConfig = container.HostConfig.LogConfig.Config;

        if (logDriver.default_opts) {
            Object.keys(logDriver.default_opts).forEach(
                function _applyDefaultOpt(opt) {
                    if (!logConfig.hasOwnProperty(opt)) {
                        if (logDriver.default_opts[opt] === '{{.ID}}') {
                            logConfig[opt] = dockerid.substr(0, 12);
                        } else {
                            logConfig[opt] = logDriver.default_opts[opt];
                        }
                    }
                }
            );
        }

        // Special-case default for syslog driver, default to port 514
        if (payload.internal_metadata['docker:logdriver'] === 'syslog') {
            if (logConfig['syslog-address'].split(':').length === 2) {
                logConfig['syslog-address']
                    = logConfig['syslog-address'] + ':514';
            }
        }

        // Special-case for fluentd-tag markup tags
        if (payload.internal_metadata['docker:logdriver'] === 'fluentd') {
            if (logConfig['fluentd-tag']) {
                logConfig['fluentd-tag'].replace(/{{.ID}}/g,
                    dockerid.substr(0, 12));
                logConfig['fluentd-tag'].replace(/{{.FullID}}/g, dockerid);
                logConfig['fluentd-tag'].replace(/{{.Name}}/g, payload.alias);
            }
        }

        payload.internal_metadata['docker:logconfig']
            = JSON.stringify(logConfig);
    }

    if (container.HostConfig && container.HostConfig.Dns
        && Array.isArray(container.HostConfig.Dns)
        && (container.HostConfig.Dns.length > 0)) {

        payload.resolvers = container.HostConfig.Dns;
    }
    if (container.HostConfig && container.HostConfig.DnsSearch
        && Array.isArray(container.HostConfig.DnsSearch)
        && (container.HostConfig.DnsSearch.length > 0)) {

        payload.internal_metadata['docker:dnssearch']
            = JSON.stringify(container.HostConfig.DnsSearch);
    }

    payload.autoboot = false; // because docker does create & start separately
    payload.docker = true;
    payload.restart_init = false;
    payload.tmpfs = 0;
    payload.filesystems = [];

    function _addDataVolume(volpath) {
        var volume_uuid = libuuid.create();

        payload.filesystems.push({
            source: volume_uuid,
            target: path.normalize(volpath).replace(/\/$/, ''), // rm trailing /
            type: 'lofs',
            options: []
        });
    }

    /*
     * "Host" volumes created using -v http[s]://example/file:/container/file
     * We'll download http[s]://example/file and write it to a new directory in
     * the zone's dataset but not in the zoneroot, and we'll mount that into the
     * container at /container/file.
     */
    binds = container.Binds
        || container.HostConfig && container.HostConfig.Binds;
    if (binds && binds.length > 0) {
        log.error({host_volumes: binds},
            'host volumes are not supported');
        callback(new errors.DockerError(
            'host volumes are not supported'));
        return;
    }

    /*
     * {
     *   "AttachStdin": false,
     *   "AttachStdout": false,
     *   "AttachStderr": false,
     *   "PortSpecs": null,
     *   "ExposedPorts": {},
     *   "Tty": false,
     *   "OpenStdin": false,
     *   "StdinOnce": false,
     *   "Volumes": {},
     *   "Entrypoint": null,
     *   "NetworkDisabled": false,
     *   "OnBuild": null,
     *   "SecurityOpt": null,
     *   "HostConfig": {
     *     "Binds": null,
     *     "ContainerIDFile": "",
     *     "LxcConf": [],
     *     "Privileged": false,
     *     "PortBindings": {},
     *     "Links": null,
     *     "PublishAllPorts": false,
     *     "Dns": null,
     *     "DnsSearch": null,
     *     "ExtraHosts": null,
     *     "VolumesFrom": null,
     *     "Devices": [],
     *     "NetworkMode": "bridge",
     *     "CapAdd": null,
     *     "CapDrop": null,
     *     "RestartPolicy": {
     *       "Name": "",
     *       "MaximumRetryCount": 0
     *     }
     *   }
     * }
     */

    vasync.pipeline({funcs: [
        function handleNetworks(_, cb) {
            addNetworksToPayload(opts, container, payload, cb);
        },

        function handleVolumesFrom(_, cb) {
            // This must happen after we've added the owner_uuid to the payload.
            // ...and is where we add --volumes-from volumes.

            var get_opts = {
                account: opts.account,
                log: log,
                req_id: opts.req_id,
                vmapi: opts.vmapi
            };
            var vf_containers = [];

            function _addContainerVolumes(id, next) {
                /* JSSTYLED */
                var data_volume_regex = /\/volumes\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
                var msg;

                // get container
                getVmById(id, get_opts, function (err, vmobj) {
                    if (err) {
                        next(err);
                        return;
                    }

                    // First check the owner. Other checks might be cheaper to
                    // do first, but we don't want to leak information about
                    // other customers' VMs, so we fail on this first.
                    if (vmobj.owner_uuid !== payload.owner_uuid) {
                        msg = 'Owners do not match, cannot --volumes-from';
                        log.error({
                            source_owner: vmobj.owner_uuid,
                            target_owner: payload.owner_uuid
                        }, msg);
                        next(new errors.DockerError(msg));
                        return;
                    }

                    if (!vmobj.docker) {
                        msg = 'Container is not a "docker" container, cannot '
                            + '--volumes-from';
                        next(new errors.DockerError(msg));
                        return;
                    }

                    if (vmobj.filesystems) {
                        vmobj.filesystems.forEach(function (f) {
                            // if the filesystem entry doesn't look like a
                            // volume, or if it's a volume that isn't under
                            // this VM's zonepath, we'll skip it.
                            if (f.source.match(data_volume_regex)
                                && (f.source.indexOf(vmobj.zonepath) === 0)) {

                                payload.filesystems.push(f);
                            }
                        });
                    }

                    vf_containers.push(vmobj.uuid);

                    next();
                });
            }

            volumesFrom = container.VolumesFrom
                || container.HostConfig && container.HostConfig.VolumesFrom;
            if (volumesFrom) {
                if (volumesFrom.length > MAX_VOLUMES_FROM) {
                    log.error({volumes_from: volumesFrom}, 'too many '
                        + '--volumes-from options: max ' + MAX_VOLUMES_FROM);
                    cb(new errors.DockerError('too many --volumes-from: max '
                        + MAX_VOLUMES_FROM));
                    return;
                }

                // vf is an array of container "names"

                vasync.forEachParallel({
                    'func': _addContainerVolumes,
                    'inputs': volumesFrom
                }, function (err) {
                    if (err) {
                        // `forEachParallel` returns a `verror.MultiError`
                        // which only shows the message from the first error.
                        var msg = err.ase_errors.map(
                            function (e) { return e.message; }).join(', ');
                        cb(new errors.DockerError(err, msg));
                        return;
                    }

                    payload.internal_metadata['docker:volumesfrom']
                        = JSON.stringify(vf_containers);
                    cb();
                });
                return;
            }
            cb();
        },

        function handleVolumes(_, cb) {
            var existing = {};

            /*
             * Regular -v /data volumes, we'll create a new ZFS dataset for
             * these. Happens after HostVolumes and VolumesFrom so that we can
             * give those priority.
             */
            if (!container.Volumes) {
                cb();
                return;
            }

            if (payload.filesystems) {
                payload.filesystems.forEach(function (f) {
                    existing[f.target] = true;
                });
            }

            if (Object.keys(container.Volumes).length > MAX_DATA_VOLUMES) {
                log.error({data_volumes: container.Volumes},
                    'too many data volumes: max ' + MAX_DATA_VOLUMES);
                cb(new errors.DockerError('too many data volumes: max '
                    + MAX_DATA_VOLUMES));
                return;
            }

            Object.keys(container.Volumes).forEach(function (v) {
                // v will be something like: `/dir` and container.Volumes[v]
                // will be an object with options.

                if (existing[v]) {
                    log.warn(v + ' already added by VolumesFrom or HostVolume '
                        + 'not adding new volume');
                    return;
                }
                _addDataVolume(v);
            });

            cb();
        },

        function selectPackage(_, cb) {
            getPackage(opts, container, function (err, package_uuid) {
                if (!err) {
                    payload.billing_id = package_uuid;
                }
                cb(err);
            });
        },

        function addImageData(_, cb) {
            payload.image_uuid = opts.image.image_uuid;

            if (opts.image.os === 'smartos') {
                payload.brand = 'joyent-minimal';
                payload.init_name = '/usr/vm/sbin/dockerinit';
            } else {
                payload.brand = 'lx';
                payload.init_name = '/native/usr/vm/sbin/dockerinit';
                payload.internal_metadata['docker:noipmgmtd'] = true;
                payload.kernel_version = VM_DEFAULT_KERNEL_VERSION;
            }

            if (imgConfig.Image) {
                payload.internal_metadata['docker:imageid'] = imgConfig.Image;
            }
            if (container.Image) {
                // the original name the user passed
                payload.internal_metadata['docker:imagename'] = container.Image;
            }

            if (!payload.internal_metadata['docker:entrypoint']
                && !payload.internal_metadata['docker:cmd'] && imgConfig.Cmd) {

                payload.internal_metadata['docker:cmd'] =
                    JSON.stringify(imgConfig.Cmd);
            }
            if (!payload.internal_metadata['docker:entrypoint']
                && imgConfig.Entrypoint) {

                payload.internal_metadata['docker:entrypoint'] =
                    JSON.stringify(imgConfig.Entrypoint);
            }
            if (imgConfig.Env) {
                var existing;
                if (payload.internal_metadata['docker:env']) {
                    existing = JSON.parse(payload
                        .internal_metadata['docker:env']);
                } else {
                    existing = [];
                }
                payload.internal_metadata['docker:env'] =
                    JSON.stringify(imgConfig.Env.concat(existing));
            }
            if (imgConfig.Volumes) {
                Object.keys(imgConfig.Volumes).forEach(function (v) {
                    var exists = false;

                    payload.filesystems.forEach(function (f) {
                        if (f.target === v) {
                            exists = true;
                        }
                    });

                    if (exists) {
                        log.warn({volume: v}, 'volume specified both in payload'
                            + ' and image, ignoring volume from image');
                    } else {
                        _addDataVolume(v);
                    }
                });
            }
            if (!payload.internal_metadata['docker:workdir']
                && imgConfig.WorkingDir) {

                payload.internal_metadata['docker:workdir'] =
                    imgConfig.WorkingDir;
            }
            if (!payload.internal_metadata['docker:user'] && imgConfig.User) {
                payload.internal_metadata['docker:user'] = imgConfig.User;
            }

            cb();

        }, function (_, cb) {
            addExposeFirewallRules(opts, payload, cb);

        }, function (_, cb) {
            addPublishFirewallRules(opts, container, opts.image, payload, cb);

        }, function ensureDefaultInternalMetadata(_, cb) {
            if (!payload.internal_metadata['docker:cmd']) {
                payload.internal_metadata['docker:cmd'] = '[]';
            }
            if (!payload.internal_metadata['docker:entrypoint']) {
                payload.internal_metadata['docker:entrypoint'] = '[]';
            }
            if (!payload.internal_metadata['docker:env']) {
                payload.internal_metadata['docker:env'] = '[]';
            }
            cb();
        }
    ]}, function (err, results) {
        log.debug({err: err, payload: payload},
            'buildVmPayload done');
        callback(err, payload);
    });
}

/*
 * Find matching container, where container is a vmobj (not docker container).
 *
 * id here can be any of:
 *
 *  64-byte Docker ID
 *  12-char Shortened docker ID
 *  container name (alias)
 */
function findContainerIdMatch(id, objects) {
    // Docker gives precedence to container names over container ids
    // only when a partial id is passed. If a full id (64 bytes) is passed,
    // then it takes precedence over container name matching
    var match;
    var matches = {
        full: [],
        alias: [],
        partial: []
    };

    objects.forEach(function (obj) {
        var dockerId = obj.internal_metadata['docker:id'];

        if (dockerId === undefined) {
            return false;
        }

        if (id.length === 64 && dockerId === id) {
            matches.full.push(obj);
        // Alias match
        } else if (id.length > 0 && obj.alias.length > 0
            && id === obj.alias) {
            matches.alias.push(obj);
        // Partial id match
        } else if (id.length > 0 && dockerId.substr(0, id.length) === id) {
            matches.partial.push(obj);
        }
    });

    // Full id match means there should only ever be one match and more
    // than one alias or partial id match means we can't return anything
    if (matches.full.length) {
        match = matches.full[0];
    } else if (matches.alias.length == 1) {
        match = matches.alias[0];
    } else if (matches.partial.length == 1) {
        match = matches.partial[0];
    }

    return match;
}


/*
 * Find this container id from the list of all docker containers.
 */
function getVmById(id, opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.vmapi, 'opts.vmapi');

    var log = opts.log;
    opts.one = true;

    listDockerVms(opts, function (err, objects) {
        if (err) {
            callback(err);
            return;
        }

        var match = findContainerIdMatch(id, objects);
        if (match !== undefined) {
            callback(null, match);
        } else {
            log.error('findUuidForId(' + id + '): not found');
            callback(new restify.ResourceNotFoundError(
                'container "' + id + '" not found'));
        }
    });
}


//---- exported SdcBackend methods

function getContainerCount(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var vmapi = getVmapiClient(this.config.vmapi);
    var params = {
        predicate: JSON.stringify({
            and: [
                { eq: [ 'docker', true ] },
                { and:
                    [
                        { ne: [ 'state', 'failed' ] },
                        { ne: [ 'state', 'destroyed' ] }
                    ]
                },
                { eq: [ 'owner_uuid', opts.account.uuid ] }
            ]
        })
    };

    vmapi.countVms(params, {
        fields: '*',
        headers: {'x-request-id': opts.req_id}
    }, function _countVmsCb(err, vmcount, _req, _res) {
        if (err) {
            opts.log.error(err, 'Error retrieving Virtual Machine count');
            return callback(errors.vmapiErrorWrap(
                err, 'problem retrieving virtual machine count'));
        }

        callback(null, vmcount);
    });
}


function getContainers(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.number(opts.clientApiVersion, 'opts.clientApiVersion');
    assert.arrayOfObject(opts.images, 'opts.images');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log || this.log;
    var vmapi = opts.app.vmapi;

    listDockerVms({
        log: log,
        req_id: opts.req_id,
        account: opts.account,
        vmapi: vmapi,
        all: opts.all
    }, function (getvm_err, objects) {
        var match;
        var filters;

        if (getvm_err) {
            callback(getvm_err);
            return;
        }

        // Containers are sorted newest (0) to oldest (n).
        objects.sort(function (entry1, entry2) {
            if (entry1.create_timestamp > entry2.create_timestamp) {
                return -1;
            } else if (entry1.create_timestamp < entry2.create_timestamp) {
                return 1;
            }
            return 0;
        });

        if (opts.since) {
            match = findContainerIdMatch(opts.since, objects);
            if (!match) {
                callback(new errors.DockerError(
                    'Could not find container with name or id '
                    + opts.since));
                return;
            }
            objects = objects.slice(0, objects.indexOf(match));
        }

        if (opts.before) {
            match = findContainerIdMatch(opts.before, objects);
            if (!match) {
                callback(new errors.DockerError(
                    'Could not find container with name or id '
                    + opts.before));
                return;
            }
            objects = objects.slice(objects.indexOf(match)+1);
        }

        if (opts.filters) {
            filters = JSON.parse(opts.filters);
            Object.keys(filters).forEach(function (field) {
                var val = filters[field];
                log.debug('filter on field ' + field + ', value ' + val);
                if (field == 'status') {
                    objects = objects.filter(function (entry) {
                        var val_to_sdc_running_val = {
                            'running': 'running',
                            'restarting': 'restarting',
                            'paused': 'paused',
                            'exited': 'stopped'
                        };
                        // val is an *array* of acceptable values, map to
                        // the sdc value and check if this entry matches
                        // any of the requested values.
                        return val.map(function (v) {
                            return val_to_sdc_running_val[v];
                        }).indexOf(entry.state) >= 0;
                    });
                } else if (field == 'exited') {
                    // val is an *array* of acceptable return codes as
                    // *strings*, so convert exit_status to string and
                    // compare with the requested values.
                    objects = objects.filter(function (entry) {
                        return val.indexOf(String(entry.exit_status)) >= 0;
                    });
                } else if (field == 'id') {
                    // val is an *array* of acceptable docker id's
                    // *strings*, so find any containers matching
                    // the requested values.
                    objects = objects.filter(function (entry) {
                        var id = entry.internal_metadata['docker:id'];
                        for (var i = 0; i < val.length; i++) {
                            if (id.match(val[i])) {
                                return true;
                            }
                        }
                        return false;
                    });
                } else if (field == 'name') {
                    // val is an *array* of acceptable docker name's
                    // *strings*, so find any containers matching
                    // the requested values.
                    objects = objects.filter(function (entry) {
                        for (var i = 0; i < val.length; i++) {
                            if (entry.alias.match(val[i]) !== null) {
                                return true;
                            }
                        }
                        return false;
                    });
                } else if (field == 'label') {
                    // val is an *array* of acceptable docker name's
                    // *strings*, so find any containers matching
                    // *all* of the requested values.
                    for (var j = 0; j < val.length; j++) {
                        // val[i] is either 'key' or 'key=value'
                        var labelSplit = val[j].split('=', 2);
                        var wantedTag = common.LABELTAG_PREFIX + labelSplit[0];
                        objects = objects.filter(function (entry) {
                            if (entry.tags) {
                                var tag;
                                var tags = Object.keys(entry.tags);
                                for (var k = 0; k < tags.length; k++) {
                                    tag = tags[k];
                                    if (tag === wantedTag) {
                                        if (!labelSplit[1]
                                            || entry.tags[tag] == labelSplit[1])
                                        {
                                            return true;
                                        }
                                    }
                                }
                            }
                            return false;
                        });
                    }
                } else {
                    log.warn('Unhandled docker filter name:', field);
                }
            });
        }

        if (opts.limit > 0) {
            objects = objects.slice(0, opts.limit);
        }

        function _containerForVmObj(vmobj, cb) {
            utils.vmobjToContainer({
                clientApiVersion: opts.clientApiVersion,
                app: opts.app,
                imgs: opts.images,
                log: log
            }, vmobj, cb);
        }

        vasync.forEachPipeline({
            'func': _containerForVmObj,
            'inputs': objects
        }, function (err, results) {
            if (err) {
                callback(err);
                return;
            }
            callback(null, results.successes);
        });
    });
}

function createContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.number(opts.clientApiVersion, 'opts.clientApiVersion');

    var log = opts.log || this.log;
    var name = opts.name;
    var config = this.config;
    var container = opts.payload;
    var vmapi = opts.app.vmapi;
    var vm_payload;
    var linkDetails;

    vasync.waterfall([
        _buildPayload,
        _addLinks,
        _createVm,
        _saveLinks
    ], _done);

    function _buildPayload(cb) {
        // XXX check that "name" is not already used? VMAPI also does that.
        container.Name = name;
        buildVmPayload({
            app: opts.app,
            config: config,
            image: opts.image,
            log: log,
            req_id: opts.req_id,
            account: opts.account,
            vmapi: vmapi,
            clientApiVersion: opts.clientApiVersion
        }, container, function (err, _vm_payload) {
            if (err) {
                return cb(err);
            }
            vm_payload = _vm_payload;
            if (vm_payload.internal_metadata['docker:entrypoint'] === '[]'
                && vm_payload.internal_metadata['docker:cmd'] === '[]') {

                // Container must have *some* command to run or it cannot boot.
                log.error({
                    container: container,
                    vm_payload: vm_payload
                }, 'missing both Cmd and Entrypoint');
                cb(new errors.DockerError('No command specified'));
                return;
            }
            cb();
        });
    }

    function _addLinks(cb) {
        var configLinks = container.HostConfig.Links;
        getLinkDetails(opts, configLinks, vm_payload, function (err, details) {
            linkDetails = details || [];
            if (err) {
                return cb(err);
            }
            applyLinksToMetadata(vm_payload['internal_metadata'], linkDetails);
            cb();
        });
    }

    function _createVm(cb) {
        log.debug({container: container, vm_payload: vm_payload},
            'built payload');

        vmapi.createVm({
            payload: vm_payload,
            sync: true
        }, {headers: {'x-request-id': opts.req_id}}, function (err, res) {
            if (err) {
                cb(errors.vmapiErrorWrap(err, 'problem creating container'));
                return;
            }
            cb();
        });
    }

    function _saveLinks(cb) {
        storeLinks(opts, linkDetails, cb);
    }

    function _done(err) {
        if (err) {
            return callback(err);
        }
        callback(null, { DockerId: vm_payload.internal_metadata['docker:id'] });
    }
}

function stopContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    if (opts.timeout) {
        assert.ok(!isNaN(opts.timeout), 'opts.timeout');
    }

    var log = opts.log || this.log;
    var timeout = opts.timeout;
    var vmapi = opts.app.vmapi;

    var stopHeaders = { headers: { 'x-request-id': opts.req_id } };
    var stopParams = {
        context: opts.context,
        creator_uuid: opts.creator_uuid,
        idempotent: true,
        origin: opts.origin,
        owner_uuid: opts.account.uuid,
        sync: true,
        timeout: timeout,
        uuid: opts.vm.uuid
    };

    log.debug('stopParams: ' + JSON.stringify(stopParams));
    stopParams.log = log;

    vmapi.stopVm(stopParams, stopHeaders, function (stop_err, job) {
        if (stop_err) {
            log.error(stop_err, 'Error stopping container.');
            callback(errors.vmapiErrorWrap(
                stop_err, 'problem stopping container'));
            return;
        }

        log.debug('job: ' + JSON.stringify(job));
        callback();
    });
}

function restartContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    if (opts.timeout) {
        assert.ok(!isNaN(opts.timeout), 'opts.timeout');
    }

    var log = opts.log || this.log;
    var timeout = opts.timeout;
    var vmapi = opts.app.vmapi;

    var restartHeaders = { headers: { 'x-request-id': opts.req_id } };
    var restartParams = {
        context: opts.context,
        creator_uuid: opts.creator_uuid,
        idempotent: true,
        origin: opts.origin,
        owner_uuid: opts.account.uuid,
        sync: true,
        timeout: timeout,
        uuid: opts.vm.uuid
    };

    // First, check if vm needs updating, if so pass an 'update' param.
    checkForContainerUpdate(opts, function (err, update) {
        if (err) {
            return callback(err);
        }

        if (update) {
            log.info('rebootVm with update');
            restartParams['update'] = update;
        }

        log.debug('restartParams: ' + JSON.stringify(restartParams));
        restartParams.log = log;

        vmapi.rebootVm(restartParams, restartHeaders,
                        function (restart_err, job) {
            if (restart_err) {
                log.error(restart_err, 'Error restarting container.');
                callback(errors.vmapiErrorWrap(
                    restart_err, 'problem restarting container'));
                return;
            }

            log.debug('job: ' + JSON.stringify(job));
            callback();
        });
    });
}

function killContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    if (opts.signal) {
        assert.ok((['string', 'number'].indexOf(typeof (opts.signal)) !== -1),
            'opts.signal');
    }

    var log = opts.log || this.log;
    var vmapi = opts.app.vmapi;

    var killHeaders = { headers: { 'x-request-id': opts.req_id } };
    var killParams = {
        context: opts.context,
        creator_uuid: opts.creator_uuid,
        idempotent: true,
        origin: opts.origin,
        owner_uuid: opts.account.uuid,
        sync: true,
        uuid: opts.vm.uuid
    };

    if (opts.signal) {
        if ((typeof (opts.signal) === 'string')
            && (opts.signal.match(/^[0-9]+$/))) {

            // An integer signal being sent as a string. Fix it.
            killParams.signal = Number(opts.signal);
        } else {
            killParams.signal = opts.signal;
        }
    }

    log.debug('killParams: ' + JSON.stringify(killParams));
    killParams.log = log;

    vmapi.killVm(killParams, killHeaders, function (kill_err, job) {
        if (kill_err) {
            // caller must log
            callback(errors.vmapiErrorWrap(
                kill_err,
                'problem sending signal to container'));
            return;
        }

        log.debug('job: ' + JSON.stringify(job));
        callback();
    });
}

/**
 * Check if the vm needs an internal_metadata update before the vm is started.
 * If an update is needed, this function will return an 'update' object that
 * can be passed to the vmapi.startVm call.
 *
 * @param callback {Function} `function (err, update)`
 */
function checkForContainerUpdate(opts, callback) {
    var log = opts.log || this.log;

    // Docker links: compare the internal_metadata to see if the configuration
    //               has changed.
    var params = {
        owner_uuid: opts.account.uuid,
        container_uuid: opts.vm.uuid
    };
    Link.find(opts.app, log, params, function (err, links) {
        if (err) {
            log.error(err, 'Error finding links');
            return callback(errors.vmapiErrorWrap(err,
                'problem starting container'));
        }

        var im = opts.vm.internal_metadata;
        var configLinks;

        // If there were no links before and none now, then nothing to do.
        if (!im || (!links && !im['docker:linkHosts'])) {
            return callback();
        }

        log.debug('checkForContainerUpdate links: ', links);

        configLinks = links.map(function (link) {
            return link.host_config;
        });

        getLinkDetails(opts, configLinks, opts.vm, function (linkErr, details) {
            if (linkErr) {
                return callback(linkErr);
            }

            var update = null;
            var newIm = {};

            applyLinksToMetadata(newIm, details);

            // Compare the links and create an update if they are different.
            if (newIm['docker:linkHosts'] !== im['docker:linkHosts']
                || newIm['docker:linkEnv'] !== im['docker:linkEnv'])
            {
                update = { 'set_internal_metadata': newIm };
            }

            callback(null, update);
        });
    });
}


function startContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log || this.log;
    var vmapi = opts.app.vmapi;

    var startHeaders = { headers: { 'x-request-id': opts.req_id } };
    var startParams = {
        context: opts.context,
        creator_uuid: opts.creator_uuid,
        idempotent: true,
        origin: opts.origin,
        owner_uuid: opts.account.uuid,
        sync: true,
        uuid: opts.vm.uuid
    };

    // First, check if vm needs updating, if so pass an 'update' param.
    checkForContainerUpdate(opts, function (err, update) {
        if (err) {
            return callback(err);
        }

        if (update) {
            log.info('startVm with update');
            startParams['update'] = update;
        }

        log.debug('startParams: ' + JSON.stringify(startParams));
        startParams.log = log;

        vmapi.startVm(startParams, startHeaders, function (start_err, job) {
            if (start_err) {
                log.error(start_err, 'Error starting container.');
                return callback(errors.vmapiErrorWrap(start_err,
                    'problem starting container'));
            }

            log.debug({job: job}, 'created start job');
            callback();
        });
    });
}


function deleteContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.bool(opts.force, 'opts.force');
    assert.bool(opts.link, 'opts.link');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.string(opts.id, 'opts.id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log || this.log;
    var vmapi = opts.app.vmapi;

    var deleteHeaders = { headers: { 'x-request-id': opts.req_id } };
    var deleteParams = {
        context: opts.context,
        creator_uuid: opts.creator_uuid,
        origin: opts.origin,
        owner_uuid: opts.account.uuid,
        sync: true,
        uuid: opts.vm.uuid
    };

    var data_prefix;
    var data_volumes = [];
    var volume_users = [];

    // Sanity check for accidently deleting a container via link.
    if (opts.link) {
        callback(new errors.DockerError(
            new Error(), 'Conflict, cannot remove the default name '
            + 'of the container'));
        return;
    }

    if (!opts.force && opts.vm.state === 'running') {
        callback(new errors.DockerError(
            new Error(), 'Conflict, You cannot remove a running '
            +  'container. Stop the container before attempting removal '
            + 'or use -f'));
        return;
    }

    // Eventually, IMO, deleting a "provisioning" container should "work":
    // be that a deletion after it is provisioned, or cancelling the provision
    // and deleting it (i.e. interruptible provision job).
    if (opts.vm.state === 'provisioning') {
        callback(new errors.DockerError(fmt(
            'Conflict, cannot currently remove a provisioning '
            +  'container (id %s).', opts.id)));
        return;
    }

    // Sanity check for deleting a container sharing its volumes.
    listDockerVms({
        log: log,
        req_id: opts.req_id,
        account: opts.account,
        vmapi: vmapi,
        all: true
    }, function (getvm_err, objects) {
        if (getvm_err) {
            callback(getvm_err);
            return;
        }

        // NOTE: The only case where we shouldn't have opts.vm.zonepath is when
        //       the VM is still being provisioned. In which case it shouldn't
        //       have any other containers using it for --volumes-from.
        if (opts.vm.filesystems && opts.vm.filesystems.length > 0
            && opts.vm.zonepath)
        {
            data_prefix = path.join(opts.vm.zonepath, 'volumes') + '/';
            opts.vm.filesystems.forEach(function (f) {
                if (f.source.substr(0, data_prefix.length) === data_prefix) {
                    data_volumes.push(f.source);
                }
            });
        }
        if (data_volumes.length > 0) {
            log.info({'uuid': opts.vm.uuid, volumes: data_volumes}, 'VM has'
                + ' local data volumes, checking other containers for '
                + '--volumes-from');
            objects.forEach(function (v) {
                if (v.server_uuid !== opts.vm.server_uuid) {
                    return;
                }
                if (!v.filesystems || v.uuid === opts.vm.uuid) {
                    return;
                }
                v.filesystems.forEach(function (f) {
                    data_volumes.forEach(function (d) {
                        if (d === f.source) {
                            if (volume_users.indexOf(v.alias) === -1) {
                                volume_users.push(v.alias);
                            }
                        }
                    });
                });
            });
        }

        if (volume_users.length !== 0) {
            callback(new errors.DockerError('Error deleting container: '
                + opts.vm.alias + ' is sharing its volume(s) with '
                + volume_users.join(', ') + '.'));
            return;
        }

        vmapi.deleteVm(deleteParams, deleteHeaders,
            function _deleteVmCb(deleteErr, job) {
                if (deleteErr) {
                    log.error(deleteErr, 'Error deleting container.');
                    return callback(errors.vmapiErrorWrap(
                            deleteErr, 'problem deleting container'));
                }

                // Remove the docker links for this container.
                deleteLinks(opts);

                log.debug({job: job}, 'created start job');
                callback();
            });
    });
}


function deleteLink(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.link, 'opts.link');
    assert.optionalObject(opts.log, 'opts.log');

    var linkAlias = opts.link;
    var log = opts.log || this.log;

    var params = {
        owner_uuid: opts.vm.owner_uuid,
        container_uuid: opts.vm.uuid,
        alias: linkAlias
    };

    // Should only get back one link with the given alias and
    // container_uuid.
    function onFindLink(err, links) {
        if (err) {
            log.error('Error finding link for container %s, link %s: %s',
                    opts.vm.uuid, linkAlias, err);
            callback(new errors.DockerError(err,
                    'Unable to find link: ' + opts.vm.alias + '/' + linkAlias));
            return;
        }
        if (!links) {
            callback(new errors.DockerError(new Error(),
                    'Unable to find link: ' + opts.vm.alias + '/' + linkAlias));
            return;
        }
        // Delete the link(s) found.
        links.forEach(function (l) {
            Link.del(opts.app, log, l, function () {});
        });
        log.debug('Deleted %d link(s) for link name [%s/%s]',
                links.length, opts.vm.alias, linkAlias);

        callback();
    }

    // Fetch links for this container.
    Link.find(opts.app, log, params, onFindLink);
}


function inspectContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.number(opts.clientApiVersion, 'opts.clientApiVersion');
    assert.arrayOfObject(opts.images, 'opts.images');
    assert.optionalObject(opts.log, 'opts.log');
    assert.object(opts.vm, 'opts.vm');



    utils.vmobjToInspect({
        clientApiVersion: opts.clientApiVersion,
        app: opts.app,
        imgs: opts.images,
        log: opts.log
    }, opts.vm, callback);
}

function psContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log || this.log;
    var vmapi = opts.app.vmapi;
    var procOpts = { uuid: opts.vm.uuid };
    var procHeaders = { headers: { 'x-request-id': opts.req_id } };

    vmapi.getVmProc(procOpts, procHeaders, function (getErr, vmproc) {
        if (getErr) {
            log.error(getErr, 'Error getting container processes.');
            return callback(errors.cnapiErrorWrap(
                getErr, null, { id: opts.id }));
        }

        // format matches Ubuntu 14.04 + docker 1.3.2
        var psdata = {
            Titles: [
                'UID',
                'PID',
                'PPID',
                'C',
                'STIME',
                'TTY',
                'TIME',
                'CMD'
            ], Processes: []
        };

        log.debug({proc: vmproc, uuid: opts.vm.uuid}, 'container /proc');

        vmproc.forEach(function (p) {
            psdata.Processes.push([
                p.psinfo.pr_euid.toString(),
                p.psinfo.pr_pid.toString(),
                p.psinfo.pr_ppid.toString(),
                p.psinfo.pr_pctcpu.toString(),
                p.psinfo.pr_start.toString(),
                p.psinfo.pr_ttydev.toString(),
                p.psinfo.pr_time.toString(),
                p.psinfo.pr_psargs
            ]);
        });

        return callback(null, psdata);
    });
}

function waitContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log || this.log;
    var vmapi = opts.app.vmapi;

    var waitHeaders = { headers: { 'x-request-id': opts.req_id } };
    var waitOpts = { uuid: opts.vm.uuid };

    function waitVm() {
        vmapi.getVm(waitOpts, waitHeaders, function (getErr, vm) {
            if (getErr) {
                log.error(getErr, 'Error getting container.');
                return callback(getErr);
            } else if (vm.state === 'stopped') {
                callback(null, vm.exit_status);
            } else {
                setTimeout(waitVm, 1000);
            }
        });
    }

    waitVm();
}


// These are the params passed given the CLI options:
//
// exec -i:
//      Tty: false,
//      AttachStdin: true,
//
// exec -t:
//      Tty: true,
//      AttachStderr: true,
//      AttachStdout: true,
//
// exec -d:
//      "Detach": true,
//      AttachStdin: false,
//      AttachStderr: false,
//      AttachStdout: false,
//
// execStart will send the same parameters along.
//
function execContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.payload, 'opts.payload');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    _runCreateSocket(opts, function (err, cmdId, socketData) {
        if (err) {
            callback(err);
            return;
        }

        opts.app.sockets.setSocket('exec', cmdId, socketData);
        callback(null, cmdId);
    });
}


function execStart(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.cmdId, 'opts.cmdId');
    assert.optionalString(opts.id, 'opts.id');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.socketData, 'opts.socketData');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.socket, 'opts.socket');

    _runExec(opts, function (err, socketData) {
        if (err) {
            callback(err);
            return;
        }

        opts.socket.end();
        callback(null, socketData);
    });
}


function _runCreateSocket(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.payload, 'opts.payload');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log;
    var payload = opts.payload;

    dockerExec({
        log: log,
        id: opts.id,
        payload: payload,
        req_id: opts.req_id,
        cnapi: opts.app.cnapi,
        vm: opts.vm
    }, function (execErr, obj) {
        if (execErr) {
            callback(execErr);
            return;
        }

        var cmdId = common.generateDockerId();
        var socketData = { command: payload };

        // When -d is passed, we don't need to connect to any TCP
        // server afterwards
        if (payload.Detach) {
            callback(null, cmdId, socketData);
            return;
        }

        // Stash the address of the temporary TCP server
        socketData.host = obj.host;
        socketData.port = obj.port;

        callback(null, cmdId, socketData);
    });
}


var STREAM_TYPES = {
    stdin: 0,
    stdout: 1,
    stderr: 2
};

/**
 * Write to docker-raw compatible streams
 */
function _encodeToDockerRawStream(type, data) {
    var streamType = STREAM_TYPES[type];
    var messageSize = data.length;
    var message = new Buffer(8 + messageSize);

    message.writeUInt8(streamType, 0);
    message[1] = 0;
    message[2] = 0;
    message[3] = 0;
    message.writeUInt32BE(messageSize, 4);
    message.write(data.toString(), 8);
    return message;
}


/**
 * This lstream parser allows sdc-docker to parse any message coming from
 * the transient cn-agent sockets.
 */
function _createLinestreamParser(opts, toSocket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.socketData, 'opts.socketData');
    assert.object(toSocket, 'toSocket');

    var lstream = new LineStream({ encoding: 'utf8' });
    lstream.on('error', function (err) {
        opts.log.error({ err: err }, 'LineStream threw an error');
    });

    lstream.on('line', function (line) {
        line = line.trim();
        if (!line) {
            return;
        }

        var parsed = JSON.parse(line);

        if (parsed.type === 'tty') {
            toSocket.write(parsed.data);
        } else if (parsed.type === 'end') {
            opts.socketData.ExitCode = parsed.data.code;
            toSocket.end();
        } else { // else stderr or stdout
            var data = _encodeToDockerRawStream(parsed.type, parsed.data);
            toSocket.write(data);
        }
    });

    return lstream;
}


function _runExec(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.cmdId, 'opts.cmdId');
    assert.optionalString(opts.id, 'opts.id');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.socketData, 'opts.socketData');
    assert.object(opts.socket, 'opts.socket');

    var socketData = opts.socketData;
    var host = socketData.host;
    var port = socketData.port;
    var clientSocket = opts.socket;

    var cmdString = socketData.command.Cmd.join(' ');
    var serverSocket = net.createConnection({ host: host, port: port });

    // Store a reference to the exec socket for future resizes
    socketData.socket = serverSocket;

    function writeData(stream, data, writeCb) {
        data = JSON.stringify(data) + '\r\n';

        if (writeCb) {
            stream.write(data, writeCb);
        } else {
            stream.write(data);
        }
    }

    function writeEnd(stream, writeCb) {
        var data = JSON.stringify({
            type: 'end'
        }) + '\r\n';

        stream.write(data, writeCb);
    }

    function _endSocket(error) {
        if (error) {
            opts.log.error('client socket %s threw an error %s',
                cmdString, error.toString());
        }
        serverSocket.end();
        cb(error, socketData);
    }
    // Make sure our callbacks get called only once
    var endSocket = once(_endSocket);
    var cb = once(callback);

    serverSocket.on('connect', setupListeners);

    function setupListeners() {
        if (socketData.command.AttachStdin) {
            clientSocket.on('data', function (chunk) {
                var type = socketData.command.Tty ? 'tty' : 'stdin';
                writeData(serverSocket, {
                    type: type,
                    data: chunk.toString()
                });
            });
        }

        clientSocket.on('end', function () {
            if (!serverSocket.destroyed) {
                writeEnd(serverSocket, function () {
                    opts.log.info('clientSocket has closed its stdin');
                });
            }
        });

        clientSocket.on('error', endSocket);
        clientSocket.on('timeout', endSocket);

        serverSocket.on('error', function (error) {
            opts.log.error('serverSocket for %s threw an error %s',
                cmdString, error.toString());

            endSocket(error);
        });

        serverSocket.on('close', function (had_error) {
            opts.log.debug('serverSocket %s closed, had_error=%s',
                cmdString, had_error);

            endSocket();
        });

        serverSocket.on('end', function () {
            opts.log.debug('serverSocket %s end', cmdString);
        });

        var lstream = _createLinestreamParser({
            log: opts.log,
            socketData: socketData
        }, clientSocket);
        serverSocket.pipe(lstream);
    }
}


function _runAttach(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.optionalString(opts.id, 'opts.id');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.socketData, 'opts.socketData');
    assert.object(opts.socket, 'opts.socket');

    var socketData = opts.socketData;
    var host = socketData.host;
    var port = socketData.port;
    var clientSocket = opts.socket;

    var cmdString = socketData.command.Cmd.join(' ');

    var serverSocket = socketData.socket;
    if (!serverSocket) {
        serverSocket = net.createConnection({ host: host, port: port });
        serverSocket.on('connect', setupListeners);
        socketData.socket = serverSocket;

        // Store socket reference immediately
        opts.app.sockets.setSocket('attach', opts.id, socketData);
    } else {
        // Reuse an existing attach session for a new client socket
        setupListeners();
    }

    function setupListeners() {
        function writeData(stream, data, writeCb) {
            data = JSON.stringify(data) + '\r\n';

            if (writeCb) {
                stream.write(data, writeCb);
            } else {
                stream.write(data);
            }
        }

        function writeEnd(stream, writeCb) {
            var data = JSON.stringify({
                type: 'end'
            }) + '\r\n';

            stream.write(data, writeCb);
        }

        // When using multi attach the _endSocket callback will be GC'd
        // if defined outside of this scope
        function _endSocket(error) {
            if (error) {
                opts.log.error('client socket %s threw an error %s',
                    cmdString, error.toString());
            }
            serverSocket.end();
            cb(error);
        }

        // Make sure our callbacks get called only once
        var endSocket = once(_endSocket);
        var cb = once(callback);

        // When we are attaching to an interactive TTY session we must support
        // resizing the console so our socket supports resize and data message
        // types. Resize messages are queued by docker when calling
        // /containers/id/resize
        function onData(chunk) {
            if (!socketData.command.Tty) {
                writeData(serverSocket, {
                    type: 'stdin',
                    data: chunk.toString()
                });
                return;
            }

            var resizeData = opts.app.sockets.popResize(opts.id);

            if (resizeData) {
                writeData(serverSocket, {
                    type: 'tty',
                    resize: resizeData
                }, function () {
                    writeData(serverSocket, {
                        type: 'tty',
                        data: chunk.toString()
                    });
                });
            } else {
                writeData(serverSocket, {
                    type: 'tty',
                    data: chunk.toString()
                });
            }
        }

        if (socketData.command.AttachStdin) {
            clientSocket.on('data', onData);
        }

        clientSocket.on('end', function () {
            writeEnd(serverSocket, function () {
                opts.log.info('clientSocket has closed its stdin');
            });
        });

        clientSocket.on('error', endSocket);
        clientSocket.on('timeout', endSocket);

        serverSocket.on('error', function (error) {
            opts.log.debug('attach for %s threw an error %',
                cmdString, error.toString());

            endSocket(error);
        });

        serverSocket.on('close', function (had_error) {
            opts.log.debug('attach %s closed, had_error=%s',
                cmdString, had_error);

            endSocket();
        });

        serverSocket.on('end', function () {
            opts.log.debug('attach %s end', cmdString);
        });

        var lstream = _createLinestreamParser({
            log: opts.log,
            socketData: socketData
        }, clientSocket);
        serverSocket.pipe(lstream);
    }
}


function execResize(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.socketData, 'opts.socketData');
    assert.number(opts.w, 'opts.w');
    assert.number(opts.h, 'opts.h');

    var socket = opts.socketData.socket;
    var data = JSON.stringify({
        type: 'tty',
        resize: { w: opts.w, h: opts.h }
    }) + '\r\n';

    socket.write(data, callback);
}


/*
 * attachContainer resuses _runExec and _runCreateSocket
 */
function attachContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.payload, 'opts.payload');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.socket, 'opts.socket');
    assert.object(opts.account, 'opts.account');

    var log = opts.log;
    var socketData = opts.app.sockets.getSocket('attach', opts.id);

    vasync.pipeline({
        funcs: [
            createSocket,
            attach
        ]
    }, callback);


    function createSocket(_, next) {
        if (socketData) {
            opts.socketData = socketData;
            next();
            return;
        }

        _runCreateSocket(opts, function (err, cmdId, data) {
            if (err) {
                log.error({err: err}, 'backend.attachContainer error');
                next(err);
                return;
            }

            opts.socketData = data;
            next();
        });
    }

    function attach(_, next) {
        _runAttach(opts, function (execErr) {
            // Cleanup regardless of the error
            opts.app.sockets.removeSocket('attach', opts.id);
            opts.socket.end();

            if (execErr) {
                log.error({err: execErr}, 'backend._runAttach error');
                next(execErr);
                return;
            }

            next();
        });
    }
}


/*
 * Rename a container.
 */
function renameContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.name, 'opts.name');
    assert.optionalObject(opts.log, 'opts.log');
    assert.object(opts.account, 'opts.account');

    if (!utils.isValidDockerConatinerName(opts.name)) {
        callback(new errors.DockerError(
                'Error when allocating new name: Invalid container name ('
                + opts.name + ')'));
        return;
    }

    var log = opts.log;
    var vmapi = opts.app.vmapi;

    var renameHeaders = { headers: { 'x-request-id': opts.req_id } };
    var renameParams = {
        uuid : opts.vm.uuid,
        owner_uuid : opts.account.uuid,
        sync : true,
        payload : {
            'alias': opts.name
        }
    };

    log.debug({renameParams: renameParams}, 'rename parameters');
    renameParams.log = log;

    vmapi.updateVm(renameParams, renameHeaders, function (rename_err, job) {
        if (rename_err) {
            log.error(rename_err, 'Error renaming container.');
            callback(errors.vmapiErrorWrap(rename_err,
                            'problem renaming container'));
            return;
        }

        log.debug({job: job}, 'rename job');

        // Update docker link names.
        renameLinks(opts, opts.name, callback);
    });
}


/*
 * Resize a container TTY.
 *
 * This endpoint lets an existing attach know that an active TTY console
 * should be resized
 */
function resizeContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.number(opts.w, 'opts.w');
    assert.number(opts.h, 'opts.h');

    opts.app.sockets.pushResize(opts.id, { w: opts.w, h: opts.h });
    callback();
}


/*
 * containerLogs resuses _runExec and _runCreateSocket
 */
function containerLogs(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.payload, 'opts.payload');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.vm, 'opts.vm');

    var log = opts.log;
    var log_driver = 'json-file';

    if (opts.vm.internal_metadata
        && opts.vm.internal_metadata['docker:logdriver']) {

        log_driver = opts.vm.internal_metadata['docker:logdriver'];
    }

    if (log_driver !== 'json-file') {
        /*
         * IMPORTANT:
         *
         * The client *also* checks this if using the normal docker cli. So a
         * user might get this message without even talking to us.
         *
         */
        callback(new errors.DockerError(
            '"logs" command is supported only for "json-file" logging driver '
            + '(got: ' + log_driver + ')'));
        return;
    }

    _runCreateSocket(opts, function (err, cmdId, socketData) {
        if (err) {
            log.error({err: err}, 'backend.containerLogs error');
            callback(err);
            return;
        }

        opts.cmdId = cmdId;
        opts.socketData = socketData;

        _runExec(opts, function (execErr) {
            opts.socket.end();

            if (execErr) {
                log.error({err: execErr}, 'backend.containerLogs error');
                callback(execErr);
                return;
            }

            callback();
        });
    });
}


function dockerExec(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.cnapi, 'opts.cnapi');

    var e;
    var log = opts.log;
    var cnapi = opts.cnapi;
    var execHeaders = { headers: { 'x-request-id': opts.req_id } };

    if (!opts.vm || !opts.vm.uuid) {
        e = new errors.DockerError(new Error(), 'VM is still provisioning');
        log.error({vm: opts.vm, err: e},
            'dockerExec() called with missing VM parameters');
        callback(e);
        return;
    } else if (!opts.vm.server_uuid) {
        e = new errors.DockerError(new Error(), 'VM is still provisioning');
        log.error({vm: opts.vm, err: e},
            'dockerExec() called with missing VM server_uuid');
        callback(e);
        return;
    }

    cnapi.dockerExec(opts.vm.server_uuid, opts.vm.uuid, {
        command: opts.payload
    }, execHeaders, function _execCb(execErr, res) {
        if (execErr) {
            log.error(execErr, 'Error calling docker-exec');
            return callback(errors.cnapiErrorWrap(
                execErr, 'problem executing command', { id: opts.id }));
        }

        return callback(null, res);
    });
}


function copyContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.payload, 'opts.payload');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log;
    var payload = opts.payload;

    dockerCopy({
        log: log,
        payload: payload,
        req_id: opts.req_id,
        account: opts.account,
        cnapi: opts.app.cnapi,
        vm: opts.vm
    }, function (copyErr, stream) {
        if (copyErr) {
            callback(copyErr);
            return;
        }

        callback(null, stream);
    });
}


function dockerCopy(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.cnapi, 'opts.cnapi');

    var log = opts.log;
    var cnapi = opts.cnapi;
    var copyHeaders = { headers: { 'x-request-id': opts.req_id } };

    cnapi.dockerCopy(opts.vm.server_uuid, opts.vm.uuid, {
        payload: opts.payload
    }, copyHeaders, copyCb);

    function copyCb(copyErr, res) {
        if (copyErr) {
            log.error(copyErr, 'error calling docker-copy');
            return callback(errors.cnapiErrorWrap(
                copyErr, 'problem calling docker copy'));
        }

        var host = res.host;
        var port = res.port;

        var copySocket = net.createConnection({ host: host, port: port });

        callback(null, copySocket);
    }
}


function containerStats(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.socket, 'opts.socket');

    var log = opts.log;
    var cnapi = opts.app.cnapi;
    var headers = { headers: { 'x-request-id': opts.req_id } };

    cnapi.dockerStats(opts.vm.server_uuid, opts.vm.uuid, {
        payload: opts.payload
    }, headers, function (err, res) {
        if (err) {
            log.error(err, 'error calling docker-stats');
            return callback(errors.cnapiErrorWrap(
                err, 'problem calling docker stats'));
        }

        var host = res.host;
        var port = res.port;

        log.debug('containerStats server on host: ', host, 'port: ', port);

        var statsSocket = net.createConnection({ host: host, port: port });

        callback(null, statsSocket);
    });
}


module.exports = {
    attachContainer: attachContainer,
    containerLogs: containerLogs,
    containerStats: containerStats,
    copyContainer: copyContainer,
    createContainer: createContainer,
    deleteContainer: deleteContainer,
    deleteLink: deleteLink,
    execContainer: execContainer,
    execResize: execResize,
    execStart: execStart,
    getContainerCount: getContainerCount,
    getContainers: getContainers,
    getVmById: getVmById,
    inspectContainer: inspectContainer,
    killContainer: killContainer,
    psContainer: psContainer,
    renameContainer: renameContainer,
    resizeContainer: resizeContainer,
    restartContainer: restartContainer,
    startContainer: startContainer,
    stopContainer: stopContainer,
    waitContainer: waitContainer
};
