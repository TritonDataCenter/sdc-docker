/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var common = require('../../../lib/common');
var errors = require('../../../lib/errors');
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
var util = require('util');
var validate = require('../../validate');

var utils = require('./utils');



//---- globals

var _cnapiClientCache; // set in `getCnapiClient`
var _fwapiClientCache; // set in `getFwapiClient`
var _imgapiClientCache; // set in `getImgapiClient`
var _napiClientCache; // set in `getNapiClient`
var _papiClientCache; // set in `getPapiClient`
var _vmapiClientCache; // set in `getVmapiClient`

// Number of exposed ports per protocol (TCP, UDP) to allow: this is limited
// by the number that FWAPI supports in one rule.
var EXPOSED_PORTS = 8;
var VM_DEFAULT_KERNEL_VERSION = '3.13.0';

var MAX_DATA_VOLUMES = 8; // volumes that are local to this VM
var MAX_HOST_VOLUMES = 8; // volumes that are mounted from Manta
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
    var listParams = {
        fabric: true,
        name: 'default',
        provisionable_by: opts.account.uuid
    };
    var log = opts.log;
    var requireExternal = false;

    if (publishingPorts(container)) {
        requireExternal = true;
    }

    listNetworks(opts, listParams, function (err, networks) {
        log.debug({
            err: err,
            res: networks,
            provisionable_by: opts.account.uuid},
            'list fabric networks');

        if (err) {
            callback(errors.napiErrorWrap(err,
                'could not list fabric networks'));
            return;
        }

        if (!networks || networks.length === 0) {
            callback(new errors.DockerError(
                'no default fabric network found'));
            return;
        }

        if (networks.length > 1) {
            callback(new errors.DockerError(
                'more than one default fabric network found'));
            return;
        }

        payload.networks = [ {uuid: networks[0].uuid} ];

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
                addRulesToPayload(payload, rules[r]);
            }

            if (parsed.protocol === 'udp' && !udpRuleFound) {
                udpRuleFound = true;
                addRulesToPayload(payload, rules[r]);
            }
        }

        if (tcpRuleFound && udpRuleFound) {
            callback();
            return;
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

        function _addFwRule(rule, cb) {
            fwapi.createRule(rule, {
                headers: {'x-request-id': opts.req_id}
            }, function (createErr, created) {
                if (createErr) {
                    opts.log.error({ err: createErr, rule: rule },
                        'Error creating firewall rule');
                }

                cb(createErr, created);
                return;
            });
        }

        vasync.forEachParallel({
            func: _addFwRule,
            inputs: rulesToAdd
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
    });
}

/**
 * If the user has requested ports to be published, create firewall rules that
 * open up those ports.
 */
