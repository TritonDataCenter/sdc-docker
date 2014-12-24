/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var common = require('../../../lib/common');
var child_process = require('child_process');
var execFile = child_process.execFile;
var spawn = child_process.spawn;
var libuuid = require('libuuid');
var CNAPI = require('sdc-clients').CNAPI;
var NAPI = require('sdc-clients').NAPI;
var PAPI = require('sdc-clients').PAPI;
var vasync = require('vasync');
var VMAPI = require('sdc-clients').VMAPI;
var net = require('net');

var utils = require('./utils');



//---- globals

var _cnapiClientCache; // set in `getCnapiClient`
var _napiClientCache; // set in `getNapiClient`
var _papiClientCache; // set in `getPapiClient`
var _vmapiClientCache; // set in `getVmapiClient`

var VM_DEFAULT_KERNEL_VERSION = '3.13.0';
var VM_DEFAULT_MAX_LWPS = 2000;
var VM_DEFAULT_QUOTA = 100;     // GiB
var VM_DEFAULT_MEMORY = 8192;   // MiB
var VM_DEFAULT_ZFS_IO_PRIORITY = 100;



//---- internal support routines

function getCnapiClient(config) {
    if (!_cnapiClientCache) {
        // intentionally global
        _cnapiClientCache = new CNAPI(config);
    }
    return _cnapiClientCache;
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

function getNetworks(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.napi, 'opts.config.napi');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var log = opts.log;
    var napi = getNapiClient(opts.config.napi);

    napi.listNetworks({}, {
        headers: {'x-request-id': opts.req_id}
    }, function (err, res) {
        log.debug({err: err, res: res}, 'listNetworks');
        if (err) {
            callback(err);
            return;
        }
        callback(null, res);
    });
}

function getPackage(opts, callback) {
    assert.func(callback, 'callback');
    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.object(opts.config.papi, 'opts.config.papi');
    assert.string(opts.config.defaultPackage, 'opts.config.defaultPackage');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var papi = getPapiClient(opts.config.papi);

    papi.list('name=' + opts.config.defaultPackage, {
        headers: {'x-request-id': opts.req_id}
    }, function (err, pkgs, count) {
            log.debug({err: err, pkgs: pkgs, count: count}, 'listPackages');
            if (err) {
                callback(err);
                return;
            }

            if (count !== 1 || pkgs[0].name !== opts.config.defaultPackage) {
                callback(new Error('failed to get package '
                    + opts.config.defaultPackage));
                return;
            }

            callback(null, pkgs[0].uuid);
        }
    );
}

// XXX hack
function getImageUuid(opts, callback) {
    assert.func(callback, 'callback');
    assert.object(opts, 'opts');
    assert.string(opts.imageName, 'opts.imageName');
    assert.func(opts.listImages, 'opts.listImages');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var log = opts.log;

    opts.listImages({
        req_id: opts.req_id,
        log: log,
        url: opts.config.imgapi.url
    }, function (imgapi_err, imgs) {

        var image_uuid;

        if (imgapi_err) {
            callback(imgapi_err);
            return;
        }

        // Allow specifying repo:tag and default to repo:latest when
        // no tag was specified
        var imageName = (opts.imageName.split(':').length === 1 ?
            (opts.imageName + ':latest') : opts.imageName);

        imgs.forEach(function (img) {
            if (img.RepoTags.indexOf(imageName) !== -1) {
                image_uuid = utils.dockerIdToUuid(img.Id);
            }
        });

        if (!image_uuid) {
            callback(new Error('could not find image ' + opts.imageName));
            return;
        }

        callback(null, image_uuid);
    });
}

/*
 * XXX working with the stack is hard in COAL because headnodes are not normally
 * provisionable and are vastly overprovisioned in the case of COAL. To
 * facilitate testing, we always just provision docker containers to the same
 * server this zone is running on for now. If an easier workaround is made to
 * test provisions in COAL, this can be removed.
 */
function getServerUuid(opts, callback) {
    assert.object(opts.log, 'opts.log');

    var log = opts.log;

    execFile('/usr/sbin/mdata-get', ['sdc:server_uuid'],
        function (error, stdout, stderr) {
            var server_uuid;

            if (error) {
                log.error({
                    stdout: stdout,
                    stderr: stderr
                }, 'Unable to get sdc:server_uuid');
                callback(error);
                return;
            }

            server_uuid = stdout.replace(new RegExp('[\\s]+$', 'g'), '');
            assert.string(server_uuid, 'server_uuid');

            callback(null, server_uuid);
        }
    );
}

