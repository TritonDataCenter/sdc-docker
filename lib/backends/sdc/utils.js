/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var format = require('util').format;
var mod_fwrule = require('fwrule');
var net = require('net');
var restify = require('restify');
var triton_tags = require('triton-tags');

var common = require('../../common');
var constants = require('../../constants');
var Link = require('../../models/link');



function vmUuidToShortDockerId(uuid) {
    return uuid.replace(/-/g, '').slice(0, 12);
}

function networkUuidToDockerId(uuid) {
    return (uuid + uuid).replace(/-/g, '');
}

function shortNetworkIdToUuidPrefix(id) {
    var partial = '';

    // consider a uuid as eight groups of four chars, plus hyphens.
    // concatenate those groups in reverse order, jumping to the
    // appropriate starting group.

    switch (Math.ceil(id.substr(0, 32).length / 4)) {
    case 8: // 'abcdabcd-abcd-abcd-abcd-abcdabcdabcd'
    case 7: // 'abcdabcd-abcd-abcd-abcd-abcdabcd'
    case 6: // 'abcdabcd-abcd-abcd-abcd-abcd'
        partial = '-' + id.substr(20, 12) + partial; /*jsl:fallthru*/
    case 5: // 'abcdabcd-abcd-abcd-abcd'
        partial = '-' + id.substr(16, 4) + partial;  /*jsl:fallthru*/
    case 4: // 'abcdabcd-abcd-abcd'
        partial = '-' + id.substr(12, 4) + partial;  /*jsl:fallthru*/
    case 3: // 'abcdabcd-abcd'
        partial = '-' + id.substr(8, 4) + partial;   /*jsl:fallthru*/
    case 2: // 'abcdabcd'
    case 1: // 'abcd'
        partial = id.substr(0, 8) + partial;         /*jsl:fallthru*/
    case 0:
    default:
        break;
    }
    return partial;
}

/**
 * Docker containers are stored on the VM "tags" field
 * (https://github.com/joyent/sdc-vmapi/blob/master/docs/index.md#vm-metadata).
 * General docker labels are prefixed with 'docker:label:' (AFAIK the only
 * need for that separation is the use of the 'sdc_docker' tag for fwrules).
 *
 * In addition, the special structured 'triton.'-prefixed tags are exposed
 * as Docker labels (see DOCKER-728).
 *
 * Note: Docker label values must be strings otherwise the docker 1.10 client
 * will blow up. See https://github.com/docker/docker/issues/20881 and
 * DOCKER-721. Currently VM.tags are limited to string, boolean or number,
 * so we can simply `.toString()`.
 */
function dockerLabelsFromVmTags(tags) {
    const expectedTypes = {string: true, boolean: true, number: true};
    var labels = {};
    const LABELTAG_PREFIX = common.LABELTAG_PREFIX;

    var strFromLabelVal = function (val) {
        if (!expectedTypes[typeof (val)]) {
            throw new Error(format(
                'unexpected VM tag value type: val=%j, type=%j',
                val, typeof (val)));
        }
        return val.toString();
    };

    Object.keys(tags).forEach(function (key) {
        if (key.substr(0, LABELTAG_PREFIX.length) === LABELTAG_PREFIX) {
            labels[key.substr(LABELTAG_PREFIX.length)]
                = strFromLabelVal(tags[key]);
        }
    });

    /*
     * Add the 'triton.' tags last so they 'win' over (obsolete, legacy)
     * 'docker:label:triton.'.
     */
    Object.keys(tags).forEach(function (key) {
        if (triton_tags.isTritonTag(key)) {
            labels[key] = strFromLabelVal(tags[key]);
        }
    });

    return labels;
}


function getPublishingRules(opts, fwrules) {
    var log = opts.log;
    var uuid = opts.vm.uuid;
    return fwrules.reduce(function (published, rule) {
        var fwrule;
        try {
            fwrule = new mod_fwrule.FwRule(rule);
        } catch (e) {
            log.error(e, {
                rule: rule
            }, 'Failed to parse rule while producing inspect info');
            return published;
        }

        // We only process open TCP and UDP ports that go to our VM
        if (fwrule.protocol !== 'tcp' && fwrule.protocol !== 'udp') {
            return published;
        }

        if (fwrule.action !== 'allow'
            || fwrule.to.vms.indexOf(uuid) === -1
            || fwrule.ports.indexOf('all') !== -1
            || fwrule.from.wildcards.indexOf('any') === -1) {
            return published;
        }

        published.push(fwrule);
        return published;
    }, []);
}