function addPublishFirewallRules(opts, container, image, payload, callback) {
    var e;
    var exposed;
    var hostConf = container.HostConfig;
    var log = opts.log;
    var boundPorts = {
        tcp: [],
        udp: []
    };
    var exposedPorts = {
        tcp: [],
        udp: []
    };

    if (!publishingPorts(container)) {
        // Nothing to publish externally, so there's no point in adding the
        // firewall rules
        log.info('not publishing ports, so not adding publish firewall rules');
        callback();
        return;
    }

    function addPort(port, portVal, bound) {
        var portNum;
        var proto;
        var split = port.split('/');

        portNum = Number(split[0]);
        proto = split[1].toLowerCase();

        exposedPorts[proto].push(portNum);
        if (exposedPorts[proto].length > EXPOSED_PORTS) {
            throw new errors.DockerError('only support exposing %d %s ports',
                EXPOSED_PORTS, proto.toUpperCase());
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

    if (hostConf.PublishAllPorts) {
        exposed = image.data.ExposedPorts || {};

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
    }

    exposed = hostConf.PortBindings || {};
    for (e in exposed) {
        try {
            addPort(e, exposed[e], true);
        } catch (addErr) {
            callback(new errors.DockerError(
                'publish port: ' + addErr.message));
            return;
        }
    }

    if (exposedPorts.tcp.length !== 0) {
        var tcpRule = {
            enabled: true,
            owner_uuid: opts.account.uuid,
            rule: util.format('FROM any to vm %s ALLOW tcp (port %s)',
                payload.uuid, exposedPorts.tcp.sort().join(' AND port ')),
            uuid: libuuid.create()
        };

        log.info({ ports: exposedPorts.tcp, rule: tcpRule },
            'Publishing TCP ports');
        addRulesToPayload(payload, tcpRule);
        payload.internal_metadata['docker:tcp_published_ports'] =
            JSON.stringify(exposedPorts.tcp);
    }

    if (exposedPorts.udp.length !== 0) {
        var udpRule = {
            enabled: true,
            owner_uuid: opts.account.uuid,
            rule: util.format('FROM any to vm %s ALLOW udp (port %s)',
                payload.uuid, exposedPorts.udp.sort().join(' AND port ')),
            uuid: libuuid.create()
        };

        log.info({ ports: exposedPorts.udp, rule: udpRule },
            'Publishing udp ports');
        addRulesToPayload(payload, udpRule);
        payload.internal_metadata['docker:udp_published_ports'] =
            JSON.stringify(exposedPorts.udp);
    }

    // The "bound ports" don't actually affect any connectivity between hosts,
    // since we don't remap ports or have the concept of a host that we're
    // binding to - they're just for populating HostConfig.PortBindings
    // correctly.

    if (boundPorts.tcp.length !== 0) {
        payload.internal_metadata['docker:tcp_bound_ports'] =
            JSON.stringify(boundPorts.tcp);
    }

    if (boundPorts.udp.length !== 0) {
        payload.internal_metadata['docker:udp_bound_ports'] =
            JSON.stringify(boundPorts.udp);
    }

    if (hostConf.PublishAllPorts) {
        payload.internal_metadata['docker:publish_all_ports'] = true;
    }

    callback();
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

function getPackage(opts, container, callback) {
    assert.func(callback, 'callback');
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.papi, 'opts.config.papi');
    assert.number(opts.config.defaultMemory, 'opts.config.defaultMemory');
    assert.string(opts.config.packagePrefix, 'opts.config.packagePrefix');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.account, 'opts.account');

    var log = opts.log;
    var papi = getPapiClient(opts.config.papi);

    papi.list('name=' + opts.config.packagePrefix + '*', {
        headers: {'x-request-id': opts.req_id}
    }, function (err, pkgs, count) {
            var candidate = {};
            var constraints = {};
            var memory;

            if (container.Memory) {
                // Values always come in bytes from client, but we want MiB.
                memory = Number(container.Memory) / (1024 * 1024);
                constraints.memory =
                    common.humanSizeFromBytes(container.Memory);
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

// XXX hack
function getImage(opts, callback) {
    assert.func(callback, 'callback');
    assert.object(opts, 'opts');
    assert.string(opts.imageName, 'opts.imageName');
    assert.func(opts.listImages, 'opts.listImages');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var image_uuid;
    var image_data;
    var log = opts.log;

    vasync.pipeline({ funcs: [
        function (_, cb) {
            if (!utils.isUUID(opts.imageName)) {
                cb();
                return;
            }

            // If the image specified is a standard UUID, it's not a docker
            // registry image name so we assume it's the UUID of an imgapi
            // image and try to get that image from the local imgapi.
            opts.imgapi.getImage(opts.imageName, {
                headers: {'x-request-id': opts.req_id}
            }, function (err, image, res) {
                var e;

                if (!err) {
                    log.info({img: image}, 'found image');
                    image_uuid = opts.imageName;
                    image_data = image;
                    cb();
                    return;
                }
                e = new restify.ResourceNotFoundError(
                    'could not find image ' + opts.imageName);
                e.code = 'EMISSINGIMAGE';
                cb(e);
            });
        }, function (_, cb) {
            if (image_uuid) { // already found
                cb();
                return;
            }
            opts.listImages({
                app: opts.app,
                req_id: opts.req_id,
                account: opts.account,
                log: log,
                url: opts.config.imgapi.url
            }, function (imgapi_err, imgs) {
                var e;

                if (imgapi_err) {
                    cb(imgapi_err);
                    return;
                }

                // Allow specifying repo:tag and default to repo:latest when
                // no tag was specified. RepoTags have two forms:
                // name:tag if official repo (library/ is assumed)
                // namespace/name:tag if not official repo
                var imageName = (opts.imageName.split(':').length === 1 ?
                    (opts.imageName + ':latest') : opts.imageName);
                imageName = imageName.replace(/^library\//, '');

                imgs.forEach(function (img) {
                    if (img.RepoTags.indexOf(imageName) !== -1) {
                        image_uuid = utils.dockerIdToUuid(img.Id);
                        image_data = img;
                    }
                });

                if (!image_uuid) {
                    e = new restify.ResourceNotFoundError(
                        'could not find image ' + opts.imageName);
                    e.code = 'EMISSINGIMAGE';
                    cb(e);
                    return;
                }

                cb();
            });
        }
    ]}, function (err) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, {uuid: image_uuid, data: image_data});
    });
}

function listDockerVms(opts, callback)
{
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
    assert.func(opts.listImages, 'opts.listImages');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.vmapi, 'opts.vmapi'); // vmapi client
    assert.object(container, 'container');

    var bad_host_volumes = [];
    var binds;
    var dockerid;
    var image;
    var log = opts.log;
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
        payload.internal_metadata['docker:workingdir'] = container.WorkingDir;
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

    payload.autoboot = false; // because docker does create & start separately
    payload.docker = true;
    payload.restart_init = false;
    payload.tmpfs = 0;
    payload.filesystems = [];

    function _addDataVolume(volpath) {
        var volume_uuid = libuuid.create();

        payload.filesystems.push({
            source: volume_uuid,
            target: volpath,
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
    if (binds) {
        if (binds.length > MAX_HOST_VOLUMES) {
            log.error({host_volumes: binds},
                'too many host volumes: max ' + MAX_HOST_VOLUMES);
            callback(new errors.DockerError(
                'too many host volumes: max ' + MAX_HOST_VOLUMES));
            return;
        }

        binds.forEach(function (v) {
            // v will be something like `/host:/container[:opts]`
            // but we ignore options for now and just force to 'ro'

            var target;
            var matches;
            var url;

            matches = v.match(/^(https?:\/\/?.*):(\/[^:]+)(:r[ow])?$/);
            if (matches) {
                url = matches[1];
                target = matches[2];

                url = url.replace(/^(https?:\/)([^\/].*)$/, '$1/$2');

                payload.filesystems.push({
                    source: url,
                    target: target,
                    type: 'lofs',
                    options: ['ro']
                });
            } else {
                bad_host_volumes.push(v);
            }
        });

        if (bad_host_volumes.length > 0) {
            callback(new errors.DockerError(
                'Invalid host volume paths found: must be in the'
                + ' form "http://host/path:/container_path": '
                + JSON.stringify(bad_host_volumes)));
            return;
        }
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
            var existing;

            opts.imageName = container.Image;
            opts.imgapi = getImgapiClient(opts.config.imgapi);
            getImage(opts, function (err, img) {

                log.debug({img: img, err: err}, 'getImage() result');

                /*
                 * To add a property from the image, you need to add the
                 * property to pushImage() in lib/backends/sdc/images.js
                 * then you can use it here.
                 */
                if (!err) {

                    image = img;
                    if (img.data.os === 'smartos') {
                        payload.brand = 'joyent-minimal';
                        payload.init_name = '/usr/vm/sbin/dockerinit';
                    } else {
                        payload.brand = 'lx';
                        payload.init_name = '/native/usr/vm/sbin/dockerinit';
                        payload.internal_metadata['docker:noipmgmtd'] = true;
                        payload.kernel_version = VM_DEFAULT_KERNEL_VERSION;
                    }

                    if (!payload.internal_metadata['docker:cmd']
                        && img.data.Cmd) {

                        payload.internal_metadata['docker:cmd'] =
                            JSON.stringify(img.data.Cmd);
                    }
                    if (!payload.internal_metadata['docker:entrypoint']
                        && img.data.Entrypoint) {

                        payload.internal_metadata['docker:entrypoint'] =
                            JSON.stringify(img.data.Entrypoint);
                    }
                    if (img.data.Env) {
                        if (payload.internal_metadata['docker:env']) {
                            existing = JSON.parse(payload
                                .internal_metadata['docker:env']);
                        } else {
                            existing = [];
                        }

                        payload.internal_metadata['docker:env'] =
                            JSON.stringify(img.data.Env.concat(existing));
                    }
                    if (img.data.Volumes) {
                        Object.keys(img.data.Volumes).forEach(function (v) {
                            _addDataVolume(v);
                        });
                    }
                    if (!payload.internal_metadata['docker:workdir']
                        && img.data.WorkingDir) {

                        payload.internal_metadata['docker:workdir'] =
                            img.data.WorkingDir;
                    }
                    if (!payload.internal_metadata['docker:user']
                        && img.data.User) {

                        payload.internal_metadata['docker:user'] =
                            img.data.User;
                    }

                    payload.image_uuid = img.uuid;
                }

                cb(err);
            });

        }, function (_, cb) {
            addExposeFirewallRules(opts, payload, cb);

        }, function (_, cb) {
            addPublishFirewallRules(opts, container, image, payload, cb);

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
 *  12-char Shortend docker ID
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
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    this.listImages({
        app: opts.app,
        log: log,
        req_id: opts.req_id,
        account: opts.account,
        url: this.config.imgapi.url
    }, function (imgapi_err, imgs) {

        if (imgapi_err) {
            log.error({err: imgapi_err}, 'failed to get images');
            callback(imgapi_err);
            return;
        }

        listDockerVms({
            log: log,
            req_id: opts.req_id,
            account: opts.account,
            vmapi: vmapi,
            all: opts.all
        }, function (getvm_err, objects) {
            var match;
            var filters;
            var containers = [];

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
                    }
                });
            }

            if (opts.limit) {
                objects = objects.slice(0, opts.limit);
            }

            objects.forEach(function (obj) {
                var container = utils.vmobjToContainer({
                    imgs: imgs, // XXX this is a hack
                    log: log
                }, obj);
                log.trace({container: container, obj: obj}, 'container');
                containers.push(container);
            });

            callback(null, containers);
        });
    });
}

function createContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log || this.log;
    var name = opts.name;
    var payload = opts.payload;
    var vmapi = getVmapiClient(this.config.vmapi);

    // XXX check that "name" is not already used? VMAPI also does that.

    payload.Name = name;
    buildVmPayload({
        app: opts.app,
        config: this.config,
        listImages: this.listImages,
        log: log,
        req_id: opts.req_id,
        account: opts.account,
        vmapi: vmapi
    }, payload, function (payload_err, vm_payload) {
        if (payload_err) {
            callback(payload_err);
            return;
        }

        if (vm_payload.internal_metadata['docker:entrypoint'] === '[]'
            && vm_payload.internal_metadata['docker:cmd'] === '[]') {

            // A container must have *some* command to run or it cannot boot.
            log.error({
                payload: payload,
                vm_payload: vm_payload
            }, 'missing both Cmd and Entrypoint');
            callback(new errors.DockerError('No command specified'));
            return;
        }

        log.debug({
            name: name,
            payload: payload,
            vm_payload: vm_payload
        }, 'built payload');

        vmapi.createVm({
            payload: vm_payload,
            sync: true
        }, {headers: {'x-request-id': opts.req_id}}, function (err, res) {
            if (err) {
                callback(errors.vmapiErrorWrap(
                    err, 'problem creating container'));
                return;
            }
            callback(null, {
                DockerId: vm_payload.internal_metadata['docker:id']
            });
        });
    });
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
        origin: opts.origin,
        owner_uuid: opts.account.uuid,
        sync: true,
        timeout: timeout,
        uuid: opts.vm.uuid
    };

    log.debug('restartParams: ' + JSON.stringify(restartParams));
    restartParams.log = log;

    vmapi.rebootVm(restartParams, restartHeaders, function (restart_err, job) {
        if (restart_err) {
            log.error(restart_err, 'Error restarting container.');
            callback(errors.vmapiErrorWrap(
                restart_err, 'problem restarting container'));
            return;
        }

        log.debug('job: ' + JSON.stringify(job));
        callback();
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
        origin: opts.origin,
        owner_uuid: opts.account.uuid,
        sync: true,
        uuid: opts.vm.uuid
    };

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
}


function deleteContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.bool(opts.force, 'opts.force');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
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

    if (!opts.force && opts.vm.state === 'running') {
        callback(new errors.DockerError(
            new Error(), 'Conflict, You cannot remove a running '
            +  'container. Stop the container before attempting removal '
            + 'or use -f'));
        return;
    }

    vmapi.deleteVm(deleteParams, deleteHeaders, function (deleteErr, job) {
        if (deleteErr) {
            log.error(deleteErr, 'Error deleting container.');
            return callback(errors.vmapiErrorWrap(
                deleteErr, 'problem deleting container'));
        }

        log.debug({job: job}, 'created start job');
        callback();
    });
}


function inspectContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var log = opts.log || this.log;

    this.listImages({
        app: opts.app,
        log: log,
        req_id: opts.req_id,
        account: opts.account,
        url: this.config.imgapi.url
    }, function (imgapi_err, imgs) {
        if (imgapi_err) {
            log.error({err: imgapi_err}, 'failed to get images');
            callback(imgapi_err);
            return;
        }

        var container = utils.vmobjToInspect({
            imgs: imgs, // XXX this is a hack
            log: log
        }, opts.vm);

        log.trace({container: container, obj: opts.vm}, 'container');

        return callback(null, container);
    });
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
            return callback(getErr);
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
        callback();
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

    var log = opts.log;

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

    var log = opts.log;
    var cnapi = opts.cnapi;
    var execHeaders = { headers: { 'x-request-id': opts.req_id } };

    cnapi.dockerExec(opts.vm.server_uuid, opts.vm.uuid, {
        command: opts.payload
    }, execHeaders, function _execCb(execErr, res) {
        if (execErr) {
            log.error(execErr, 'Error calling docker-exec');
            return callback(errors.cnapiErrorWrap(
                execErr, 'problem executing command'));
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


module.exports = {
    attachContainer: attachContainer,
    containerLogs: containerLogs,
    copyContainer: copyContainer,
    createContainer: createContainer,
    deleteContainer: deleteContainer,
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
