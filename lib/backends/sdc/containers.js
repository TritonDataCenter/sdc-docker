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
var errors = require('../../../lib/errors');
var child_process = require('child_process');
var execFile = child_process.execFile;
var once = require('once');
var spawn = child_process.spawn;
var libuuid = require('libuuid');
var CNAPI = require('sdc-clients').CNAPI;
var IMGAPI = require('sdc-clients').IMGAPI;
var NAPI = require('sdc-clients').NAPI;
var PAPI = require('sdc-clients').PAPI;
var vasync = require('vasync');
var VMAPI = require('sdc-clients').VMAPI;
var net = require('net');
var restify = require('restify');

var utils = require('./utils');



//---- globals

var _cnapiClientCache; // set in `getCnapiClient`
var _imgapiClientCache; // set in `getImgapiClient`
var _napiClientCache; // set in `getNapiClient`
var _papiClientCache; // set in `getPapiClient`
var _vmapiClientCache; // set in `getVmapiClient`

var VM_DEFAULT_KERNEL_VERSION = '3.13.0';
var VM_DEFAULT_MAX_LWPS = 2000;
var VM_DEFAULT_QUOTA = 100;     // GiB
var VM_DEFAULT_MEMORY = 8192;   // MiB
var VM_DEFAULT_ZFS_IO_PRIORITY = 100;

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
                callback(new errors.papiErrorWrap(
                    err, 'problem listing packages'));
                return;
            }

            if (count !== 1 || pkgs[0].name !== opts.config.defaultPackage) {
                callback(new errors.DockerError('failed to get package '
                    + opts.config.defaultPackage));
                return;
            }

            callback(null, pkgs[0].uuid);
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
                // no tag was specified
                var imageName = (opts.imageName.split(':').length === 1 ?
                    (opts.imageName + ':latest') : opts.imageName);
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
    assert.string(container.Image, 'container.Image');
    assert.string(container.Name, 'container.Name');

    var bad_host_volumes = [];
    var dockerid;
    var log = opts.log;
    var simple_map = {
        Hostname: 'hostname',
        Domainname: 'dns_domain',
        CpuShares: 'cpu_shares'
    };

    var payload = {
        owner_uuid: opts.account.uuid
    };

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

    // If there was no hostname passed, use the first 12 characters of dockerid
    // like docker does.
    if (!payload.hasOwnProperty('hostname')) {
        payload.hostname = dockerid.substr(0, 12);
    }

    payload.alias = ltrim(container.Name, '/');
    payload.internal_metadata = {
        'docker:id': dockerid
    };

    if (container.Cmd) {
        assert.arrayOfString(container.Cmd, 'container.Cmd');
        payload.internal_metadata['docker:cmd'] = JSON.stringify(container.Cmd);
    }

    if (container.Entrypoint) {
        assert.arrayOfString(container.Entrypoint, 'container.Entrypoint');
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
        assert.arrayOfString(container.Env, 'container.Env');
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

    if (container.HostConfig.RestartPolicy) {
        if (container.HostConfig.RestartPolicy
            && container.HostConfig.RestartPolicy.Name) {

            if (container.HostConfig.RestartPolicy.Name === 'always') {
                payload.internal_metadata['docker:restartpolicy'] = 'always';
            } else if (container.HostConfig.RestartPolicy.Name
                === 'on-failure') {

                if (container.HostConfig.RestartPolicy.MaximumRetryCount) {
                    payload.internal_metadata['docker:restartpolicy'] =
                        'on-failure:' + container.HostConfig.RestartPolicy
                        .MaximumRetryCount.toString();
                } else {
                    payload.internal_metadata['docker:restartpolicy']
                        = 'on-failure';
                }
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
     * Regular -v /data volumes, we'll create a new ZFS dataset for these.
     */
    if (container.Volumes) {
        if (Object.keys(container.Volumes).length > MAX_DATA_VOLUMES) {
            log.error({data_volumes: container.Volumes},
                'too many data volumes: max ' + MAX_DATA_VOLUMES);
            callback(new errors.DockerError('too many data volumes: max '
                + MAX_DATA_VOLUMES));
            return;
        }

        Object.keys(container.Volumes).forEach(function (v) {
            // v will be something like: `/dir` and container.Volumes[v] will be
            // an object with options.

            _addDataVolume(v);
        });
    }

    /*
     * "Host" volumes created using -v http[s]://example/file:/container/file
     * We'll download http[s]://example/file and write it to a new directory in
     * the zone's dataset but not in the zoneroot, and we'll mount that into the
     * container at /container/file.
     */
    if (container.HostConfig && container.HostConfig.Binds) {
        if (container.HostConfig.Binds.length > MAX_HOST_VOLUMES) {
            log.error({host_volumes: container.HostConfig.Binds},
                'too many host volumes: max ' + MAX_HOST_VOLUMES);
            callback(new errors.DockerError(
                'too many host volumes: max ' + MAX_HOST_VOLUMES));
            return;
        }

        container.HostConfig.Binds.forEach(function (v) {
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
        function (_, cb) {
            getNetworks(opts, function (err, networks) {
                var external_net;

                if (!err) {
                    networks.forEach(function (n) {
                        if (!external_net
                            && n.name === 'external'
                            && n.nic_tag === 'external') {

                            external_net = n.uuid;
                        }
                    });

                    if (!external_net) {
                        cb(new errors.DockerError(
                            'unable to find external network uuid'));
                        return;
                    }
                    payload.networks = [ {uuid: external_net, primary: true} ];
                }

                cb(err);
            });
        }, function (_, cb) {
            // This must happen after we've added the owner_uuid to the payload.

            var get_opts = {
                log: log,
                req_id: opts.req_id,
                vmapi: opts.vmapi
            };
            var vf_containers = [];
            var vf;

            function _addContainerVolumes(id, next) {
                /* JSSTYLED */
                var data_volume_regex = /\/volumes\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
                var msg;

                // get container
                getContainerById(id, get_opts, function (err, vmobj) {
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

            if (container.HostConfig && container.HostConfig.VolumesFrom) {
                vf = container.HostConfig.VolumesFrom;
                if (vf.length > MAX_VOLUMES_FROM) {
                    log.error({volumes_from: vf}, 'too many --volumes-from '
                        + 'options: max ' + MAX_VOLUMES_FROM);
                    cb(new errors.DockerError('too many --volumes-from: max '
                        + MAX_HOST_VOLUMES));
                    return;
                }

                // vf is an array of container "names"

                vasync.forEachParallel({
                    'func': _addContainerVolumes,
                    'inputs': vf
                }, function (err) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    payload.internal_metadata['docker:volumesfrom']
                        = JSON.stringify(vf_containers);

                    cb();
                });
                return;
            }
            cb();
        }, function (_, cb) {
            getPackage(opts, function (err, package_uuid) {
                if (!err) {
                    payload.billing_id = package_uuid;
                }
                cb(err);
            });
        }, function (_, cb) {
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
            // add defaults
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
    assert.object(opts.account, 'opts.account');
    assert.object(opts.vmapi, 'opts.vmapi');

    getContainerById(id, opts, function (err, vmobj) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, vmobj.uuid);
    });
}

/*
 * id here can be any of:
 *
 *  64-byte Docker ID
 *  12-char Shortend docker ID
 *  container name (alias)
 */
function getContainerById(id, opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
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
                && obj.internal_metadata['docker:id']
                && obj.internal_metadata['docker:id'].substr(0, 12) === id) {

                found_container = obj;
            } else if (id.length === 64
                && obj.internal_metadata['docker:id'] === id) {

                found_container = obj;
            } else if (id.length > 0 && obj.alias.length > 0
                && id === obj.alias) {

                found_container = obj;
            }
        });

        if (found_container) {
            callback(null, found_container);
        } else {
            log.error('findUuidForId(' + id + '): not found');
            callback(new restify.ResourceNotFoundError('not found'));
        }
    });
}


//---- exported SdcBackend methods

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
            log.error({
                err: payload_err,
                payload: payload,
                vm_payload: vm_payload
            }, 'failed to build vmapi payload');
            callback(new errors.DockerError(
                payload_err, 'problem building payload'));
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
                log.error({err: err, res: res}, 'createVM failed');
                callback(errors.vmapiErrorWrap(
                    err, 'problem creating container'));
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
    assert.object(opts.account, 'opts.account');

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
        account: opts.account,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        stop_params.owner_uuid = opts.account.uuid;
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
                callback(errors.vmapiErrorWrap(
                    stop_err, 'problem stopping container'));
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
    assert.object(opts.account, 'opts.account');

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
        account: opts.account,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        restart_params.owner_uuid = opts.account.uuid;
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
                callback(errors.vmapiErrorWrap(
                    restart_err, 'problem restarting container'));
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
    assert.object(opts.account, 'opts.account');

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
        account: opts.account,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        kill_params.owner_uuid = opts.account.uuid;
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
                callback(errors.vmapiErrorWrap(
                    kill_err,
                    'problem sending signal to container'));
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
    assert.object(opts.account, 'opts.account');

    var id = opts.id;
    var log = opts.log || this.log;
    var start_params = {};
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        account: opts.account,
        vmapi: vmapi
    }, function (find_err, uuid) {

        if (find_err) {
            callback(find_err);
            return;
        }

        start_params.owner_uuid = opts.account.uuid;
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
                return callback(errors.vmapiErrorWrap(start_err));
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
    assert.object(opts.account, 'opts.account');

    var id = opts.id;
    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        account: opts.account,
        vmapi: vmapi
    }, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        var deleteParams = {};
        deleteParams.owner_uuid = opts.account.uuid;
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
                return callback(errors.vmapiErrorWrap(
                    deleteErr, 'problem deleting container'));
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
    assert.object(opts.account, 'opts.account');

    var id = opts.id;
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

        findUuidForId(id, {
            log: log,
            req_id: opts.req_id,
            account: opts.account,
            vmapi: vmapi
        }, function (find_err, uuid) {

            if (find_err) {
                callback(find_err);
                return;
            }

            vmapi.getVm({ uuid: uuid }, {
                headers: {'x-request-id': opts.req_id}
            }, function _getVmCb(getErr, vm) {
                if (getErr) {
                    log.error(getErr, 'Error getting container.');
                    return callback(getErr);
                }

                var container = utils.vmobjToInspect({
                    imgs: imgs, // XXX this is a hack
                    log: log
                }, vm);
                container.Uuid = uuid;

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
    assert.object(opts.account, 'opts.account');

    var id = opts.id;
    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        account: opts.account,
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
    assert.object(opts.account, 'opts.account');

    var id = opts.id;
    var log = opts.log || this.log;
    var vmapi = getVmapiClient(this.config.vmapi);
    var uuid;

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        account: opts.account,
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
    assert.object(opts.account, 'opts.account');

    opts.vmapi = getVmapiClient(this.config.vmapi);
    opts.cnapi = getCnapiClient(this.config.cnapi);

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

        callback(null, socketData);
    });
}


function _runCreateSocket(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.vmapi, 'opts.vmapi');
    assert.object(opts.cnapi, 'opts.cnapi');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var id = opts.id;
    var log = opts.log;
    var payload = opts.payload;
    var vmapi = opts.vmapi;
    var cnapi = opts.cnapi;

    findUuidForId(id, {
        log: log,
        req_id: opts.req_id,
        account: opts.account,
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
    });
}


function _runExec(opts, callback) {
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
    var serverSocket = net.createConnection({ host: host, port: port });

    // Store a reference to the exec socket for future resizes
    socketData.socket = serverSocket;

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
                if (socketData.command.Tty) {
                    var data = JSON.stringify({ data: chunk.toString() })
                        + '\r\n';
                    serverSocket.write(data);
                } else {
                    serverSocket.write(chunk);
                }
            });
        }

        clientSocket.on('end', endSocket);
        clientSocket.on('error', endSocket);
        clientSocket.on('timeout', endSocket);

        serverSocket.on('error', function (error) {
            opts.log.error('serverSocket for %s threw an error %',
                cmdString, error.toString());

            cb(error, socketData);
        });

        serverSocket.on('close', function (had_error) {
            opts.log.debug('serverSocket %s closed, had_error=%s',
                cmdString, had_error);

            cb(null, socketData);
        });

        serverSocket.on('end', function () {
            opts.log.debug('serverSocket %s end', cmdString);
        });

        serverSocket.pipe(clientSocket);
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
                serverSocket.write(chunk);
                return;
            }

            var resizeData = opts.app.sockets.popResize(opts.id);
            var data = JSON.stringify({ data: chunk.toString() }) + '\r\n';

            if (resizeData) {
                var resize = JSON.stringify({ resize: resizeData }) + '\r\n';

                serverSocket.write(resize, function () {
                    serverSocket.write(data);
                });
            } else {
                serverSocket.write(data);
            }
        }

        if (socketData.command.AttachStdin) {
            clientSocket.on('data', onData);
        }

        clientSocket.on('end', endSocket);
        clientSocket.on('error', endSocket);
        clientSocket.on('timeout', endSocket);

        serverSocket.on('error', function (error) {
            opts.log.debug('attach for %s threw an error %',
                cmdString, error.toString());

            cb(error);
        });

        serverSocket.on('close', function (had_error) {
            opts.log.debug('attach %s closed, had_error=%s',
                cmdString, had_error);

            cb(null);
        });

        serverSocket.on('end', function () {
            opts.log.debug('attach %s end', cmdString);
        });

        serverSocket.pipe(clientSocket);
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
    assert.object(opts.account, 'opts.account');

    var log = opts.log;
    var vmapi = getVmapiClient(this.config.vmapi);
    var cnapi = getCnapiClient(this.config.cnapi);
    opts.vmapi = vmapi;
    opts.cnapi = cnapi;
    opts.id = opts.id.substr(0, 12);

    var socketData = opts.app.sockets.getSocket('attach', opts.id);

    vasync.pipeline({
        funcs: [
            getVm,
            createSocket,
            attach
        ]
    }, callback);

    function getVm(_, next) {
        findUuidForId(opts.id, {
            log: log,
            req_id: opts.req_id,
            account: opts.account,
            vmapi: vmapi
        }, function (find_err, uuid) {
            if (find_err) {
                next(find_err);
                return;
            }

            vmapi.getVm(
                { uuid: uuid },
                { headers: {'x-request-id': opts.req_id }
            }, function _getVmCb(getErr, vm) {
                if (getErr) {
                    log.error(getErr, 'Error getting container.');
                    next(getErr);
                    return;
                }

                if (vm.internal_metadata['docker:tty']) {
                    opts.payload.Tty = true;
                }

                next();
            });
        });
    }

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
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.number(opts.w, 'opts.w');
    assert.number(opts.h, 'opts.h');

    var id = opts.id.substr(0, 12);
    var vmapi = getVmapiClient(this.config.vmapi);

    var findOpts = {
        log: opts.log,
        req_id: opts.req_id,
        account: opts.account,
        vmapi: vmapi
    };

    findUuidForId(id, findOpts, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        opts.app.sockets.pushResize(id, { w: opts.w, h: opts.h });
        callback();
    });
}


