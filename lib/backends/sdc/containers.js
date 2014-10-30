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
var execFile = require('child_process').execFile;
var libuuid = require('libuuid');
var NAPI = require('sdc-clients').NAPI;
var PAPI = require('sdc-clients').PAPI;
var vasync = require('vasync');
var VMAPI = require('sdc-clients').VMAPI;

var common = require('../../common');
var utils = require('./utils');



//---- globals

var _napiClientCache; // set in `getNapiClient`
var _papiClientCache; // set in `getPapiClient`
var _vmapiClientCache; // set in `getVmapiClient`

var VM_DEFAULT_KERNEL_VERSION = '3.13.0';
var VM_DEFAULT_MAX_LWPS = 2000;
var VM_DEFAULT_QUOTA = 100;     // GiB
var VM_DEFAULT_MEMORY = 8192;   // MiB
var VM_DEFAULT_ZFS_IO_PRIORITY = 100;



//---- internal support routines

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

    napi.listNetworks({}, {}, function (err, res) {
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

    papi.list('name=' + opts.config.defaultPackage, {},
        function (err, pkgs, count) {
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

    var log = opts.log;

    opts.listImages({log: log, url: opts.config.imgapi.url},
        function (imgapi_err, imgs) {

        var image_uuid;

        if (imgapi_err) {
            callback(imgapi_err);
            return;
        }

        imgs.forEach(function (img) {
            if (img.RepoTags.indexOf(opts.imageName) !== -1) {
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
    assert.optionalBool(opts.all, 'opts.all');
    assert.func(callback, 'callback');

    var params = {};

    /*
     * .predicate doesn't seem to work properly here.
     *
     * if (!opts.all) {
     *   params.predicate = '{ "and": [ { "eq": ["docker", true] },
     *        { "eq": ["state", "running"] } ] }';
     * } else {
     *   params.predicate = '{ "and": [ { "eq": ["docker", true] },
     *        { "and": [{"ne": ["state", "failed"]},
     *        {"ne": ["state", "destroyed"]}] } ] }';
     * }
     */

    // XXX should we need headers?
    opts.vmapi.listVms(params, {fields: '*'},
        function _listVmsCb(err, vms, _req, _res) {
            if (err) {
                opts.log.error(err, 'Error retrieving Virtual Machines');
                return callback(err);
            }

            opts.log.debug('Found ' + vms.length + ' VMs');
            // XXX run through filter here since ldap doesn't seem to work
            callback(null, vms.filter(function (vm) {
                if (vm.docker) {
                    return true;
                } else {
                    return false;
                }
            }));
        }
    );
}

// XXX hack
function getImageString(imgs, uuid)
{
    var found_image;

    imgs.forEach(function (image) {
        if (image.Id.substr(0, 32) === uuid.replace(/-/g, '')) {
            found_image = image;
        }
    });

    if (found_image) {
        return found_image.RepoTags[0]; // XXX always first one?
    } else {
        return 'XXX-UNKNOWN_IMAGE';
    }
}

function vmobjToContainer(opts, imgs, obj)
{
    assert.object(opts, 'opts');
    assert.arrayOfObject(imgs, 'imgs');
    assert.object(obj, 'obj');
    assert.string(obj.alias, 'obj.alias');

    var boot_timestamp = new Date(obj.boot_timestamp);
    var container = {};
    var now = new Date();
    var uptime = Math.floor((now - boot_timestamp) / 1000);

    if (obj.internal_metadata && obj.internal_metadata['docker:id']) {
        container.Id = obj.internal_metadata['docker:id'];
    } else {
        // Fallback to the shortend docker id format from the UUID
        container.Id = obj.uuid.replace(/-/g, '').substr(0, 12);
    }

    if (obj.create_timestamp) {
        container.Created
            = Math.floor((new Date(obj.create_timestamp)).getTime()/1000);
    } else {
        container.Created = 0;
    }

    // XXX TODO make sure to support all forms of Command
    container.Command = '/bin/sh';

    // Names: ['/redis32'] -- others are links
    container.Names = [];
    container.Names.push('/' + obj.alias);

    // XXX We don't yet support ports
    container.Ports = [];

    if (obj.state == 'running') {
        container.Status = 'Up ' + common.humanDuration(uptime);
    } else if (obj.state == 'stopped') {
        container.Status = 'Exited (0) 3 minutes ago';
    } else {
        container.Status = '';
    }

    container.Image = getImageString(imgs, obj.image_uuid);

    return (container);
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

    // XXX Cmd: [ "/bin/sh" ]
    // XXX User: "root"
    // XXX Env: [],
    // XXX WorkingDir: "",
    // XXX Entrypoint: null,

    payload.autoboot = false; // because docker always starts manually
    payload.brand = 'lx';
    payload.docker = true;
    payload.init_name = '/native/usr/lib/lx_dockerinit';
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

function findUuidForId(vmapi, log, id, callback) {
    listDockerVms({log: log, vmapi: vmapi}, function (err, objects) {
        var found_container;

        if (err) {
            callback(err);
            return;
        }

        objects.forEach(function (obj) {
            if (id.length === 12
                && obj.internal_metadata['docker:id'].substr(0, 12) === id) {

                found_container = obj.uuid;
            } else if (obj.internal_metadata['docker:id'] === id) {
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
    assert.optionalObject(opts.log, 'opts.log');

    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    this.listImages({log: log, url: this.config.imgapi.url},
        function (imgapi_err, imgs) {

        if (imgapi_err) {
            log.error({err: imgapi_err}, 'failed to get images');
            callback(imgapi_err);
            return;
        }

        listDockerVms({log: log, vmapi: vmapi}, function (getvm_err, objects) {
            var containers = [];

            if (getvm_err) {
                callback(getvm_err);
                return;
            }

            objects.forEach(function (obj) {
                // TODO remove this conditional once filtering's fixed
                if (['running', 'stopped'].indexOf(obj.state) !== -1) {
                    var container = vmobjToContainer({log: log}, imgs, obj);
                    log.trace({container: container, obj: obj}, 'container');
                    containers.push(container);
                }
            });

            callback(null, containers);
        });
    });
}

function createContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.log, 'opts.log');

    var log = opts.log || this.log;
    var name = opts.name;
    var payload = opts.payload;
    var vmapi = getVmapiClient(this.config.vmapi);

    // XXX check that "name" is not already used? VMAPI also does that.

    payload.Name = name;
    buildVmPayload({
        config: this.config,
        listImages: this.listImages,
        log: log
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

        vmapi.createVm(vm_payload, {}, function (err, res) {
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

    var id = opts.id;
    var log = opts.log || this.log;
    var stop_params = {};
    //var timeout = opts.timeout;
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(vmapi, log, id, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        // start_params.owner_uuid = ? XXX
        stop_params.context = opts.context;
        stop_params.origin = opts.origin;
        stop_params.creator_uuid = opts.creator_uuid;
        stop_params.uuid = uuid;
        stop_params.force = true; // currently ignored by VMAPI

        log.debug('stop_params: ' + JSON.stringify(stop_params));

        stop_params.log = log;

        // XXX should we need headers?
        vmapi.stopVm(stop_params, {}, function _stopVmCb(stop_err, job) {
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

function startContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');

    var id = opts.id;
    var log = opts.log || this.log;
    var start_params = {};
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(vmapi, log, id, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        // start_params.owner_uuid = ? XXX
        start_params.context = opts.context;
        start_params.origin = opts.origin;
        start_params.creator_uuid = opts.creator_uuid;
        start_params.uuid = uuid;

        log.debug('start_params: ' + JSON.stringify(start_params));

        start_params.log = log;

        // XXX should we need headers?
        vmapi.startVm(start_params, {}, function _startVmCb(start_err, job) {
            if (start_err) {
                log.error(start_err, 'Error starting container.');
                return callback(start_err);
            }

            log.debug({job: job}, 'created start job');
            callback();
        });
    });
}

module.exports = {
    createContainer: createContainer,
    getContainers: getContainers,
    startContainer: startContainer,
    stopContainer: stopContainer
};
