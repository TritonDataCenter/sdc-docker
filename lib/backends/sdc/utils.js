/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var common = require('../../../lib/common');
var restify = require('restify');

function dockerIdToUuid(dockerId) {
    var out;

    out = dockerId.substr(0, 8) + '-'
        + dockerId.substr(8, 4) + '-'
        + dockerId.substr(12, 4) + '-'
        + dockerId.substr(16, 4) + '-'
        + dockerId.substr(20, 12);

    return (out);
}

function uuidToDockerId(uuid) {
    return (uuid + uuid).replace(/-/g, '');
}

function vmobjToContainer(opts, obj)
{
    assert.object(opts, 'opts');
    assert.arrayOfObject(opts.imgs, 'opts.imgs');
    assert.object(opts.log, 'opts.log');
    assert.object(obj, 'obj');
    assert.string(obj.alias, 'obj.alias');

    var boot_timestamp = new Date(obj.boot_timestamp);
    var cmd = [];
    var container = {};
    var exittime;
    var imgs = opts.imgs; // XXX imgs is a hack until we have better lookup
    //var log = opts.log;
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

    if (obj.internal_metadata && obj.internal_metadata['docker:entrypoint']) {
        cmd = cmd.concat(
            JSON.parse(obj.internal_metadata['docker:entrypoint']));
    }
    if (obj.internal_metadata && obj.internal_metadata['docker:cmd']) {
        cmd = cmd.concat(JSON.parse(obj.internal_metadata['docker:cmd']));
    }
    container.Command = cmd.join(' ');

    // Names: ['/redis32'] -- others are links
    container.Names = [];
    container.Names.push('/' + obj.alias);

    // XXX We don't yet support ports
    container.Ports = [];

    if (obj.state == 'running') {
        container.Status = 'Up ' + common.humanDuration(uptime);
    } else if (obj.state == 'stopped') {
        if (obj.hasOwnProperty('exit_status')
            && obj.hasOwnProperty('exit_timestamp')) {

            exittime
                = Math.floor((now - (new Date(obj.exit_timestamp))) / 1000);
            container.Status = 'Exited (' + obj.exit_status + ') '
                + common.humanDuration(exittime) + ' ago';
        } else {
            // Most likely in this case the container never started yet.
            // Empty string is what docker daemon currently does on Ubuntu
            container.Status = '';
        }
    } else {
        container.Status = '';
    }

    // docker ps shows the image repo tag
    container.Image = getImage(imgs, obj.image_uuid).RepoTags[0];

    return (container);
}

// XXX hack
function getImage(imgs, uuid)
{
    var found_image;

    imgs.forEach(function (image) {
        if (image.Id.substr(0, 32) === uuid.replace(/-/g, '')) {
            found_image = image;
        }
    });

    if (found_image) {
        return found_image; // XXX always first one?
    } else {
        return { Id: 'XXX-UNKNOWN_IMAGE', RepoTags: [ 'XXX-UNKNOWN_IMAGE' ] };
    }
}

// Sadly `docker ps` and `docker inspect` container objects only share Id
function vmobjToInspect(opts, obj) {
    assert.object(opts, 'opts');
    assert.arrayOfObject(opts.imgs, 'opts.imgs');
    assert.object(obj, 'obj');
    assert.string(obj.alias, 'obj.alias');

    var imgs = opts.imgs; // XXX imgs is a hack until we have better lookup
    var container = {};

    if (obj.internal_metadata && obj.internal_metadata['docker:id']) {
        container.Id = obj.internal_metadata['docker:id'];
    } else {
        // Fallback to the shortend docker id format from the UUID
        container.Id = obj.uuid.replace(/-/g, '').substr(0, 12);
    }

    // `docker inspect` has also a different return format for date
    if (obj.create_timestamp) {
        container.Created = new Date(obj.create_timestamp);
    } else {
        container.Created = 0;
    }

    container.Args = [];
    container.Config = {
        'AttachStderr': true,
        'AttachStdin': false,
        'AttachStdout': true,
        'CpuShares': obj.cpu_shares,
        'Cpuset': '',
        'Domainname': '',
        'ExposedPorts': null,
        'Hostname': obj.uuid,
        'Memory': obj.max_physical_memory,
        'MemorySwap': obj.max_swap,
        'NetworkDisabled': true,
        'OnBuild': null,
        'OpenStdin': false,
        'PortSpecs': null,
        'SecurityOpt': null,
        'StdinOnce': false,
        'Tty': true,
        'User': '',
        'Volumes': null,
        'WorkingDir': ''
    };

    var image = getImage(imgs, obj.image_uuid);
    container.Config.Image = image.RepoTags[0];

    if (obj.internal_metadata && obj.internal_metadata['docker:cmd']) {
        container.Config.Cmd = JSON.parse(obj.internal_metadata['docker:cmd']);
    }
    if (obj.internal_metadata && obj.internal_metadata['docker:entrypoint']) {
        container.Config.Entrypoint = JSON.parse(
            obj.internal_metadata['docker:entrypoint']);
    }
    if (obj.internal_metadata && obj.internal_metadata['docker:env']) {
        container.Config.Env = JSON.parse(obj.internal_metadata['docker:env']);
    }

    container.Driver = 'sdc';
    container.ExecDriver = 'sdc-0.1';

    container.HostConfig = {
        'Binds': null,
        'CapAdd': null,
        'CapDrop': null,
        'ContainerIDFile': '',
        'Devices': [],
        'Dns': null,
        'DnsSearch': null,
        'ExtraHosts': null,
        'Links': null,
        'LxcConf': [],
        'NetworkMode': 'bridge',
        'PortBindings': {},
        'Privileged': false,
        'PublishAllPorts': false,
        'RestartPolicy': {
            'MaximumRetryCount': 0,
            'Name': ''
        },
        'VolumesFrom': null
    };

    container.HostnamePath = '/etc/hostname';
    container.HostsPath = '/etc/hosts';
    container.Image = image.Id;
    container.MountLabel = '';
    container.Name = '/' + obj.alias;

    container.NetworkSettings = {
        'Bridge': 'docker0',
        'Gateway': '172.17.42.1',
        'IPAddress': '172.17.0.2',
        'IPPrefixLen': 16,
        'MacAddress': '02:42:ac:11:00:02',
        'PortMapping': null,
        'Ports': {}
    };

    container.Path = '/bin/bash';
    container.ProcessLabel = '';
    container.ResolvConfPath = '/etc/resolv.conf';

    container.State = {
        'ExitCode': obj.exit_status || 0,
        'FinishedAt': '2014-10-29T16:55:11.364285613Z',
        'Paused': false,
        'Pid': 7241,
        'Restarting': false,
        'Running': true,
        'StartedAt': obj.boot_timestamp
    };

    container.Volumes = {};
    container.VolumesRW = {};

    return container;
}

