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
var net = require('net');
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
    var quoted_args = [];

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

    // When the arguments have spaces in them, we want to quote them with single
    // quotes as does:
    //
    /* JSSTYLED */
    // https://github.com/docker/docker/blob/3ec695924009421f9b1f79368e9e5b1e3e2ca94f/daemon/list.go#L127-L141
    cmd.slice(1).forEach(function (arg) {
        if (arg.indexOf(' ') === -1) {
            quoted_args.push(arg);
        } else {
            quoted_args.push('\'' + arg + '\'');
        }
    });
    container.Command = cmd.slice(0, 1).concat(quoted_args).join(' ');

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

/*
 * Converts a dotted IPv4 address (eg: 1.2.3.4) to its integer value
 *
 * (borrowed from NAPI/lib/util/ip.js)
 */
function addressToNumber(addr) {
    if (!addr || !net.isIPv4(addr)) {
        return null;
    }

    var octets = addr.split('.');
    return Number(octets[0]) * 16777216
        + Number(octets[1]) * 65536
        + Number(octets[2]) * 256
        + Number(octets[3]);
}

/*
 * Converts netmask to CIDR (/xx) bits
 *
 * (borrowed from NAPI/lib/util/ip.js)
 */
function netmaskToBits(netmask) {
    var num = ~addressToNumber(netmask);
    var b = 0;
    for (b = 0; b < 32; b++) {
        if (num === 0) {
            break;
        }
        num = num >>> 1;
    }
    return 32 - b;
}

// Sadly `docker ps` and `docker inspect` container objects only share Id
function vmobjToInspect(opts, obj) {
    assert.object(opts, 'opts');
    assert.arrayOfObject(opts.imgs, 'opts.imgs');
    assert.object(opts.log, 'opts.log');
    assert.string(obj.alias, 'obj.alias');

    var cmdline = [];
    var container = {};
    /* JSSTYLED */
    var data_volume_regex = /volumes\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
    var host_volume_regex = /^\/manta(\/[^\/]*\/public\/.*)$/;
    var im = obj.internal_metadata;
    var imgs = opts.imgs; // XXX imgs is a hack until we have better lookup

    if (im && im['docker:id']) {
        container.Id = im['docker:id'];
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

    container.Config = {
        'AttachStderr': im['docker:attach_stderr'] || false,
        'AttachStdin': im['docker:attach_stdin'] || false,
        'AttachStdout': im['docker:attach_stdout'] || false,
        'CpuShares': obj.cpu_shares,
        'Cpuset': '',
        'Domainname': obj.dns_domain || '',
        'ExposedPorts': null,
        'Hostname': obj.hostname || '',
        'Memory': obj.max_physical_memory,
        'MemorySwap': obj.max_swap,
        'NetworkDisabled': false,
        'OnBuild': null,
        'OpenStdin': im['docker:open_stdin'] || false,
        'PortSpecs': null,
        'SecurityOpt': null,
        'StdinOnce': false,
        'Tty': im['docker:tty'] || false,
        'User': im['docker:user'] || '',
        'Volumes': {},
        'WorkingDir': im['docker:workdir'] || ''
    };

    var image = getImage(imgs, obj.image_uuid);
    container.Config.Image = image.RepoTags[0];

    if (im && im['docker:cmd']) {
        container.Config.Cmd = JSON.parse(im['docker:cmd']);
    } else {
        container.Config.Cmd = [];
    }
    if (im && im['docker:entrypoint'] && im['docker:entrypoint'] !== '[]') {
        container.Config.Entrypoint = JSON.parse(im['docker:entrypoint']);
    } else {
        container.Config.Entrypoint = [];
    }
    if (im && im['docker:env']) {
        container.Config.Env = JSON.parse(im['docker:env']);
    }

    // Not sure why this needs to be duplicated
    cmdline = container.Config.Entrypoint.concat(container.Config.Cmd);
    container.Path = cmdline[0];
    container.Args = cmdline.splice(1);

    // bug for bug
    if (container.Config.Entrypoint.length === 0) {
        container.Config.Entrypoint = null;
    }

    container.Driver = 'sdc';
    container.ExecDriver = 'sdc-0.1';

    container.HostConfig = {
        'Binds': [],
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

    container.Volumes = {};
    container.VolumesRW = {};

    if (obj.filesystems) {
        obj.filesystems.forEach(function (f) {
            var m_data = f.source.match(data_volume_regex);
            var m_host = f.source.match(host_volume_regex);
            if (f.type === 'zfs' && m_data) {
                container.Config.Volumes[f.target] = {};
                container.VolumesRW[f.target] = true;
                container.Volumes[f.target] = f.source;
            } else if (f.type === 'lofs' && m_host) {
                container.Volumes[f.target] = {};
                container.HostConfig.Binds.push(m_host[1] + ':' + f.target);
            }
        });
    }

    // docker returns these as null instead of empty arrays when unset
    if (Object.keys(container.Config.Volumes).length === 0) {
        container.Config.Volumes = null;
    }
    if (Object.keys(container.Volumes).length === 0) {
        container.Volumes = null;
    }
    if (Object.keys(container.VolumesRW).length === 0) {
        container.VolumesRW = null;
    }
    if (container.HostConfig.Binds.length === 0) {
        container.HostConfig.Binds = null;
    }

    container.HostnamePath = '/etc/hostname';
    container.HostsPath = '/etc/hosts';
    container.Image = image.Id;
    container.MountLabel = '';
    container.Name = '/' + obj.alias;

    // default to empty
    container.NetworkSettings = {
        'PortMapping': null,
        'Ports': {}
    };

    obj.nics.forEach(function (nic) {
        if (nic.primary) {
            container.NetworkSettings = {
                'Bridge': nic.interface,
                'Gateway': nic.gateway,
                'IPAddress': nic.ip,
                'IPPrefixLen': netmaskToBits(nic.netmask),
                'MacAddress': nic.mac,
                'PortMapping': null,
                'Ports': {}
            };
        }
    });

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

    return container;
}

function imgobjToInspect(obj) {
    assert.object(obj, 'obj');
    var image = obj.serialize();

    var dockerImage = {
        Architecture: 'amd64', // ?
        Author: '', // ?
        Comment: image.description, // ?
        Config: image.config,
        Container: '', // which container?
        ContainerConfig: image.container_config,
        Created: new Date(image.created),
        DockerVersion: common.SERVER_VERSION,
        Id: image.docker_id,
        Os: 'Joyent Smart Data Center',
        Parent: image.parent,
        Size: image.size,
        VirtualSize: image.virtual_size
    };

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

function isUUID(str)
{
    var re = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (str && str.length === 36 && str.match(re)) {
        return true;
    } else {
        return false;
    }
}

// ---- exports

module.exports = {
    dockerIdToUuid: dockerIdToUuid,
    isUUID: isUUID,
    getImgapiImageForName: getImgapiImageForName,
    imgobjToInspect: imgobjToInspect,
    vmobjToContainer: vmobjToContainer,
    vmobjToInspect: vmobjToInspect
};
