/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert');
var bunyan = require('bunyan');
var child_process = require('child_process');
var execFile = child_process.execFile;
var libuuid = require('libuuid');
var images = require('./images');
var VMAPI = require('sdc-clients').VMAPI;

var vmapi = new VMAPI({url: process.env.VMAPI_URL});

var VM_DEFAULT_KERNEL_VERSION = '3.13.0';
var VM_DEFAULT_MAX_LWPS = 2000;
var VM_DEFAULT_QUOTA = 100;     // GiB
var VM_DEFAULT_MEMORY = 8192;   // MiB
var VM_DEFAULT_ZFS_IO_PRIORITY = 100;

function getVMs(log, options, callback)
{
    var params = {};

    /*
     * .predicate doesn't seem to work properly here.
     *
     * if (!options.all) {
     *   params.predicate = '{ "and": [ { "eq": ["docker", true] },
     *        { "eq": ["state", "running"] } ] }';
     * } else {
     *   params.predicate = '{ "and": [ { "eq": ["docker", true] },
     *        { "and": [{"ne": ["state", "failed"]},
     *        {"ne": ["state", "destroyed"]}] } ] }';
     * }
     */

    // XXX should we need headers?
    vmapi.listVms(params, {fields: '*'},
        function _listVmsCb(err, vms, _req, _res) {
            if (err) {
                log.error(err, 'Error retrieving Virtual Machines');
                return callback(err);
            }

            log.debug('Found ' + vms.length + ' VMs');
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

function getImageString(imgs, uuid)
{
    var found_image;

    imgs.forEach(function (image) {
        if (image.uuid == uuid) {
            found_image = image;
        }
    });

    if (found_image) {
        return found_image.name + ':' + found_image.version;
    } else {
        return 'XXX-UNKNOWN_IMAGE';
    }
}

function vmobjToContainer(options, imgs, obj)
{
    assert(typeof (obj) == 'object');

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

    // Names: ['/redis32']
    container.Names = [];
    if (obj.alias) {
        container.Names.push('/' + obj.alias);
    } else {
        // all docker containers should have alias
        container.Names.push('/XXXDEADBEEF');
    }

    // XXX We don't yet support ports
    container.Ports = [];

    if (obj.state == 'running') {
        container.Status = 'Up ' + uptime + ' seconds';
    } else if (obj.state == 'stopped') {
        container.Status = 'Exited (0) 3 minutes ago';
    } else {
        container.Status = '';
    }

    container.Image = getImageString(imgs, obj.image_uuid);

    return (container);
}

function getContainers(options, callback) {
    var log = options.log;
    var get_opts = {};

    get_opts.filters = [];

    images.getImages({log: log}, function (imgapi_err, imgs) {
        if (imgapi_err) {
            log.error({err: imgapi_err}, 'failed to get images');
            callback(imgapi_err);
            return;
        }

        getVMs(log, get_opts, function (getvm_err, objects) {
            var containers = [];

            if (getvm_err) {
                callback(getvm_err);
                return;
            }

            objects.forEach(function (obj) {
                var container = vmobjToContainer({log: log}, imgs, obj);
                log.debug({container: container, obj: obj}, 'found container');
                containers.push(container);
            });

            callback(null, containers);
        });
    });
}

function ltrim(str, chars)
{
    chars = chars || '\\s';
    str = str || '';
    return str.replace(new RegExp('^[' + chars + ']+', 'g'), '');
}

function buildVmadmPayload(container, callback) {

    var dockerid;
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

    if (container.Memory) {
        payload.max_physical_memory = container.Memory / (1024 * 1024);
    } else {
        payload.max_physical_memory = VM_DEFAULT_MEMORY;
    }
    payload.max_locked_memory = payload.max_physical_memory;
    if (container.MemorySwap) {
        payload.max_swap = container.MemorySwap / (1024 * 1024);
    } else {
        payload.max_swap = payload.max_physical_memory * 2;
    }

    // generate a uuid + dockerid
    payload.uuid = libuuid.create();
    dockerid = (payload.uuid + libuuid.create()).replace(/-/g, '');

    payload.quota = VM_DEFAULT_QUOTA;
    payload.alias = ltrim(container.Name, '/');
    payload.internal_metadata = {
        'docker:id': dockerid
    };

    // XXX Cmd: [ "/bin/sh" ]
    // XXX User: "root"
    // XXX Env: [],
    // XXX WorkingDir: "",
    // XXX Entrypoint: null,

    // "Image": "lx-busybox32:latest",
    payload.image_uuid = '7880d5ac-4e4b-11e4-875e-bb334d515983';

    payload.autoboot = false; // because docker always starts manually
    payload.brand = 'lx';
    payload.docker = true;
    payload.init_name = '/native/usr/lib/lx_dockerinit';
    payload.kernel_version = VM_DEFAULT_KERNEL_VERSION;
    payload.max_lwps = VM_DEFAULT_MAX_LWPS;
    payload.tmpfs = 0;
    payload.zfs_io_priority = VM_DEFAULT_ZFS_IO_PRIORITY;

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

    callback(null, payload);

}

function createContainer(options, callback) {
    var log = options.log;
    var name = options.name;
    var payload = options.payload;

    // XXX TODO check that "name" is not already used

    payload.Name = name;
    buildVmadmPayload(payload, function (err, vmadm_payload) {
        log.debug({name: name, payload: payload, vmadm_payload: vmadm_payload},
            'built payload');
        callback(null, {});
    });
}

function findUuidForId(log, id, callback) {
    var get_opts = {};

    getVMs(log, get_opts, function (err, objects) {
        var found_container;

        if (err) {
            callback(err);
            return;
        }

        objects.forEach(function (obj) {
            log.debug({obj: obj}, 'checking for ' + id);
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

function stopContainer(options, callback) {
    var id = options.id;
    var log = options.log;
    var stop_params = {};
    //var timeout = options.timeout;

    findUuidForId(log, id, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        // start_params.owner_uuid = ? XXX
        stop_params.context = options.context;
        stop_params.origin = options.origin;
        stop_params.creator_uuid = options.creator_uuid;
        stop_params.uuid = uuid;
        stop_params.force = true;

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

function startContainer(options, callback) {
    var id = options.id;
    var log = options.log;
    var start_params = {};

    findUuidForId(log, id, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        // start_params.owner_uuid = ? XXX
        start_params.context = options.context;
        start_params.origin = options.origin;
        start_params.creator_uuid = options.creator_uuid;
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
