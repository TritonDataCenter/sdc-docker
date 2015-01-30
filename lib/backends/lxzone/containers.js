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
var imgadm = require('./imgadm');
var UUID = require('node-uuid');

var VM_DEFAULT_KERNEL_VERSION = '3.13.0';
var VM_DEFAULT_MAX_LWPS = 2000;
var VM_DEFAULT_QUOTA = 100;     // GiB
var VM_DEFAULT_MEMORY = 8192;   // MiB
var VM_DEFAULT_ZFS_IO_PRIORITY = 100;

var VMADM_FIELDS = [
    'alias',
    'autoboot',
    'boot_timestamp',
    'brand',
    'cpu_cap',
    'cpu_shares',
    'create_timestamp',
    'customer_metadata',
    'datasets',
    'dns_domain',
    'docker',
    'filesystems',
    'hostname',
    'image_uuid',
    'init_name',
    'internal_metadata',
    'kernel_version',
    'maintain_resolvers',
    'max_physical_memory',
    'max_locked_memory',
    'max_lwps',
    'max_swap',
    'nics',
    'pid',
    'quota',
    'resolvers',
    'state',
    'tmpfs',
    'uuid',
    'zfs_io_priority',
    'zone_state'
];

/*
 * GET /containers/json
 *
 * Query Parameters:
 *
 * all – 1/True/true or 0/False/false, Show all containers. Only running
 *      containers are shown by default (i.e., this defaults to false)
 * limit – Show limit last created containers, include non-running ones.
 * since – Show only containers created since Id, include non-running ones.
 * before – Show only containers created before Id, include non-running ones.
 * size – 1/True/true or 0/False/false, Show the containers sizes
 */

function getVMs(log, options, callback)
{
    var fields = options.fields;
    var filters = options.filters;

    assert(Array.isArray(fields));

    var args = ['lookup', '-j', '-o', fields.join(','), 'docker=true'];
    var cmd = '/usr/sbin/vmadm';

    args = args.concat(filters);

    log.debug(cmd + ' ' + args.join(' '));
    execFile(cmd, args, function (error, stdout, stderr) {
        if (error) {
            log.error('Unable to get VM list');
            error.stdout = stdout;
            error.stderr = stderr;
            callback(error);
            return;
        }
        try {
            var objs = JSON.parse(stdout);
            callback(null, objs);
            return;
        } catch (e) {
            e.stdout = stdout;
            e.stderr = stderr;
            return;
        }
    });
}

function getImageString(images, uuid)
{
    var found_image;

    images.forEach(function (image) {
        if (image.manifest.uuid == uuid) {
            found_image = image.manifest;
        }
    });

    if (found_image) {
        return found_image.name + ':' + found_image.version;
    } else {
        return 'XXX-UNKNOWN_IMAGE';
    }
}

function vmobjToContainer(images, obj)
{
    assert(typeof (obj) == 'object');

    var container = {};

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

    // Command: 'redis-server'

    // Names: ['/redis32']
    container.Names = [];
    if (obj.alias) {
        container.Names.push('/' + obj.alias);
    } else {
        // all docker containers should have alias
        container.Names.push('/XXXDEADBEEF');
    }

    // XXX Don't yet support ports
    container.Ports = [];

    if (obj.state == 'running') {
        container.Status = 'Up 9 seconds';
    } else if (obj.state == 'stopped') {
        container.Status = 'Exited (0) 3 minutes ago';
    } else {
        container.Status = '';
    }

    container.Image = getImageString(images, obj.image_uuid);

    return (container);
}

function getContainers(options, callback) {
    var log = options.log;
    var get_opts = {};

    get_opts.fields = VMADM_FIELDS;
    get_opts.filters = [];
    if (!options.all) {
        get_opts.filters.push('state=running');
    }

    imgadm.getImages({log: log}, function (imgadm_err, images) {
        // XXX we're ignoring imgadm_err
        getVMs(log, get_opts, function (err, objects) {
            var containers = [];

            assert(!err);

            objects.forEach(function (obj) {
                var container = vmobjToContainer(images, obj);
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

    // XXX generate a uuid + dockerid

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

    payload.uuid = UUID.v4();
    dockerid = (payload.uuid + UUID.v4()).replace(/-/g, '');

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
    payload.init_name = '/native/usr/vm/sbin/dockerinit';
    payload.kernel_version = VM_DEFAULT_KERNEL_VERSION;
    payload.max_lwps = VM_DEFAULT_MAX_LWPS;
    payload.tmpfs = 0;
    payload.zfs_io_priority = VM_DEFAULT_ZFS_IO_PRIORITY;

// {
// "AttachStdin": false,
// "AttachStdout": false,
// "AttachStderr": false,
// "PortSpecs": null,
// "ExposedPorts": {},
// "Tty": false,
// "OpenStdin": false,
// "StdinOnce": false,
// "Volumes": {},
// "Entrypoint": null,
// "NetworkDisabled": false,
// "OnBuild": null,
// "SecurityOpt": null,
// "HostConfig": {
//   "Binds": null,
//   "ContainerIDFile": "",
//   "LxcConf": [],
//   "Privileged": false,
//   "PortBindings": {},
//   "Links": null,
//   "PublishAllPorts": false,
//   "Dns": null,
//   "DnsSearch": null,
//   "ExtraHosts": null,
//   "VolumesFrom": null,
//   "Devices": [],
//   "NetworkMode": "bridge",
//   "CapAdd": null,
//   "CapDrop": null,
//   "RestartPolicy": {
//     "Name": "",
//     "MaximumRetryCount": 0
//   }
// }

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

module.exports = {
    createContainer: createContainer,
    getContainers: getContainers
};
