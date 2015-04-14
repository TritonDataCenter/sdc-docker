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

function uuidToDockerId(uuid) {
    return (uuid + uuid).replace(/-/g, '');
}

function uuidToShortDockerId(uuid) {
    return uuid.replace(/-/g, '').slice(0, 12);
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
    var data_volume_regex = /\/volumes\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
    /* JSSTYLED */
    var host_volume_regex = /\/hostvolumes(\/.*)$/;
    var im = obj.internal_metadata;
    var imgs = opts.imgs; // XXX imgs is a hack until we have better lookup
    var log = opts.log;
    var parts;
    var port;
    var restartpolicy;
    var vf;

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
        'AppArmorProfile': '',
        'AttachStderr': im['docker:attach_stderr'] || false,
        'AttachStdin': im['docker:attach_stdin'] || false,
        'AttachStdout': im['docker:attach_stdout'] || false,
        'CpuShares': obj.cpu_shares,
        'Cpuset': '',
        'Domainname': obj.dns_domain || '',
        'ExposedPorts': null,
        'Hostname': obj.hostname || '',
        'MacAddress': '',
        'Memory': obj.max_physical_memory * (1024 * 1024),
        'MemorySwap': obj.max_swap * (1024 * 1024),
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
    var repoAndTag;

    log.debug({image: image}, 'getImage() returned an image');

    if (image.RepoTags[0]) {
        repoAndTag = image.RepoTags[0].split(':');
        if (repoAndTag[1] && repoAndTag[1] === 'latest') {
            container.Config.Image = repoAndTag[0];
        } else {
            container.Config.Image = image.RepoTags[0];
        }
    } else {
        container.Config.Image = '<none>:<none>';
    }

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
        'IpcMode': '',
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
            var im_hostvols;

            if (f.type === 'lofs' && m_data) {
                if (f.source.indexOf(obj.zonepath) === 0) {
                    // If it were a --volumes-from volume (ie. does not belong
                    // to this VM directly) we'd not include it here.
                    container.Config.Volumes[f.target] = {};
                }
                container.VolumesRW[f.target] = true;
                container.Volumes[f.target] = f.source;
            } else if (f.type === 'lofs' && m_host) {
                container.Volumes[f.target] = {};
                // pull out the URL for the host volume.
                if (obj.internal_metadata
                    .hasOwnProperty('docker:hostvolumes')) {

                    im_hostvols = JSON.parse(obj
                        .internal_metadata['docker:hostvolumes']);

                    if (im_hostvols[f.target] && im_hostvols[f.target].source) {
                        container.HostConfig.Binds.push(im_hostvols[f.target]
                            .source + ':' + f.target);
                    }
                }
            }
        });
    }

    if (obj.internal_metadata && obj.internal_metadata['docker:volumesfrom']) {
        vf = JSON.parse(obj.internal_metadata['docker:volumesfrom']);

        vf.forEach(function (vf_uuid) {
            if (!container.HostConfig.VolumesFrom) {
                container.HostConfig.VolumesFrom = [];
            }
            container.HostConfig.VolumesFrom.push(uuidToShortDockerId(vf_uuid));
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

    if (obj.internal_metadata
        && obj.internal_metadata['docker:restartpolicy']) {

        restartpolicy = obj.internal_metadata['docker:restartpolicy'];
        if (restartpolicy === 'always') {
            container.HostConfig.RestartPolicy.Name = 'always';
        } else {
            parts = restartpolicy.split(':');
            if (parts[0] === 'on-failure') {
                if (parts.length === 1) {
                    container.HostConfig.RestartPolicy.Name = 'on-failure';
                } else if ((parts.length === 2) && (!isNaN(Number(parts[1])))) {
                    container.HostConfig.RestartPolicy.Name = 'on-failure';
                    container.HostConfig.RestartPolicy.MaximumRetryCount
                        = Number(parts[1]);
                } else {
                    log.warn('ignoring broken on-failure on container(%s): %s',
                        container.Id, restartpolicy);
                }
            } else {
                log.warn('ignoring unknown restartpolicy on container(%s): %s',
                    container.Id, restartpolicy);
            }
        }
    }

    if (obj.internal_metadata && obj.internal_metadata['docker:restartcount']
        && !isNaN(Number(obj.internal_metadata['docker:restartcount']))) {

        container.RestartCount
            = Number(obj.internal_metadata['docker:restartcount']);
    } else {
        container.RestartCount = 0;
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

    if (im && im['docker:publish_all_ports']) {
        container.HostConfig.PublishAllPorts = true;
    }

    if (image.ExposedPorts) {
        container.Config.ExposedPorts = {};
        for (port in image.ExposedPorts) {
            container.Config.ExposedPorts[port] = {};
            container.NetworkSettings.Ports[port] = null;
        }
    }

    function addNetSettingsPort(nsProto, cp) {
        var portStr = cp + '/' + nsProto;

        container.NetworkSettings.Ports[portStr] = [
            {
                'HostIp': '0.0.0.0',
                'HostPort': cp.toString()
            }
        ];
    }

    function addPortBindingsPort(pbProto, cp) {
        var portStr = cp + '/' + pbProto;

        container.HostConfig.PortBindings[portStr] = [
            {
                'HostIp': '',
                'HostPort': cp.toString()
            }
        ];

        if (!container.Config.ExposedPorts) {
            container.Config.ExposedPorts = {};
        }

        container.Config.ExposedPorts[portStr] = {};
    }

    if (im) {
        var imKey;
        var protocols = ['tcp', 'udp'];
        var proto;

        for (var p in protocols) {
            proto = protocols[p];
            imKey = 'docker:' + proto + '_published_ports';

            if (im[imKey]) {
                JSON.parse(im[imKey]).forEach(function (nsPort) {
                    addNetSettingsPort(proto, nsPort);
                });
            }

            imKey = 'docker:' + proto + '_bound_ports';
            if (im[imKey]) {
                JSON.parse(im[imKey]).forEach(function (pbPort) {
                    addPortBindingsPort(proto, pbPort);
                });
            }
        }
    }

    container.ProcessLabel = '';
    container.ResolvConfPath = '/etc/resolv.conf';

    container.State = {
        'Error': '', // TODO: fill this in when error available
        'ExitCode': obj.exit_status || 0,
        'FinishedAt': obj.exit_timestamp || '0001-01-01T00:00:00Z',
        'OOMKilled': false,
        'Paused': false,
        'Pid': obj.pid || 0,
        'Restarting': false,
        'Running': ((obj.state === 'running') ? true : false),
        'StartedAt': obj.boot_timestamp || '0001-01-01T00:00:00Z'
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

function isValidDockerConatinerName(str) {
    var re = /^\/?[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
    return str && str.match(re);
}

// ---- exports

module.exports = {
    isValidDockerConatinerName: isValidDockerConatinerName,
    getImgapiImageForName: getImgapiImageForName,
    imgobjToInspect: imgobjToInspect,
    vmobjToContainer: vmobjToContainer,
    vmobjToInspect: vmobjToInspect
};