/*
 * With Docker 1.10 (API version 1.22) the filters changed from an array to an
 * object with the value true.
 *
 * In 1.9.1:
 *
 *     filters={"label":["com.joyent.package=sample-2G", "foo=bar"]}
 *
 * In 1.10.0:
 *
 *     filters={"label":{"com.joyent.package=sample-2G":true, "foo=bar":true}}
 *
 * This function accepts either format and returns an object in the 1.9.1
 * (array) format.
 */
function getNormalizedFilters(filters) {
    assert.object(filters, 'filters');

    var i;
    var name;
    var names = Object.keys(filters);
    var newFilters = {};
    var val;

    for (i = 0; i < names.length; i++) {
        name = names[i];
        val = filters[name];
        if (Array.isArray(val)) {
            newFilters[name] = val; // Nothing to convert.
        } else if (typeof (val) === 'object') {
            // Convert to an array of keys.
            newFilters[name] = Object.keys(val);
        } else {
            return new Error(format(
                'invalid filter "%s" - expected an array or object, got: %j',
                name, val));
        }
    }

    return newFilters;
}

function getPublishedPorts(opts, fwrules, cb) {
    getPublishingRules(opts, fwrules).forEach(function (fwrule) {
        fwrule.ports.forEach(function (pbPort) {
            var curr, end;
            if (pbPort.hasOwnProperty('start')
                && pbPort.hasOwnProperty('end')) {
                end = pbPort.end;
                for (curr = pbPort.start; curr <= end; curr++) {
                    cb(fwrule.protocol, curr);
                }
            } else {
                cb(fwrule.protocol, pbPort);
            }
        });
    });
}


/*
 * Get the Docker-compatible human-readable description of the container state.
 *
 * This emulates:
 * https://github.com/docker/docker/blob/483063a/container/state.go#L39-L69
 */
function _containerStatusFromVmobj(opts) {
    assert.object(opts.vmobj, 'opts.vmobj');
    assert.object(opts.log, 'opts.log');

    var boot_timestamp = new Date(opts.vmobj.boot_timestamp);
    var exittime;
    var now = new Date();
    var status;
    var uptime;
    var vmobj = opts.vmobj;

    if (vmobj.state == 'running') {
        uptime = Math.floor((now - boot_timestamp) / 1000);
        status = 'Up ' + common.humanDuration(uptime);
    } else if (vmobj.state == 'provisioning' && vmobj.create_timestamp) {
        uptime = Math.floor((now - (new Date(vmobj.create_timestamp))) / 1000);
        status = 'Provisioning ' + common.humanDuration(uptime);
    } else if (vmobj.state == 'stopped') {
        /*
         * Possibilities here:
         * 1. We have `VM.exit_status` and `VM.exit_timestamp`. The VM exited
         *    and zoneadmd saw it.
         * 2. The zone never started. `vmadm` sets
         *    `VM.internal_metadata['restartcount']` on first start.
         * 3. The CN crashed or hard-stopped such that zoneadmd couldn't
         *    cleanly stop this zone and write out 'lastexited'.
         *    Docker-docker (at least 1.11) returns "Exited (0) $timeAgo"
         *    for this case. AFAICT that 0 is just a default and $timeAgo
         *    is when containerd started up again and noticed the
         *    container is stopped. See RFD 30 to have a better answer
         *    for this.
         */
        if (vmobj.hasOwnProperty('exit_status')
            && vmobj.hasOwnProperty('exit_timestamp'))
        {
            exittime
                = Math.floor((now - (new Date(vmobj.exit_timestamp))) / 1000);
            status = 'Exited (' + vmobj.exit_status + ') '
                + common.humanDuration(exittime) + ' ago';
        } else if (vmobj.internal_metadata
            && vmobj.internal_metadata.hasOwnProperty('docker:restartcount'))
        {
            status = 'Exited';
        } else {
            status = 'Created';
        }
    } else {
        // TODO: handle other states here! See "VM STATES" in `man vmadm`.
        status = '';
    }

    assert.string(status, 'status');
    return status;
}