function listDockerVms(opts, callback)
{
    assert.object(opts, 'opts');
    assert.object(opts.vmapi, 'opts.vmapi'); // vmapi client
    assert.object(opts.log, 'opts.log');
    assert.optionalBool(opts.all, 'opts.all'); // docker ps -a
    assert.optionalBool(opts.one, 'opts.one'); // docker stop/start
    assert.func(callback, 'callback');

    var params = {};

    // query for one vm or all vms must include running/stopped
    if (opts.one || opts.all) {
        params.predicate = '{ "and": [ { "eq": ["docker", true] }, '
        + '{ "and": [{"ne": ["state", "failed"]}, '
        + '{"ne": ["state", "destroyed"]}] } ] }';
    } else {
        params.predicate = '{ "and": [ { "eq": ["docker", true] }, '
        + '{ "eq": ["state", "running"] } ] }';
    }

    // XXX should we need headers?
    opts.vmapi.listVms(params, {
        fields: '*',
        headers: {'x-request-id': opts.req_id}
    }, function _listVmsCb(err, vms, _req, _res) {
        if (err) {
            opts.log.error(err, 'Error retrieving Virtual Machines');
            return callback(err);
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

function buildVmPayload(opts, container, callback) {

    assert.object(opts, 'opts');
    assert.object(opts.config, 'opts.config');
    assert.func(opts.listImages, 'opts.listImages');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(container, 'container');
    assert.string(container.Image, 'container.Image');
    assert.string(container.Name, 'container.Name');

    var dockerid;
    var log = opts.log;
    var simple_map = {
        Hostname: 'hostname',
        Domainname: 'dns_domain',
        CpuShares: 'cpu_shares'
    };
    var payload = {};

    Object.keys(simple_map).forEach(function (k) {
        if (container.hasOwnProperty(k) && container[k].length > 0) {
            payload[simple_map[k]] = container[k];
        }
    });

    // We only hardcode default properties if memory was passed. Otherwise
    // we will use the default package instead.
    if (container.Memory) {
        payload.max_physical_memory = container.Memory / (1024 * 1024);
        payload.ram = payload.max_physical_memory;
        payload.max_locked_memory = payload.max_physical_memory;
        if (container.MemorySwap) {
            payload.max_swap = container.MemorySwap / (1024 * 1024);
        } else {
            payload.max_swap = payload.max_physical_memory * 2;
        }
        payload.max_lwps = VM_DEFAULT_MAX_LWPS;
        payload.quota = VM_DEFAULT_QUOTA;
        payload.zfs_io_priority = VM_DEFAULT_ZFS_IO_PRIORITY;
    }

    // generate a uuid + dockerid
    payload.uuid = libuuid.create();
    dockerid = (payload.uuid + libuuid.create()).replace(/-/g, '');

    payload.alias = ltrim(container.Name, '/');
    payload.internal_metadata = {
        'docker:id': dockerid
    };

    if (container.Cmd) {
        assert.arrayOfString(container.Cmd, 'container.Cmd');
        payload.internal_metadata['docker:cmd'] = JSON.stringify(container.Cmd);
    } else {
        payload.internal_metadata['docker:cmd'] = '[]';
    }

    if (container.Entrypoint) {
        assert.arrayOfString(container.Entrypoint, 'container.Entrypoint');
        payload.internal_metadata['docker:entrypoint']
            = JSON.stringify(container.Entrypoint);
    } else {
        payload.internal_metadata['docker:entrypoint'] = '[]';
    }

    if (container.Env) {
        assert.arrayOfString(container.Env, 'container.Env');
        payload.internal_metadata['docker:env'] = JSON.stringify(container.Env);
    }

    if (container.User) {
        payload.internal_metadata['docker:user'] = container.User;
    }

    if (container.WorkingDir) {
        payload.internal_metadata['docker:workingdir'] = container.WorkingDir;
    }

    payload.autoboot = false; // because docker does create & start separately
    payload.brand = 'lx';
    payload.docker = true;
    payload.init_name = '/native/usr/vm/sbin/dockerinit';
    payload.restart_init = false;
    payload.kernel_version = VM_DEFAULT_KERNEL_VERSION;
    payload.tmpfs = 0;

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
        function (_, cb) {
            getServerUuid(opts, function (err, server_uuid) {
                if (!err) {
                    payload.server_uuid = server_uuid;
                }
                cb(err);
            });
        }, function (_, cb) {
            getNetworks(opts, function (err, networks) {
                var admin_uuid;
                var external_net;

                if (!err) {
                    networks.forEach(function (n) {
                        if (!admin_uuid
                            && n.name === 'admin'
                            && n.nic_tag === 'admin'
                            && n.owner_uuids.length > 0) {

                            admin_uuid = n.owner_uuids[0];
                        }
                        if (!external_net
                            && n.name === 'external'
                            && n.nic_tag === 'external') {

                            external_net = n.uuid;
                        }
                    });

                    if (!external_net) {
                        cb(new Error('unable to find external network uuid'));
                        return;
                    }
                    if (!admin_uuid) {
                        cb(new Error('unable to find admin user uuid'));
                        return;
                    }
                    payload.networks = [ {uuid: external_net, primary: true} ];
                    payload.owner_uuid = admin_uuid;
                }

                cb(err);
            });
        }, function (_, cb) {
            getPackage(opts, function (err, package_uuid) {
                if (!err) {
                    payload.billing_id = package_uuid;
                }
                cb(err);
            });
        }, function (_, cb) {
            opts.imageName = container.Image;
            getImageUuid(opts, function (err, image_uuid) {
                if (!err) {
                    payload.image_uuid = image_uuid;
                }
                cb(err);
            });
        }]}, function (err, results) {
            log.debug({
                err: err,
                payload: payload,
                results: results
            }, 'ran through payload pipeline');
            callback(err, payload);
        }
    );
}

/*
 * id here can be any of:
 *
 *  64-byte Docker ID
 *  12-char Shortend docker ID
 *  container name (alias)
 */
function findUuidForId(id, opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.vmapi, 'opts.vmapi');

    var log = opts.log;
    opts.one = true;

    listDockerVms(opts, function (err, objects) {
        var found_container;

        if (err) {
            callback(err);
            return;
        }

        objects.forEach(function (obj) {
            if (id.length === 12
                && obj.internal_metadata['docker:id'].substr(0, 12) === id) {

                found_container = obj.uuid;
            } else if (id.length === 64
                && obj.internal_metadata['docker:id'] === id) {

                found_container = obj.uuid;
            } else if (id.length > 0 && obj.alias.length > 0
                && id === obj.alias) {

                found_container = obj.uuid;
            }
        });

        if (found_container) {
            callback(null, found_container);
        } else {
            log.error('findUuidForId(' + id + '): not found');
            callback(new Error('not found'));
        }
    });
}


