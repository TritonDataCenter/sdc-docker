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

function getVMs(log, fields, callback)
{
    assert(Array.isArray(fields));

    var args = ['lookup', '-j', '-o', fields.join(','), 'docker=true'];
    var cmd = '/usr/sbin/vmadm';

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

function vmobjToContainer(obj)
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

    if (obj.image_uuid) {
        // XXX do imgadm lookup?
        // format should be: 'Image':'austinov/redis32:latest'
        container.Image = obj.image_uuid;
    } else {
        container.Image = 'broken';
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

    return (container);
}

function getContainers(log, options, callback) {
    getVMs(log, VMADM_FIELDS, function (err, objects) {
        var containers = [];

        assert(!err);

        objects.forEach(function (obj) {
            var container = vmobjToContainer(obj);
            log.debug({container: container, obj: obj}, 'found container');
            containers.push(container);
        });

        callback(null, containers);
    });
}

module.exports = {
    getContainers: getContainers
};