function vmobjToContainer(opts, obj, fwrules, callback)
{
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.arrayOfObject(opts.imgs, 'opts.imgs');
    assert.object(opts.log, 'opts.log');
    assert.object(obj, 'obj');
    assert.string(obj.alias, 'obj.alias');

    var cmd = [];
    var container = {};
    var imgs = opts.imgs; // XXX imgs is a hack until we have better lookup
    var log = opts.log;
    var quoted_args = [];
    var im = obj.internal_metadata;
    var seenPorts = {
        tcp: [],
        udp: []
    };

    if (im && im['docker:id']) {
        container.Id = im['docker:id'];
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

    if (im && im['docker:entrypoint']) {
        cmd = cmd.concat(
            JSON.parse(im['docker:entrypoint']));
    }
    if (im && im['docker:cmd']) {
        cmd = cmd.concat(JSON.parse(im['docker:cmd']));
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

    // Names: ['/redis32', <linked names>]
    container.Names = ['/' + obj.alias];

    container.Status = _containerStatusFromVmobj({vmobj: obj, log: log});

    // `docker ps` shows the image REPO[:TAG], or the short imageId.
    var image = imageFromUuid(opts.log, imgs, obj.image_uuid);
    container.Image = nameFromImage(image);

    // Add container labels from vm.tags:
    container.Labels = dockerLabelsFromVmTags(obj.tags || {});

    // Ports, nginx examples below for 'docker ps':
    //  not exposed: {"PrivatePort":80,"Type":"tcp"}
    //  -P {"IP":"0.0.0.0","PrivatePort":80,"PublicPort":49158,"Type":"tcp"}
    //  -p 80:80 {"IP":"0.0.0.0","PrivatePort":80,"PublicPort":80,"Type":"tcp"}
    container.Ports = [];

    // Add the exposed ports:
    getPublishedPorts({ log: log, vm: obj }, fwrules, function (proto, port) {
        container.Ports.push({
            'IP': '0.0.0.0',
            // sdc-docker doesn't allow a different port mapping.
            'PrivatePort': port,
            'PublicPort': port,
            'Type': proto
        });
        seenPorts[proto].push(port);
    });

    // Add the non-exposed ports:
    if (image && image.ExposedPorts) {
        Object.keys(image.ExposedPorts).forEach(function (portAndProto) {
            // portAndProto looks like: "80/tcp"
            var portStr = portAndProto.split('/', 1)[0];
            var proto = portAndProto.slice(portStr.length+1);
            var port = parseInt(portStr, 10);
            if (seenPorts.hasOwnProperty(proto)
                && seenPorts[proto].indexOf(port) == -1) {
                container.Ports.push({
                    'PrivatePort': port,
                    'Type': proto
                });
                seenPorts[proto].push(port);
            }
        });
    }

    function _addLinkNames() {
        // Find links that target this container.
        var params = {
            owner_uuid: obj.owner_uuid,
            target_uuid: obj.uuid
        };
        Link.find(opts.app, opts.log, params, function (err, links) {
            if (err) {
                return callback(err);
            }
            links.forEach(function (l) {
                container.Names.push(l.ps_config);
            });

            callback(null, container);
        });
    }

    // Asynchronously add link names and fire the callback.
    _addLinkNames();
}


/*
 * Find the 'image' (object of the structure from backend.listImages())
 * matching the given IMGAPI image UUID.
 *
 * There are two things that could result in this not finding a matching image:
 * - The `docker_images` entry for this image was removed for this account.
 *   This is possible if sdc-docker doesn't *strictly* follow `docker rmi`
 *   semantics where an image used by a current container can't be removed.
 * - The great image UUID renaming for private registry support.
 *
 * @param {Bunyan Logger} log
 * @param {Array} img  Array of docker image objects from `backend.listImages`
 *      giving all current images for the relevant account. This code relies
 *      on the `Uuid` field in each element of this array.
 * @param {UUID} imgUuid  The IMGAPI image UUID to find.
 * @returns {Object} Details on the image, e.g.
 *          {
 *              Id: <docker image id>,
 *              RepoTags: [<REPO:TAG1>, ...],
 *              ...
 *          }
 *      If the image is not found, then `undefined` is returned.
 */
function imageFromUuid(log, imgs, imgUuid)
{
    var image;
    for (var i = 0; i < imgs.length; i++) {
        if (imgs[i].Uuid === imgUuid) {
            image = imgs[i];
            break;
        }
    }
    log.debug({imgUuid: imgUuid, found: Boolean(image), image: image},
        'imageFromUuid');
    return image;
}


/**
 * Return a name (suitable for some of the 'Image' fields in inspect
 * responses) for the given image (of the format returned from `imageFromUuid`).
 */
function nameFromImage(image, excludeLatest) {
    assert.optionalBool(excludeLatest, 'excludeLatest');
    var name;
    if (!image) {
        name = '<unknown>';
    } else if (image.RepoTags && image.RepoTags.length) {
        name = image.RepoTags[0];
        var idx = name.lastIndexOf(':');
        if (idx !== -1 && name.slice(idx) === ':latest') {
            name = name.slice(0, idx);
        }
    } else {
        name = image.Id.slice(0, 12);
    }
    return name;
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
function vmobjToInspect(opts, obj, vmData, callback) {
    assert.object(opts, 'opts');
    assert.finite(opts.clientApiVersion, 'opts.clientApiVersion');
    assert.arrayOfObject(opts.imgs, 'opts.imgs');
    assert.object(opts.log, 'opts.log');
    assert.string(obj.alias, 'obj.alias');
    assert.object(vmData, 'vmData');
    assert.object(vmData.fwrules, 'vmData.fwrules');
    assert.object(vmData.pkg, 'vmData.pkg');

    var cmdline = [];
    var container = {};
    /* JSSTYLED */
    var data_volume_regex = /\/volumes\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
    /* JSSTYLED */
    var host_volume_regex = /\/hostvolumes(\/.*)$/;
    var fwrules = vmData.fwrules;
    var im = obj.internal_metadata;
    var imgs = opts.imgs; // XXX imgs is a hack until we have better lookup
    var labels = {};
    var log = opts.log;
    var logConfig;
    var parts;
    var pkg = vmData.pkg;
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

    var image = imageFromUuid(log, imgs, obj.image_uuid);
    container.Config.Image = nameFromImage(image, true);

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
    if (container.Config.Cmd.length === 0) {
        container.Config.Cmd = null;
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
        'LogConfig': {
            'Type': 'json-file',
            'Config': {}
        },
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
                if (!f.options || f.options.indexOf('ro') === -1) {
                    container.VolumesRW[f.target] = true;
                }
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
            container.HostConfig.VolumesFrom.push(
                vmUuidToShortDockerId(vf_uuid));
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

    if (obj.resolvers) {
        container.HostConfig.Dns = obj.resolvers;
    }

    if (obj.internal_metadata
        && obj.internal_metadata['docker:dnssearch']) {

        try {
            container.HostConfig.DnsSearch
                = JSON.parse(obj.internal_metadata['docker:dnssearch']);
        } catch (e) {
            log.warn({err: e}, 'Failed to parse docker:dnssearch');
        }
    }

    if (obj.internal_metadata && obj.internal_metadata['docker:extraHosts']) {
        try {
            container.HostConfig.ExtraHosts
                = JSON.parse(obj.internal_metadata['docker:extraHosts']);
        } catch (e) {
            log.warn({err: e,
                containerId: container.Id,
                extraHosts: obj.internal_metadata['docker:extraHosts']},
                'Failed to parse docker:extraHosts');
        }
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

    if (obj.internal_metadata && obj.internal_metadata['docker:logdriver']) {
        container.HostConfig.LogConfig.Type
            = obj.internal_metadata['docker:logdriver'];
        if (obj.internal_metadata['docker:logconfig']) {
            try {
                logConfig
                    = JSON.parse(obj.internal_metadata['docker:logconfig']);
                container.HostConfig.LogConfig.Config = logConfig;
            } catch (e) {
                log.warn({err: e, obj: obj},
                    'unable to parse docker:logconfig');
            }
        }
    }

    container.HostnamePath = '/etc/hostname';
    container.HostsPath = '/etc/hosts';
    if (!image) {
        container.Image = '<none>';
    } else {
        container.Image = image.Id;
    }
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

    if (image && image.ExposedPorts) {
        container.Config.ExposedPorts = {};
        for (port in image.ExposedPorts) {
            container.Config.ExposedPorts[port] = {};
            container.NetworkSettings.Ports[port] = null;
        }
    }

    function addPublishedPort(nsProto, cp) {
        var portStr = cp + '/' + nsProto;

        container.NetworkSettings.Ports[portStr] = [
            {
                'HostIp': '0.0.0.0',
                'HostPort': cp.toString()
            }
        ];

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

    getPublishedPorts({ log: log, vm: obj }, fwrules, addPublishedPort);

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

    /*
     * Version-specific mutations
     */
    if (opts.clientApiVersion < 1.18) {
        container.Config.AppArmorProfile = '';
    }

    if (opts.clientApiVersion >= 1.18) {
        container.Config.Labels = null;
        if (obj.tags) {
            // Add container labels from vm.tags:
            labels = dockerLabelsFromVmTags(obj.tags);
            if (!common.objEmpty(labels)) {
                container.Config.Labels = labels;
            }
        }

        // Add com.joyent.package label
        if (pkg.name) {
            if (container.Config.Labels === null) {
                container.Config.Labels = {};
            }
            container.Config.Labels['com.joyent.package'] = pkg.name;
        }

        container.ExecIDs = null;
        container.HostConfig.CgroupParent = '';
        container.HostConfig.CpuShares = container.Config.CpuShares;
        container.HostConfig.CpusetCpus = '';
        container.HostConfig.Memory = container.Config.Memory;
        container.HostConfig.MemorySwap = container.Config.MemorySwap;
        container.HostConfig.PidMode = '';
        container.HostConfig.ReadonlyRootfs = false;
        container.HostConfig.SecurityOpt = null;
        container.HostConfig.Ulimits = null;
    } else {
        delete container.HostConfig.LogConfig;
    }

    // HostConfig.Links
    function _addLinks() {
        var params = {
            owner_uuid: obj.owner_uuid,
            container_uuid: obj.uuid
        };
        Link.find(opts.app, log, params, function (err, links) {
            if (err) {
                return callback(err);
            }
            if (links && links.length > 0) {
                container.HostConfig.Links = links.map(function (l) {
                    return l.inspect_config;
                });
            }

            callback(null, container);
        });
    }

    // Asynchronously add links and fire the callback.
    _addLinks();
}

function imgobjToInspect(obj, imgTags) {
    assert.object(obj, 'obj');
    assert.optionalArrayOfObject(imgTags, 'imgTags');

    var image = obj.serialize();

    var dockerImage = {
        Architecture: image.architecture || 'amd64',
        Author: image.author,
        Comment: image.comment,
        Config: image.config,
        Container: '', // which container?
        ContainerConfig: image.container_config,
        Created: new Date(image.created),
        DockerVersion: constants.SERVER_VERSION,
        GraphDriver: {
            Data: null,
            Name: 'sdc-docker'
        },
        Id: image.docker_id,
        Os: 'Linux',
        Parent: image.parent || '',
        RepoTags: [],
        RepoDigests: [], // ?
        Size: image.size,
        VirtualSize: image.virtual_size
    };

    // Add image tags if available.
    if (imgTags && imgTags.length > 0) {
        dockerImage.RepoTags = imgTags.map(function (it) {
            return it.repo + ':' + it.tag;
        });
    }

    return dockerImage;
}

function isValidDockerConatinerName(str) {
    var re = /^\/?[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
    return str && str.match(re);
}

/*
 * Turn an array of numbers into a series of ranges and non-adjacent numbers.
 */
function compressPorts(ports) {
    var sorted = [], ranges = [];
    var port, i;
    if (ports.length === 0) {
        return;
    }

    for (i = 0; i < ports.length; i++) {
        port = ports[i];
        if (port <= 0) {
            continue;
        }
        sorted[port] = port;
    }

    var raw = Object.keys(sorted);
    var start = 0, end = 0;
    for (i = 0; i < raw.length; i++) {
        port = Number(raw[i]);

        if (start === 0) {
            start = port;
            end = port;
        } else if ((end + 1) === port) {
            end = port;
        } else {
            ranges.push(start === end ? start : { start: start, end: end });
            start = port;
            end = port;
        }
    }
    ranges.push(start === end ? start : { start: start, end: end });

    return ranges;
}

/*
 * Escapes strings for ldap filters.
 * See: pfmooney/node-ldap-filter/lib/substr_filter.js#L12-L15
 */
// XXX - workaround for NAPI-367
function ldapEscape(str) {
    /* JSSTYLED */
    return str.replace(/[=\(\)\*\\]/g, '\\$&');
}

// ---- exports

module.exports = {
    compressPorts: compressPorts,
    vmUuidToShortDockerId: vmUuidToShortDockerId,
    networkUuidToDockerId: networkUuidToDockerId,
    shortNetworkIdToUuidPrefix: shortNetworkIdToUuidPrefix,
    getNormalizedFilters: getNormalizedFilters,
    getPublishedPorts: getPublishedPorts,
    isValidDockerConatinerName: isValidDockerConatinerName,
    imgobjToInspect: imgobjToInspect,
    vmobjToContainer: vmobjToContainer,
    vmobjToInspect: vmobjToInspect,
    ldapEscape: ldapEscape
};