//---- exported SdcBackend methods

function getContainers(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    this.listImages({
        app: opts.app,
        log: log,
        req_id: opts.req_id,
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
            vmapi: vmapi,
            all: opts.all
        }, function (getvm_err, objects) {
            var containers = [];

            if (getvm_err) {
                callback(getvm_err);
                return;
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
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var log = opts.log || this.log;
    var name = opts.name;
    var payload = opts.payload;
    var vmapi = getVmapiClient(this.config.vmapi);

    // XXX check that "name" is not already used? VMAPI also does that.

    if (!payload.Cmd && !payload.Entrypoint) {
        // A container must have *some* command to run or it cannot boot.
        log.error({
            payload: payload
        }, 'payload is missing both Cmd and Entrypoint');
        callback(new Error('No command specified'));
        return;
    }

    payload.Name = name;
    buildVmPayload({
        config: this.config,
        listImages: this.listImages,
        log: log,
        req_id: opts.req_id
    }, payload, function (payload_err, vm_payload) {

        if (payload_err) {
            log.error({
                err: payload_err,
                payload: payload,
                vm_payload: vm_payload
            }, 'failed to build vmapi payload');
            callback(payload_err);
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
                log.error({err: err, res: res}, 'createVM failed');
                callback(err);
                return;
            }
            log.debug({err: err, res: res}, 'createVM');
            callback(null, {
                DockerId: vm_payload.internal_metadata['docker:id']
            });
        });
    });
}

function stopContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    if (opts.timeout) {
        assert.ok(!isNaN(opts.timeout), 'opts.timeout');
    }

    var id = opts.id;
    var log = opts.log || this.log;
    var stop_params = {};
    var timeout = opts.timeout;
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        // stop_params.owner_uuid = ? XXX
        stop_params.context = opts.context;
        stop_params.origin = opts.origin;
        stop_params.creator_uuid = opts.creator_uuid;
        stop_params.sync = true;
        stop_params.timeout = timeout;
        stop_params.uuid = uuid;

        log.debug('stop_params: ' + JSON.stringify(stop_params));

        stop_params.log = log;

        // XXX should we need headers?
        vmapi.stopVm(stop_params, {
            headers: {'x-request-id': opts.req_id}
        }, function _stopVmCb(stop_err, job) {

            if (stop_err) {
                log.error(stop_err, 'Error stopping container.');
                callback(stop_err);
                return;
            }

            log.debug('job: ' + JSON.stringify(job));
            callback();
        });
    });
}

function restartContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    if (opts.timeout) {
        assert.ok(!isNaN(opts.timeout), 'opts.timeout');
    }

    var id = opts.id;
    var log = opts.log || this.log;
    var restart_params = {};
    var timeout = opts.timeout;
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        // restart_params.owner_uuid = ? XXX
        restart_params.context = opts.context;
        restart_params.origin = opts.origin;
        restart_params.creator_uuid = opts.creator_uuid;
        restart_params.sync = true;
        restart_params.timeout = timeout;
        restart_params.uuid = uuid;

        log.debug('restart_params: ' + JSON.stringify(restart_params));

        restart_params.log = log;

        // XXX should we need headers?
        vmapi.rebootVm(restart_params, {
            headers: {'x-request-id': opts.req_id}
        }, function _rebootVmCb(restart_err, job) {

            if (restart_err) {
                log.error(restart_err, 'Error restarting container.');
                callback(restart_err);
                return;
            }

            log.debug('job: ' + JSON.stringify(job));
            callback();
        });
    });
}

function killContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    if (opts.signal) {
        assert.ok((['string', 'number'].indexOf(typeof (opts.signal)) !== -1),
            'opts.signal');
    }

    var id = opts.id;
    var log = opts.log || this.log;
    var kill_params = {};
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        // kill_params.owner_uuid = ? XXX
        kill_params.context = opts.context;
        kill_params.origin = opts.origin;
        kill_params.creator_uuid = opts.creator_uuid;
        kill_params.uuid = uuid;
        kill_params.sync = true;
        if (opts.signal) {
            if ((typeof (opts.signal) === 'string')
                && (opts.signal.match(/^[0-9]+$/))) {

                // An integer signal being sent as a string. Fix it.
                kill_params.signal = Number(opts.signal);
            } else {
                kill_params.signal = opts.signal;
            }
        }

        log.debug('kill_params: ' + JSON.stringify(kill_params));

        kill_params.log = log;

        // XXX should we need headers?
        vmapi.killVm(kill_params, {
            headers: {'x-request-id': opts.req_id}
        }, function _killVmCb(kill_err, job) {

            if (kill_err) {
                log.error(kill_err, 'Error sending signal to container.');
                callback(kill_err);
                return;
            }

            log.debug('job: ' + JSON.stringify(job));
            callback();
        });
    });
}


function startContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var id = opts.id;
    var log = opts.log || this.log;
    var start_params = {};
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        // start_params.owner_uuid = ? XXX
        start_params.context = opts.context;
        start_params.origin = opts.origin;
        start_params.creator_uuid = opts.creator_uuid;
        start_params.uuid = uuid;
        start_params.sync = true;

        log.debug('start_params: ' + JSON.stringify(start_params));

        start_params.log = log;

        vmapi.startVm(start_params, {
            headers: {'x-request-id': opts.req_id}
        }, function _startVmCb(start_err, job) {
            if (start_err) {
                log.error(start_err, 'Error starting container.');
                return callback(start_err);
            }

            log.debug({job: job}, 'created start job');
            callback();
        });
    });
}


function deleteContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var id = opts.id;
    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        vmapi: vmapi
    }, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        var deleteParams = {};
        deleteParams.context = opts.context;
        deleteParams.origin = opts.origin;
        deleteParams.creator_uuid = opts.creator_uuid;
        deleteParams.uuid = uuid;
        deleteParams.sync = true;

        vmapi.deleteVm(deleteParams, {
            headers: {'x-request-id': opts.req_id}
        }, function _deleteVmCb(deleteErr, job) {
            if (deleteErr) {
                log.error(deleteErr, 'Error starting container.');
                return callback(deleteErr);
            }

            log.debug({job: job}, 'created start job');
            callback();
        });
    });
}


function inspectContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.req_id, 'opts.req_id');

    var id = opts.id;
    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    this.listImages({
        app: opts.app,
        log: log,
        req_id: opts.req_id,
        url: this.config.imgapi.url
    }, function (imgapi_err, imgs) {

        if (imgapi_err) {
            log.error({err: imgapi_err}, 'failed to get images');
            callback(imgapi_err);
            return;
        }

        findUuidForId(id, {
            log: log,
            req_id: opts.req_id,
            vmapi: vmapi
        }, function (find_err, uuid) {

            if (find_err) {
                callback(find_err);
                return;
            }

            vmapi.getVm({ uuid: uuid }, { headers: {'x-request-id': opts.req_id}
            }, function _getVmCb(getErr, vm) {
                if (getErr) {
                    log.error(getErr, 'Error getting container.');
                    return callback(getErr);
                }

                var container = utils.vmobjToInspect({
                    imgs: imgs, // XXX this is a hack
                    log: log
                }, vm);
                log.trace({container: container, obj: vm}, 'container');

                return callback(null, container);
            });
        });
    });
}

function psContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var id = opts.id;
    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        vmapi.getVmProc({uuid: uuid}, {headers: {'x-request-id': opts.req_id}},
            function _getVmProcCb(getErr, vmproc) {
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

                if (getErr) {
                    log.error(getErr, 'Error getting container processes.');
                    return callback(getErr);
                }

                log.debug({proc: vmproc, uuid: uuid}, 'container /proc');

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
            }
        );
    });
}

function waitContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');

    var id = opts.id;
    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);
    var uuid;

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        vmapi: vmapi
    }, function (find_err, uuid_) {
        if (find_err) {
            callback(find_err);
            return;
        }

        uuid = uuid_;
        waitVm();
    });

    function waitVm() {
        vmapi.getVm({ uuid: uuid }, { headers: {'x-request-id': opts.req_id}
        }, function _getVmCb(getErr, vm) {
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

    var id = opts.id;
    var app = opts.app;
    var log = opts.log;
    var payload = opts.payload;
    var vmapi = getVmapiClient(this.config.vmapi);
    var cnapi = getCnapiClient(this.config.cnapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        vmapi: vmapi
    }, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        dockerExec(uuid, {
            log: log,
            payload: payload,
            req_id: opts.req_id,
            cnapi: cnapi,
            vmapi: vmapi
        }, function (execErr, res) {
            if (execErr) {
                callback(execErr);
                return;
            }

            var cmdId = common.generateDockerId();

            // When -d is passed, we don't need to connect to any TCP
            // server afterwards
            if (payload.Detach) {
                app.execCommands[cmdId] = { command: payload };
                callback(null, cmdId);
                return;
            }

            // Stash the address of the temporary TCP server
            app.execCommands[cmdId] = res;
            app.execCommands[cmdId].command = payload;
            callback(null, cmdId);
        });
    });
}


function execStart(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.socket, 'opts.socket');

    var id = opts.id;
    var host = opts.app.execCommands[id].host;
    var port = opts.app.execCommands[id].port;
    var socket = opts.socket;

    var cmdString = opts.payload.Cmd.join(' ');
    var execSocket = net.createConnection({ host: host, port: port });

    execSocket.on('connect', function () {
        if (opts.payload.AttachStdin) {
            socket.pipe(execSocket);
        }

        execSocket.pipe(socket);

        execSocket.on('error', function (error) {
            opts.log.debug('execSocket for %s threw an error %',
                cmdString, error.toString());

            socket.end();
            callback(null);
        });

        execSocket.on('close', function (had_error) {
            opts.log.debug('execSocket %s closed, had_error=%s',
                cmdString, had_error);
            callback(null);
        });

        execSocket.on('end', function () {
            opts.log.debug('execSocket %s end', cmdString);
            callback(null);
        });
    });
}


function dockerExec(uuid, opts, callback) {
    assert.string(uuid, 'uuid');
    assert.object(opts, 'opts');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.vmapi, 'opts.vmapi');
    assert.object(opts.cnapi, 'opts.cnapi');

    var log = opts.log;
    var vmapi = opts.vmapi;
    var cnapi = opts.cnapi;

    vmapi.getVm({ uuid: uuid }, { headers: {'x-request-id': opts.req_id}
    }, function _getVmCb(getErr, vm) {
        if (getErr) {
            log.error(getErr, 'Error getting container.');
            return callback(getErr);
        }

        cnapi.dockerExec(vm.server_uuid, uuid, { command: opts.payload },
            { headers: {'x-request-id': opts.req_id}
        }, function _execCb(execErr, res) {
            if (execErr) {
                log.error(execErr, 'Error calling docker-exec');
                return callback(execErr);
            }

            return callback(null, res);
        });
    });
}


module.exports = {
    createContainer: createContainer,
    deleteContainer: deleteContainer,
    execContainer: execContainer,
    execStart: execStart,
    getContainers: getContainers,
    inspectContainer: inspectContainer,
    killContainer: killContainer,
    psContainer: psContainer,
    restartContainer: restartContainer,
    startContainer: startContainer,
    stopContainer: stopContainer,
    waitContainer: waitContainer
};