function imgobjToInspect(opts, obj) {
    assert.object(opts, 'opts');
    assert.object(obj, 'obj');

    var dockerImage = {};
    dockerImage.Architecture = 'amd64';
    dockerImage.Author = ''; // image.owner?
    dockerImage.Comment = obj.description;

    dockerImage.Config = {
        'AttachStderr': false,
        'AttachStdin': false,
        'AttachStdout': false,
        'Cmd': [
            '/bin/bash'
        ],
        'CpuShares': 0,
        'Cpuset': '',
        'Domainname': '',
        'Entrypoint': null,
        'Env': [
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        ],
        'ExposedPorts': null,
        'Hostname': '2c1b05d4dd63',
        'Image': '', // which image?
        'Memory': 0,
        'MemorySwap': 0,
        'NetworkDisabled': false,
        'OnBuild': [],
        'OpenStdin': false,
        'PortSpecs': null,
        'SecurityOpt': null,
        'StdinOnce': false,
        'Tty': false,
        'User': '',
        'Volumes': null,
        'WorkingDir': ''
    };

    dockerImage.Container = ''; // which container?

    dockerImage.ContainerConfig = {
        'AttachStderr': false,
        'AttachStdin': false,
        'AttachStdout': false,
        'Cmd': [
            '/bin/sh',
            '-c',
            '#(nop) CMD [/bin/bash]'
        ],
        'CpuShares': 0,
        'Cpuset': '',
        'Domainname': '',
        'Entrypoint': null,
        'Env': [
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        ],
        'ExposedPorts': null,
        'Hostname': '2c1b05d4dd63',
        'Image': '', // which image?
        'Memory': 0,
        'MemorySwap': 0,
        'NetworkDisabled': false,
        'OnBuild': [],
        'OpenStdin': false,
        'PortSpecs': null,
        'SecurityOpt': null,
        'StdinOnce': false,
        'Tty': false,
        'User': '',
        'Volumes': null,
        'WorkingDir': ''
    };

    dockerImage.Created = new Date(obj.published_at);
    dockerImage.DockerVersion = '1.15';
    dockerImage.Id = (obj.uuid + obj.uuid).replace(/-/g, '');
    dockerImage.Os = 'Joyent Smart Data Center';

    if (obj.origin) {
        dockerImage.Parent = (obj.origin + obj.origin).replace(/-/g, '');
    } else {
        dockerImage.Parent = '';
    }

    dockerImage.Size = obj.files[0].size;
    dockerImage.VirtualSize = obj.files[0].size;

    return dockerImage;
}

function getImgapiImageForName(name, opts, callback) {
    assert.func(callback, 'callback');
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.imgapi, 'opts.imgapi');
    assert.string(opts.req_id, 'opts.req_id');

    var filters = {};

    opts.imgapi.listImages(filters, {
        headers: {'x-request-id': opts.req_id}
    }, function (err, images) {

        if (err) {
            callback(err);
            return;
        }

        for (var i = 0; i < images.length; i++) {
            var img = images[i];

            // name or id. TODO repo tags
            // indefOx: make shre that id/name starts at index 0 of image.Id
            if (uuidToDockerId(img.uuid).indexOf(name) === 0
                || img.name === name) {
                callback(null, img);
                return;
            }
        }

        callback(new restify.ResourceNotFoundError(
            'could not find image ' + name));
        return;
    });
}

// ---- exports

module.exports = {
    dockerIdToUuid: dockerIdToUuid,
    vmobjToContainer: vmobjToContainer,
    vmobjToInspect: vmobjToInspect,
    imgobjToInspect: imgobjToInspect,
    getImgapiImageForName: getImgapiImageForName
};