/*
 * containerLogs resuses _runExec and _runCreateSocket
 */
function containerLogs(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.payload, 'opts.payload');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var log = opts.log;
    opts.vmapi = getVmapiClient(this.config.vmapi);
    opts.cnapi = getCnapiClient(this.config.cnapi);

    _runCreateSocket(opts, function (err, cmdId, socketData) {
        if (err) {
            log.error({err: err}, 'backend.containerLogs error');
            callback(err);
            return;
        }

        opts.cmdId = cmdId;
        opts.socketData = socketData;

        _runExec(opts, function (execErr) {
            if (execErr) {
                log.error({err: execErr}, 'backend.containerLogs error');
                callback(execErr);
                return;
            }

            callback();
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
                return callback(errors.cnapiErrorWrap(
                    execErr, 'problem executing command'));
            }

            return callback(null, res);
        });
    });
}


function copyContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.payload, 'opts.payload');
    assert.string(opts.id, 'opts.id');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var id = opts.id;
    var log = opts.log;
    var payload = opts.payload;
    var vmapi = getVmapiClient(this.config.vmapi);
    var cnapi = getCnapiClient(this.config.cnapi);

    var findOpts = {
        log: log,
        req_id: opts.req_id,
        account: opts.account,
        vmapi: vmapi
    };

    findUuidForId(id, findOpts, function (find_err, uuid) {
        if (find_err) {
            callback(find_err);
            return;
        }

        dockerCopy(uuid, {
            log: log,
            payload: payload,
            req_id: opts.req_id,
            account: opts.account,
            cnapi: cnapi,
            vmapi: vmapi
        }, function (copyErr, stream) {
            if (copyErr) {
                callback(copyErr);
                return;
            }

            callback(null, stream);
        });
    });
}


function dockerCopy(uuid, opts, callback) {
    assert.string(uuid, 'uuid');
    assert.object(opts, 'opts');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.vmapi, 'opts.vmapi');
    assert.object(opts.cnapi, 'opts.cnapi');

    var log = opts.log;
    var vmapi = opts.vmapi;
    var cnapi = opts.cnapi;

    vmapi.getVm(
        { uuid: uuid, owner_uuid: opts.account.uuid },
        { headers: {'x-request-id': opts.req_id} },
        getVmCb);

    function getVmCb(getErr, vm) {
        if (getErr) {
            log.error(getErr, 'Error getting container.');
            return callback(getErr);
        }

        cnapi.dockerCopy(vm.server_uuid, uuid, { payload: opts.payload },
            { headers: {'x-request-id': opts.req_id} },
            copyCb);

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
    getContainers: getContainers,
    inspectContainer: inspectContainer,
    killContainer: killContainer,
    psContainer: psContainer,
    resizeContainer: resizeContainer,
    restartContainer: restartContainer,
    startContainer: startContainer,
    stopContainer: stopContainer,
    waitContainer: waitContainer
};
