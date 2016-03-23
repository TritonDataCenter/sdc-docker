/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Test helpers for SDC Docker integration tests
 */

var assert = require('assert-plus');
var exec = require('child_process').exec;
var fmt = require('util').format;
var fs = require('fs');
var mod_log = require('../lib/log');
var os = require('os');
var path = require('path');
var sdcClients = require('sdc-clients');
var restify = require('restify');
var vasync = require('vasync');

var common = require('../lib/common');
var sdcCommon = require('../../lib/common');
var constants = require('../../lib/constants');


// --- globals

var CONFIG = {
    docker_url: process.env.DOCKER_URL,
    fwapi_url: process.env.FWAPI_URL,
    papi_url: process.env.PAPI_URL,
    sapi_url: process.env.SAPI_URL,
    vmapi_url: process.env.VMAPI_URL
};
var p = console.error;
var UA = 'sdcdockertest';

var CLIENT_ZONE_PAYLOAD = {
    'alias': 'sdcdockertest_client',
    'owner_uuid': '$admin',

    // (LX) ubuntu-14.04@20160201
    'image_uuid': '5917ca96-c888-11e5-8da0-e785a1ad1185',

    // $(sdc-napi /networks | json -H -c "this.name=='external'" 0.uuid)
    'networks': [],
    'tags': {
        'sdcdockertest': true
    },

    package_name: 'sample-1G',
    // billing_id: '(to be filled in)',
    // ... package vars

    customer_metadata: {
        /* BEGIN JSSTYLED */
        'user-script': [
            '#!/bin/bash',
            '',
            'DOCKER_AVAILABLE_CLI_VERSIONS="' + process.env.DOCKER_AVAILABLE_CLI_VERSIONS + '"',
            '',
            'if [[ ! -d /root/bin ]]; then',
            '    mkdir -p /root/bin',
            '    echo \'export PATH=/root/bin:$PATH\' >>/root/.profile',
            'fi',
            '',
            'cd /root/bin',
            '',
            'if [[ ! -x sdc-docker-setup.sh ]]; then',
            '    curl -sSO https://raw.githubusercontent.com/joyent/sdc-docker/master/tools/sdc-docker-setup.sh',
            '    chmod +x sdc-docker-setup.sh',
            'fi',
            '',
            'for docker_cli_version in ${DOCKER_AVAILABLE_CLI_VERSIONS}; do',
            '    if [[ ! -x docker-${docker_cli_version} ]]; then',
            '        curl -sSO https://get.docker.com/builds/Linux/x86_64/docker-${docker_cli_version}',
            '        chmod +x docker-${docker_cli_version}',
            '    fi',
            'done',
            '',
            'touch /var/svc/user-script-done  # see waitForClientZoneUserScript'
        ].join('\n')
        /* END JSSTYLED */
    },

    'brand': 'lx',
    'maintain_resolvers': true,
    'resolvers': [
        '8.8.8.8',
        '8.8.4.4'
    ]
};



// --- internal support routines


/**
 * Return an options object suitable for passing to a restify client
 */
function createClientOpts(name, callback) {
    assert.string(name, 'name');
    assert.func(callback, 'callback');

    var configVal = CONFIG[name + '_url'];
    var opts = {
        log: mod_log,
        agent: false
    };

    if (configVal) {
        opts.url = configVal;
        callback(null, opts);
        return;
    }

    loadConfig(function (err, config) {
        if (err) {
            return callback(err);
        }
        opts.url = fmt('https://%s.%s.%s:2376', name,
            config.datacenter_name,
            config.dns_domain);

        callback(null, opts);
        return;
    });
}

function getAccountKeys(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.state, 'opts.state');
    assert.string(opts.login, 'opts.login');
    assert.func(cb, 'cb');

    var cmd = '/opt/smartdc/bin/sdc sdc-useradm keys -j ' + opts.login;
    if (opts.state.runningFrom === 'remote') {
        cmd = 'ssh ' + opts.state.headnodeSsh + ' ' + cmd;
    }

    // Allow sometime for replication: poll for a while.
    common.execPlus({
        command: cmd,
        log: opts.state.log
    }, function (err, stdout, stderr) {
        if (err) {
            cb(err);
        } else {
            var keys = JSON.parse(stdout);
            cb(null, keys);
        }
    });
}

function getAccount(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.state, 'opts.state');
    assert.string(opts.login, 'opts.login');
    assert.optionalNumber(opts.retries, 'opts.retries');
    assert.func(cb, 'cb');

    var retries = (opts.retries === undefined ? 0 : opts.retries);

    var cmd = '/opt/smartdc/bin/sdc sdc-useradm get ' + opts.login;
    if (opts.state.runningFrom === 'remote') {
        cmd = 'ssh ' + opts.state.headnodeSsh + ' ' + cmd;
    }

    // Allow sometime for replication: poll for a while.
    var nAttempts = 0;
    var MAX_ATTEMPTS = retries + 1;
    function attempt() {
        nAttempts++;
        if (nAttempts > MAX_ATTEMPTS) {
            return cb(new Error(fmt(
                'could not get "%s" account%s',
                opts.login, (opts.retries === undefined
                    ? '' : ' after ' + opts.retries + ' retries'))));
        }
        common.execPlus({
            command: cmd,
            log: opts.state.log
        }, function (err, stdout, stderr) {
            if (err) {
                setTimeout(attempt, 1000);
            } else {
                var account = JSON.parse(stdout);
                getAccountKeys(opts, function (kErr, keys) {
                    account.keys = keys;
                    cb(kErr, account);
                });
            }
        });
    }

    setTimeout(attempt, 1000);
}

/**
 * Get a create an account of the given login.
 */
function getOrCreateAccount(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.state, 'opts.state');
    assert.string(opts.login, 'opts.login');
    assert.func(cb, 'cb');

    var log = opts.state.log;

    var account;

    vasync.pipeline({arg: opts.state, funcs: [
        function getAccount1(state, next) {
            getAccount({
                login: opts.login,
                state: opts.state
            }, function (err, account_) {
                if (!err) {
                    account = account_;
                }
                next();
            });
        },

        function createAccount(state, next) {
            if (account) {
                return next();
            }

            // Run sdc-useradm commands in the 'sdc' zone because, in general,
            // the sdc zone is more likely to have access to the UFDS master,
            // if this DC isn't the master.
            p('# Creating "%s" account', opts.login);
            var cmd = fmt('/opt/smartdc/bin/sdc sdc-useradm create -A '
                + 'login=%s email=root+%s@localhost userpassword=secret123',
                opts.login, opts.login);
            if (state.runningFrom === 'remote') {
                cmd = 'ssh ' + state.headnodeSsh + ' ' + cmd;
            }
            common.execPlus({
                command: cmd,
                log: log
            }, function (err, stdout, stderr) {
                log.debug({cmd: cmd, err: err, stdout: stdout,
                    stderr: stderr}, 'createAccount cmd done');
                next(err);
            });
        },

        function getAccount2(state, next) {
            if (account) {
                return next();
            }
            getAccount({
                login: opts.login,
                state: opts.state,
                retries: 15
            }, function (err, account_) {
                account = account_;
                next(err);
            });
        }

    ]}, function (err) {
        cb(err, account);
    });
}


/**
 * Load the SDC config.
 *
 * TODO: merge with `stepSdcConfig`
 */
function loadConfig(callback) {
    assert.func(callback, 'callback');

    var cmd = '/usr/bin/bash /lib/sdc/config.sh -json';
    exec(cmd, function (err, stdout, stderr) {
        if (err) {
            return callback(err);
        }
        try {
            callback(null, JSON.parse(stdout));
        } catch (parseErr) {
            callback(parseErr);
        }
    });
}


// --- vasync.pipeline "step" funcs (they expect and set vars on `state`)

function stepSysinfo(state, cb) {
    assert.object(state, 'state');
    assert.func(cb, 'cb');

    if (state.sysinfo) {
        return cb();
    }
    var cmd = '/usr/bin/sysinfo';
    exec(cmd, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }
        try {
            state.sysinfo = JSON.parse(stdout);
        } catch (parseErr) {
            return cb(parseErr);
        }
        cb();
    });
}

function stepSdcConfig(state, cb) {
    assert.object(state, 'state');
    assert.func(cb, 'cb');

    if (state.sdcConfig) {
        return cb();
    }
    var cmd = '/usr/bin/bash /lib/sdc/config.sh -json';
    exec(cmd, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }
        try {
            state.sdcConfig = JSON.parse(stdout);
        } catch (parseErr) {
            return cb(parseErr);
        }
        cb();
    });
}

function stepVmapi(state, cb) {
    assert.object(state, 'state');
    assert.func(cb, 'cb');

    if (state.vmapi) {
        return cb();
    }
    state.vmapi = new sdcClients.VMAPI({
        url: 'http://' + state.sdcConfig.vmapi_domain,
        agent: false,
        userAgent: UA,
        log: state.log
    });
    cb();
}

function stepImgapi(state, cb) {
    assert.object(state, 'state');
    assert.func(cb, 'cb');

    if (state.imgapi) {
        return cb();
    }
    state.imgapi = new sdcClients.IMGAPI({
        url: 'http://' + state.sdcConfig.imgapi_domain,
        agent: false,
        userAgent: UA,
        log: state.log
    });
    cb();
}

function stepNapi(state, cb) {
    assert.object(state, 'state');
    assert.func(cb, 'cb');

    if (state.napi) {
        return cb();
    }
    state.napi = new sdcClients.NAPI({
        url: 'http://' + state.sdcConfig.napi_domain,
        agent: false,
        userAgent: UA,
        log: state.log
    });
    cb();
}

function stepPapi(state, cb) {
    assert.object(state, 'state');
    assert.func(cb, 'cb');

    if (state.papi) {
        return cb();
    }
    state.papi = new sdcClients.PAPI({
        url: 'http://' + state.sdcConfig.papi_domain,
        agent: false,
        userAgent: UA,
        log: state.log
    });
    cb();
}

function stepCloudapiPublicIp(state, cb) {
    assert.object(state, 'state');
    assert.func(cb, 'cb');

    var cmd = 'vmadm lookup -1 -j alias=cloudapi0';
    if (state.runningFrom === 'remote') {
        cmd = 'ssh ' + state.headnodeSsh + ' ' + cmd;
    }
    common.execPlus({
        command: cmd,
        log: state.log
    }, function (err, stdout, stderr) {
        if (err) {
            return cb(err);
        }
        var vm = JSON.parse(stdout)[0];
        for (var i = 0; i < vm.nics.length; i++) {
            var nic = vm.nics[i];
            if (nic.nic_tag === 'external') {
                state.cloudapiPublicIp = nic.ip;
                cb();
            }
        }
    });
}

/*
 * Get (or create) and setup the test zone in which we can run the `docker`
 * client.
 *
 * This is an lx zone with the docker clients added.
 */
function stepClientZone(state_, cb) {
    assert.object(state_, 'state_');
    assert.func(cb, 'cb');

    if (state_.clientZone) {
        return cb();
    }

    vasync.pipeline({arg: state_, funcs: [
        stepVmapi,
        function getClientZone(state, next) {
            var filters = {
                state: 'active',
                owner_uuid: state.sdcConfig.ufds_admin_uuid,
                alias: CLIENT_ZONE_PAYLOAD.alias
            };
            state.vmapi.listVms(filters, function (err, vms) {
                if (err) {
                    return next(err);
                }
                if (vms.length) {
                    state.clientZone = vms[0];
                    //p('# Found existing client zone %s (%s)',
                    //    state.clientZone.uuid, state.clientZone.alias);
                }
                next();
            });
        },
        // Create the client zone if necessary.
        _stepCreateClientZone
    ]}, cb);
}

function _stepCreateClientZone(state_, cb) {
    assert.object(state_, 'state_');
    assert.func(cb, 'cb');

    if (state_.clientZone) {
        return cb();
    }

    var payload = common.objCopy(CLIENT_ZONE_PAYLOAD);

    vasync.pipeline({arg: state_, funcs: [
        stepNapi,
        function payloadNetworks(state, next) {
            state.napi.listNetworks({name: 'external'}, function (err, nets) {
                if (err) {
                    return next(err);
                }
                payload.networks.push({uuid: nets[0].uuid});
                next();
            });
        },

        stepImgapi,
        function importImageIfNecessary(state, next) {
            state.imgapi.getImage(payload.image_uuid, function (err, img) {
                if (err && err.statusCode !== 404) {
                    return next(err);
                } else if (!err) {
                    return next();
                }
                // Need to import this image into the DC.
                p('# Importing image %s from images.joyent.com',
                    payload.image_uuid);
                state.imgapi.adminImportRemoteImageAndWait(
                    payload.image_uuid, 'https://images.joyent.com',
                    next);
            });
        },

        stepPapi,
        function getPkg(state, next) {
            var filter = {active: true};
            state.papi.list(filter, {}, function (err, pkgs) {
                var pkg;

                if (err) {
                    return next(err);
                }

                // Pick the first non-private package between 1-2G memory
                for (var i = 0; i < pkgs.length; i++) {
                    pkg = pkgs[i];

                    if (!pkg.owner_uuids || pkg.owner_uuids.length === 0) {
                        // package is not private to owner(s)
                        if (pkg.max_physical_memory >= 1024
                            && pkg.max_physical_memory <= 2048) {
                            // found a package that meets our criteria!
                            p('# Using package %s', pkg.name);
                            payload.billing_id = pkg.uuid;
                            break;
                        }
                    }
                }

                assert.uuid(payload.billing_id, 'payload.billing_id');
                next();
            });
        },

        // Create the client zone on the local CN (typically the headnode)
        // because we are getting failures, at least in nightly, when one
        // of the CNs is used.
        stepSysinfo,
        function payloadServerUuid(state, next) {
            payload.server_uuid = state.sysinfo.UUID;
            next();
        },

        function createClientZone(state, next) {
            p('# Creating client zone (%s)', payload.alias);
            payload.owner_uuid = state.sdcConfig.ufds_admin_uuid;
            state.log.debug({payload: payload}, 'create clientZone');
            state.vmapi.createVmAndWait(payload, function (err, job) {
                if (err) {
                    return next(err);
                }
                p('# Created client zone %s (%s)', job.vm_uuid, payload.alias);
                state.vmapi.getVm({uuid: job.vm_uuid}, function (gErr, vm) {
                    state.clientZone = vm;
                    next(gErr);
                });
            });
        },

        function waitForClientZoneUserScript(state, next) {
            p('# Wait until client zone user-script is done.');

            var marker = fmt('/zones/%s/root/var/svc/user-script-done',
                state.clientZone.uuid);
            var nAttempts = 0;
            var MAX_ATTEMPTS = 600;

            function attempt() {
                nAttempts++;
                if (nAttempts > MAX_ATTEMPTS) {
                    return next(new Error('timeout waiting for clientZone '
                        + 'user-script to finish'));
                }
                if (nAttempts % 10 === 0) {
                    p('# Still waiting (%d/%ds)', nAttempts, MAX_ATTEMPTS);
                }
                fs.exists(marker, function (exists) {
                    if (!exists) {
                        setTimeout(attempt, 1000);
                    } else {
                        next();
                    }
                });
            }

            setTimeout(attempt, 1000);
        }

    ]}, cb);
}



/*
 * --- GzDockerEnv
 *
 * A wrapper object for running docker client stuff as a particular account.
 */
function GzDockerEnv(t, state, opts) {
    assert.object(t, 't');
    assert.object(state, 'state');
    assert.object(opts, 'opts');
    assert.string(opts.account, 'opts.account');
    assert.equal(opts.account.split('_')[0], 'sdcdockertest',
        'All test suite accounts should be prefixed with "sdcdockertest_"');

    this.login = opts.account;
    this.log = state.log;
}

GzDockerEnv.prototype.init = function denvInit(t, state_, cb) {
    assert.object(t, 't');
    assert.object(state_, 'state_');
    assert.func(cb, 'cb');

    var self = this;
    self.state = state_;

    var newKey = false;

    vasync.pipeline({arg: state_, funcs: [
        stepSysinfo,
        stepSdcConfig,
        stepClientZone,

        function ensureAccount(state, next) {
            getOrCreateAccount({login: self.login, state: state},
                    function (err, account) {
                self.account = account;
                next(err);
            });
        },

        function setPaths(state, next) {
            self.clientZone = state.clientZone;

            self.privKeyPath = fmt('/zones/%s/root/root/.ssh/%s.id_rsa',
                state.clientZone.uuid, self.login);
            self.pubKeyPath = self.privKeyPath + '.pub';
            self.sdcDockerDir = fmt('/zones/%s/root/root/.sdc/docker/%s',
                state.clientZone.uuid, self.login);
            next();
        },

        function ensureAccountKey(state, next) {
            var keyName = 'host-' + os.hostname();
            var accountHasKey = (
                self.account.keys
                && self.account.keys.filter(
                    function (k) { return k.name === keyName; }).length);
            if (fs.existsSync(self.pubKeyPath)
                && fs.existsSync(self.privKeyPath)
                && fs.existsSync(self.sdcDockerDir)
                && accountHasKey)
            {
                return next();
            }

            newKey = true;
            p('# Creating "%s" SSH key for "%s" account', keyName, self.login);
            var cmds = [
                fmt('rm -rf %s %s', self.privKeyPath, self.pubKeyPath),
                fmt('ssh-keygen -t rsa -f %s -b 2048 -N ""', self.privKeyPath),
                fmt('cp %s '
                    + '/zones/$(vmadm lookup -1 alias=sdc0)/root/var/tmp/',
                    self.pubKeyPath)
            ];
            if (accountHasKey) {
                cmds.push(fmt(
                    '/opt/smartdc/bin/sdc sdc-useradm delete-key %s %s',
                    self.login, keyName));
            }
            cmds.push(fmt('/opt/smartdc/bin/sdc sdc-useradm add-key '
                + '-n %s %s /var/tmp/%s.id_rsa.pub',
                keyName, self.login, self.login));
            vasync.forEachPipeline({
                inputs: cmds,
                func: function execOneCmd(cmd, nextCmd) {
                    exec(cmd, function (err, stdout, stderr) {
                        state.log.debug({cmd: cmd, err: err, stdout: stdout,
                            stderr: stderr}, self.login + 'ensureKey cmd');
                        nextCmd(err);
                    });
                }
            }, next);
        },

        function getCloudapiPublicIp(state, next) {
            if (!newKey) {
                return next();
            }
            stepCloudapiPublicIp(state, next);
        },

        function sdcDockerSetup(state, next) {
            if (!newKey) {
                return next();
            }

            p('# Running "sdc-docker-setup.sh" for "%s" account', self.login);
            self.execInTestZone(
                fmt(
                    '/root/bin/sdc-docker-setup.sh -k %s %s '
                        + '/root/.ssh/%s.id_rsa',
                    state.cloudapiPublicIp,
                    self.login,
                    self.login
                ), next);
        }

    ]}, cb);
};

/*
 * Run 'docker $cmd' as this user.
 *
 * @param cmd {String} The command (after the 'docker ') to run. E.g. 'info'.
 * @param opts {Object} Optional. Nothing yet.
 * @param cb {Function} `function (err, stdout, stderr)`
 */
GzDockerEnv.prototype.docker = function denvDocker(cmd, opts, cb) {
    assert.string(cmd, 'cmd');
    assert.ok(process.env.DOCKER_CLI_VERSION,
        '$DOCKER_CLI_VERSION is not set, do not know which "docker-$ver" '
        + 'to execute');
    // other options asserted by this.exec()

    var dockerCmd = fmt(
        '(source /root/.sdc/docker/%s/env.sh; /root/bin/docker-%s --tls %s)',
        this.login, process.env.DOCKER_CLI_VERSION, cmd);
    this.execInTestZone(dockerCmd, opts, cb);
};

/*
 * Run '$cmd' in the test zone.
 *
 * @param cmd {String} The command to run.
 * @param opts {Object} Optional. Nothing yet.
 * @param cb {Function} `function (err, stdout, stderr)`
 */
GzDockerEnv.prototype.execInTestZone = function denvExec(cmd, opts, cb) {
    assert.string(cmd, 'cmd');
    if (cb === undefined) {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');
    assert.optionalObject(opts.execOpts, 'opts.execOpts');

    common.execPlus({
        // TODO: escaping single-quotes
        command: fmt('zlogin %s \'%s\'', this.clientZone.uuid, cmd),
        log: this.log,
        execOpts: opts.execOpts
    }, cb);
};


/*
 * --- LocalDockerEnv
 *
 * A wrapper object for running docker client stuff as a particular account.
 * This differs from `GzDockerEnv` in that we are running with (a) a local
 * `docker` client and (b) NOT in the headnode GZ.
 *
 * TODO: For now we'll assume running from a Mac against COAL, but that
 * should be set in a test config file.
 */
function LocalDockerEnv(t, state, opts) {
    assert.object(t, 't');
    assert.object(state, 'state');
    assert.object(opts, 'opts');
    assert.string(opts.account, 'opts.account');
    assert.equal(opts.account.split('_')[0], 'sdcdockertest',
        'All test suite accounts should be prefixed with "sdcdockertest_"');

    this.login = opts.account;
    this.log = state.log;
}

LocalDockerEnv.prototype.init = function ldenvInit(t, state_, cb) {
    assert.object(t, 't');
    assert.object(state_, 'state_');
    assert.func(cb, 'cb');

    var self = this;
    self.state = state_;

    var newKey = false;

    vasync.pipeline({arg: state_, funcs: [
        function ensureAccount(state, next) {
            getOrCreateAccount({login: self.login, state: state},
                    function (err, account) {
                self.account = account;
                next(err);
            });
        },

        function setVars(state, next) {
            self.privKeyPath = fmt('%s/.ssh/%s.id_rsa',
                process.env.HOME, self.login);
            self.pubKeyPath = self.privKeyPath + '.pub';
            self.sdcDockerDir = fmt('%s/.sdc/docker/%s',
                process.env.HOME, self.login);
            next();
        },

        function getSdcZonename(state, next) {
            common.execPlus({
                command: fmt('ssh %s vmadm lookup -1 alias=sdc0',
                    state.headnodeSsh),
                log: state.log
            }, function (err, stdout, stderr) {
                if (err) {
                    return next(err);
                }
                state.sdcZonename = stdout.trim();
                next();
            });
        },

        function ensureAccountKey(state, next) {
            var keyName = 'host-' + os.hostname();
            var accountHasKey = (
                self.account.keys
                && self.account.keys.filter(
                    function (k) { return k.name === keyName; }).length);
            if (fs.existsSync(self.pubKeyPath)
                && fs.existsSync(self.privKeyPath)
                && fs.existsSync(self.sdcDockerDir)
                && accountHasKey)
            {
                return next();
            }

            newKey = true;
            p('# Creating "%s" SSH key for "%s" account', keyName, self.login);
            var cmds = [
                fmt('rm -rf %s %s', self.privKeyPath, self.pubKeyPath),
                fmt('ssh-keygen -t rsa -f %s -b 2048 -N ""', self.privKeyPath),
                fmt('scp %s %s:/zones/%s/root/var/tmp/',
                    self.pubKeyPath, state.headnodeSsh, state.sdcZonename)
            ];
            if (accountHasKey) {
                cmds.push(fmt('ssh %s /opt/smartdc/bin/sdc sdc-useradm '
                    + 'delete-key %s %s', state.headnodeSsh, self.login,
                    keyName));
            }
            cmds.push(fmt(
                'ssh %s /opt/smartdc/bin/sdc sdc-useradm add-key -n %s '
                + '%s /var/tmp/%s.id_rsa.pub', state.headnodeSsh, keyName,
                self.login, self.login));
            vasync.forEachPipeline({
                inputs: cmds,
                func: function execOneCmd(cmd, nextCmd) {
                    common.execPlus({
                        command: cmd,
                        log: state.log
                    }, nextCmd);
                }
            }, next);
        },

        function getCloudapiPublicIp(state, next) {
            if (!newKey) {
                return next();
            }
            stepCloudapiPublicIp(state, next);
        },

        function sdcDockerSetup(state, next) {
            if (!newKey) {
                return next();
            }

            p('# Running "sdc-docker-setup.sh" for "%s" account', self.login);
            var cmd = fmt(
                '%s -sk %s %s %s',
                path.resolve(__dirname, '../../tools/sdc-docker-setup.sh'),
                state.cloudapiPublicIp,
                self.login,
                self.privKeyPath);
            common.execPlus({
                command: cmd,
                log: state.log
            }, next);
        }

    ]}, cb);
};

/*
 * Run 'docker $cmd' as this user.
 *
 * @param cmd {String} The command (after the 'docker ') to run. E.g. 'info'.
 * @param opts {Object} Optional. Nothing yet.
 * @param cb {Function} `function (err, stdout, stderr)`
 */
LocalDockerEnv.prototype.docker = function ldenvDocker(cmd, opts, cb) {
    assert.string(cmd, 'cmd');
    // other args are asserted by this.exec()

    var dockerCmd = fmt(
        '(source ~/.sdc/docker/%s/env.sh; docker --tls %s)',
        this.login, cmd);
    this.execInTestZone(dockerCmd, opts, cb);
};

/*
 * Run '$cmd' in the test zone.
 *
 * @param cmd {String} The command to run.
 * @param opts {Object} Optional. Nothing yet.
 * @param cb {Function} `function (err, stdout, stderr)`
 */
LocalDockerEnv.prototype.execInTestZone = function ldenvExec(cmd, opts, cb) {
    assert.string(cmd, 'cmd');
    if (cb === undefined) {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    common.execPlus({
        command: cmd,
        log: this.log
    }, cb);
};



/*
 * --- Test helper functions
 *
 * All these helper functions follow a pattern:
 *
 *      function (t, state, opts, cb)
 *
 * where:
 *      't' is the test object
 *      'state' is a state object for that test file. Test functions use this
 *          to cache state on well-known keys. This can help speed up tests
 *          so that general info doesn't need to be queried or setup for
 *          each test case. Using well-known keys can also reduce boilerplate
 *          in calling functions.
 *      'opts' any options specific to this helper function.
 *      'cb' the standard `function (err, ...)` callback. If helper is async.
 *
 * TODO: Should we do the napi tests' `t.end()` thing if no callback?
 * TODO: bother with this? CR from Rob would be nice.
 */

/*
 * Get `*DockerEnv` wrappers for several test accounts, setting them up in the
 * DC if necessary. Callback returns (err, accounts), where accounts is a hash
 * of account objects.
 */
function initDockerEnv(t, state, opts, cb) {
    assert.object(t, 't');
    assert.object(state, 'state');
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    // if account does not have approved_for_provisioning set to val, set it
    function setProvisioning(env, val, next) {
        assert.object(env, 'env');
        assert.bool(val, 'val');
        assert.func(next, 'next');

        if (env.account.approved_for_provisioning === '' + val) {
            next(null);
            return;
        }

        var s = '/opt/smartdc/bin/sdc sdc-useradm replace-attr %s \
            approved_for_provisioning %s';
        var cmd = fmt(s, env.login, val);

        if (env.state.runningFrom === 'remote') {
            cmd = 'ssh ' + env.state.headnodeSsh + ' ' + cmd;
        }

        exec(cmd, next);
    }

    getDockerEnv(t, state, {account: 'sdcdockertest_alice'},
            function (err, alice) {
        t.ifErr(err, 'docker env: alice');
        t.ok(alice, 'have a DockerEnv for alice');

        // We create Bob here, who is permanently set as unprovisionable
        // below. Docker's ufds client caches account values, so mutating
        // Alice isn't in the cards (nor is Bob -- which is why we don't
        // set Bob provisionable when this test file completes).
        getDockerEnv(t, state, {account: 'sdcdockertest_bob'},
                function (err2, bob) {
            t.ifErr(err2, 'docker env: bob');
            t.ok(bob, 'have a DockerEnv for bob');

            setProvisioning(bob, false, function (err3) {
                t.ifErr(err3, 'set bob unprovisionable');

                var accounts = {
                    alice: alice,
                    bob: bob
                };

                cb(null, accounts);
                return;
            });
        });
    });
}

/*
 * Get a `*DockerEnv` wrapper for a given account, setting it up in the DC
 * if necessary.
 *
 * @params opts
 *      - account {String} Account name to setup.
 */
function getDockerEnv(t, state_, opts, cb) {
    assert.object(t, 't');
    assert.object(state_, 'state_');
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    var env;

    vasync.pipeline({arg: state_, funcs: [
        /*
         * Set `state.runningFrom` to 'gz' (from the headnode global zone)
         * or 'remote'.
         */
        function runningFromWhere(state, next) {
            if (os.type() !== 'SunOS') {
                state.runningFrom = 'remote';
                return next();
            }

            common.execPlus({
                command: '/usr/bin/zonename',
                log: state.log
            }, function (err, stdout, stderr) {
                if (err) {
                    return next(err);
                }
                var zonename = stdout.replace(/\s+$/g, '');
                if (zonename !== 'global') {
                    state.runningFrom = 'remote';
                } else {
                    state.runningFrom = 'gz';
                }
                next();
            });
        },

        function getHeadnodeSsh(state, next) {
            if (state.runningFrom !== 'remote') {
                return next();
            }

            // For now assume coal.
            state.headnodeSsh = 'root@10.99.99.7';
            next();
        },


        function getEnv(state, next) {
            var envClass = {
                remote: LocalDockerEnv,
                gz: GzDockerEnv
            }[state.runningFrom];
            env = new envClass(t, state, opts);
            env.init(t, state, next);
        }

    ]}, function (err) {
        if (err) {
            cb(err);
        } else {
            cb(null, env);
        }
    });

}



// --- other exports


/**
 * Get a simple restify JSON client to the SDC Docker Remote API.
 *
 * @param options {Object} An object with several properties:
 *   - user {Object} A user object as returned from initDockerEnv's callback.
 *   - clientType {String} Optional. A value that represents the type of
 *     restify client to create. Values can be either 'http', 'json' or
 *     'string'.
 *     Refer to restify's documentation for more details about the differences
 *     between them. If no clientType is passed, a JSON resitfy client is
 *     created.
 *
 * @param callback {Function} A function that will be called when the docker
 *  remote client is ready. Its first argument is an error object if an error
 *  occured, and otherwise its second argument is an instance of a restify
 *  client. The type of restify client returned as the second argument of
 *  this callback depends on the options.clientType parameter that was passed.
 *  By default, it is a restify JSON client.
 */
function createDockerRemoteClient(options, callback) {
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var clientType = options.clientType;
    assert.ok(clientType === undefined || typeof (clientType) === 'string');

    var user = options.user;
    assert.object(user, 'user');

    var clientFactories = {
        'http': restify.createHttpClient,
        'json': restify.createJsonClient,
        'string': restify.createStringClient
    };

    createClientOpts('docker', function (err, opts) {
        if (err) {
            return callback(err);
        }

        // Now that TLS is the default, load the user's certificate and key:
        opts.cert = fs.readFileSync(user.sdcDockerDir + '/cert.pem').toString();
        opts.key = fs.readFileSync(user.sdcDockerDir + '/key.pem').toString();
        // Necessary for self-signed server certs:
        opts.rejectUnauthorized = false;

        var clientFactory = restify.createJsonClient;
        if (clientType)
            clientFactory = clientFactories[clientType];

        callback(null, clientFactory.call(clientFactory, opts));
        return;
    });
}


/**
 * Get a simple restify JSON client to FWAPI.
 */
function createFwapiClient(callback) {
    assert.func(callback, 'callback');

    createClientOpts('fwapi', function (err, opts) {
        if (err) {
            return callback(err);
        }

        callback(null, new sdcClients.FWAPI(opts));
        return;
    });
}

/**
 * Get a simple restify JSON client to SAPI.
 */
function createSapiClient(callback) {
    assert.func(callback, 'callback');

    createClientOpts('sapi', function (err, opts) {
        if (err) {
            return callback(err);
        }

        callback(null, new sdcClients.SAPI(opts));
        return;
    });
}



/**
 * Get a simple restify JSON client to PAPI.
 */
function createPapiClient(callback) {
    assert.func(callback, 'callback');

    createClientOpts('papi', function (err, opts) {
        if (err) {
            return callback(err);
        }

        callback(null, new sdcClients.PAPI(opts));
        return;
    });
}


/**
 * Get a simple restify JSON client to VMAPI.
 */
function createVmapiClient(callback) {
    assert.func(callback, 'callback');

    createClientOpts('vmapi', function (err, opts) {
        if (err) {
            return callback(err);
        }

        callback(null, new sdcClients.VMAPI(opts));
        return;
    });
}



/**
 * Test the given Docker 'info' API response.
 */
function assertInfo(t, info) {
    assert.object(t, 't');

    t.equal(typeof (info), 'object', 'info is an object');
    t.equal(info.Driver, 'sdc', 'Driver is "sdc"');
//     t.equal(info.NGoroutines, 42, 'Totally have 42 goroutines');
}


/*
 * Builds a docker container using the context passed in opts.tarball.
 *
 * @param opts.tarball {String|Stream} The docker build context.
 * @param opts.params {Object} Docker build query parameters.
 */
function buildDockerContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.dockerClient, 'opts.dockerClient');
    assert.func(callback, 'callback');
    assert.optionalObject(opts.params, 'opts.params');

    var tarStream = opts.tarball;
    if (typeof (opts.tarball) !== 'object') {
        assert.string(opts.tarball, 'opts.tarball must be a string or stream');
        tarStream = fs.createReadStream(opts.tarball);
    }

    var dockerClient = opts.dockerClient;
    var log = dockerClient.log;
    var queryParams = '';
    if (opts.params) {
        queryParams = '?' + Object.keys(opts.params).map(function (q) {
            return fmt('%s=%s', escape(q), escape(opts.params[q]));
        }).join('&');
    }

    var headers = {
        'Content-Type': 'application/tar',
        'Accept-Encoding': 'gzip',
        'Transfer-Encoding': 'chunked'
    };

    if (opts.extraHeaders) {
        for (var header in opts.extraHeaders) {
            if (header in headers) {
                var errorMsg = 'Extra header [%s] already set, you should '
                + 'not override it';
                errorMsg = fmt(errorMsg, header);
                throw new Error(errorMsg);
            }

            headers[header] = opts.extraHeaders[header];
        }
    }

    dockerClient.post({
        path: '/build' + queryParams,
        headers: headers
    }, onpost);

    function onpost(connectErr, req) {
        var buildResult = {};

        if (connectErr) {
            log.error({err: connectErr}, 'error connecting for POST /build');
            return callback(connectErr, buildResult);
        }

        req.on('result', function onResponse(err, res) {
            buildResult.body = '';

            res.on('data', function onResData(data) {
                buildResult.body += data.toString();
            });

            res.on('end', function onEnd() {
                removeDockerTarStreamListeners();
                if (err) {
                    log.error({err: err}, 'error at end of result');
                }
                return callback(err, buildResult);
            });
        });

        req.on('error', function onReqError(err) {
            log.error({err: err}, 'Error when sending build context');
            removeDockerTarStreamListeners();
            return callback(err);
        });

        tarStream.pipe(req);

        tarStream.on('error', function onDockerTarError(err) {
            log.error({err: err}, 'Error when reading build context');
            req.end();
        });

        tarStream.on('end', function onDockerTarEnd() {
            req.end();
        });

        function removeDockerTarStreamListeners() {
            tarStream.removeAllListeners();
        }
    }
}

/**
 * Create a nginx VM fixture
 */
function createDockerContainer(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var payload = {
        'Hostname': '',
        'Domainname': '',
        'User': '',
        'Memory': 0,
        'MemorySwap': 0,
        'CpuShares': 0,
        'Cpuset': '',
        'AttachStdin': false,
        'AttachStdout': false,
        'AttachStderr': false,
        'PortSpecs': null,
        'ExposedPorts': {},
        'Tty': false,
        'OpenStdin': false,
        'StdinOnce': false,
        'Env': [],
        'Cmd': null,
        'Image': 'nginx',
        'Volumes': {},
        'WorkingDir': '',
        'Entrypoint': null,
        'NetworkDisabled': false,
        'OnBuild': null,
        'SecurityOpt': null,
        'HostConfig': {
            'Binds': null,
            'ContainerIDFile': '',
            'LxcConf': [],
            'Privileged': false,
            'PortBindings': {},
            'Links': null,
            'PublishAllPorts': false,
            'Dns': null,
            'DnsSearch': null,
            'ExtraHosts': null,
            'VolumesFrom': null,
            'Devices': [],
            'NetworkMode': 'bridge',
            'CapAdd': null,
            'CapDrop': null,
            'RestartPolicy': {
                'Name': '',
                'MaximumRetryCount': 0
            }
        }
    };

    var dockerClient = opts.dockerClient;
    var vmapiClient = opts.vmapiClient;
    var t = opts.test;
    var log = dockerClient.log;
    var response = {};
    var apiVersion = opts.apiVersion || ('v' + constants.API_VERSION);

    if (opts.extra) {
        for (var e in opts.extra) {

            // Allow overriding sub-properties with a dot notation,
            // eg: RestartPolicy.Name
            var split = e.split('.');
            if (split.length > 1) {
                payload[split[0]][split[1]] = opts.extra[e];

            } else {
                payload[e] = opts.extra[e];
            }
        }
    }

    vasync.waterfall([
        function (next) {
            // There is a dependency here, in order to create a nginx container,
            // the nginx image must first be downloaded.
            log.debug('Checking for nginx docker image');
            dockerClient.get('/images/json',
                    function (err, req, res, images) {

                t.error(err, 'check for nginx image - should be no error');

                if (images.filter(function (image) {
                    return -1 !== image.RepoTags.indexOf('nginx:latest');
                }).length === 0) {
                    // Urgh, it doesn't exist... go get it then.
                    log.debug('Fetching nginx image');
                    var url = '/images/create?fromImage=nginx%3Alatest';

                    dockerClient.post(url, function (err2, req2, res2) {
                        t.error(err2, 'pull nginx image - should be no error');
                        next(null);
                    });

                } else {
                    next(null);
                }
            });
        },

        function (next) {
            // Post create request
            dockerClient.post(
                '/' + apiVersion + '/containers/create', payload, onpost);
            function onpost(err, res, req, body) {
                if (opts.expectedErr) {
                    common.expErr(t, err, opts.expectedErr, callback);
                    return;
                }

                t.deepEqual(
                    body.Warnings, [], 'Warnings should be present and empty');
                t.ok(body.Id, 'Id should be present');
                response.id = body.Id;
                next(err);
            }
        },
        function (next) {
            // Attempt to get new container
            dockerClient.get(
                '/containers/' + response.id + '/json', onget);
            function onget(err, res, req, body) {
                t.error(err);
                response.inspect = body;
                response.uuid = sdcCommon.dockerIdToUuid(response.id);
                next(err);
            }
        },
        function (next) {
            // Attempt to stop the container
            dockerClient.get(
                '/containers/' + response.id + '/json', onget);
            function onget(err, res, req, body) {
                t.error(err);
                response.inspect = body;
                response.uuid = sdcCommon.dockerIdToUuid(response.id);
                next(err);
            }
        },
        function (next) {
            vmapiClient.getVm({ uuid: response.uuid }, function (err, vm) {
                t.error(err);
                response.vm = vm;
                next(err);
            });
        }
    ], function (err) {
        if (!opts.expectedError) {
            t.error(err);
        }

        callback(err, response);
    });
}


function listContainers(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var dockerClient = opts.dockerClient;
    var t = opts.test;
    var containers;

    vasync.waterfall([
        function (next) {
            // Post create request
            dockerClient.get(
                '/containers/json'
                + (opts.all ? '?all=1' : ''), onget);
            function onget(err, res, req, body) {
                if (t) {
                    t.error(err);
                }

                containers = body;
                next(err);
            }
        }
    ],
    function (err) {
        if (t) {
            t.error(err);
        }

        callback(err, containers);
    });
}


/*
 * Takes a docker zone ID as first argument, and calls "callback"
 * with an error object as first argument, and the path to the SDC-docker
 * log file (usable from the GZ) as second argument.
 */
function getServiceLogFilePath(dockerZoneId, callback) {
    assert.string(dockerZoneId, 'dockerZoneId');
    assert.func(callback, 'callback');

    var cmdLine = 'zlogin ' + dockerZoneId + ' svcs -L docker';
    exec(cmdLine, onExec);
    function onExec(err, stdout, stderr) {
        var zonePath = path.join('/zones', dockerZoneId);
        return callback(err, path.join(zonePath, 'root', stdout.trim()));
    }
}

/*
 * Calls callback with an error object as first argument,
 * and the ID of the docker zone as second argument.
 */
function getDockerZoneId(callback) {
    assert.func(callback, 'callback');

    var cmdLine = 'vmadm lookup -1 alias=docker0';
    exec(cmdLine, onExec);
    function onExec(err, stdout, stderr) {
        if (err === null && stdout) {
            stdout = stdout.trim();
            var outputLines = stdout.split(os.EOL);
            if (outputLines.length !== 1)
                err = new Error('vmadm output must be in 1 line, '
                    + 'actual output: ' + stdout);
        }

        return callback(err, stdout);
    }
}

/*
 * Given a log file path, a request ID and a restify handler name,
 * calls back "callback" with an error object and a boolean set to true
 * if the restify handler "handlerName" ran when the latest request with
 * ID reqId was served, and false otherwise.
 */
function findHandlerTimerInLogs(logFilePath, reqId, handlerName, callback) {
    assert.string(logFilePath, 'logFilePath');
    assert.string(reqId, 'reqId');
    assert.string(handlerName, 'handlerName');
    assert.func(callback, 'callback');

    var handlerTimerFound = false;

    var cmdLine = 'cat ' + logFilePath
    // filter non-JSON data
    + ' | grep -v \'^[^{]\''
    // filter records for the request ID passed as input
    // and output with one line per record
    + ' | json -ga -o jsony-0 -c this.req_id==' + reqId
    // grab the latest request
    + ' | tail -1'
    // filter handlers timers info
    + ' | json -o jsony-0 req.timers'
    // Filter requests that made the body parser handler run
    + ' | grep ' + handlerName;

    exec(cmdLine, onExecDone);
    function onExecDone(err, stdout, stderr) {
        // if grep exits with no error, it means it found
        // a match, and so the handler with name "handlerName" ran
        if (err === null || err.code === 0)
            handlerTimerFound = true;

        // If there's an error when running grep, there are two different
        // cases:
        //
        // 1. if it exits with a status code that is not 1,
        // it's an actual error.
        //
        // 2. if it exits with a status code of 1, it means no match was
        // found, but it's not an error per se.
        if (err && err.code === 1)
            err = null;

        return callback(err, handlerTimerFound);
    }
}

/*
 * Checks in sdc-docker logs if the restify handler with name "handlerName"
 * was executed for the latest request with ID "reqId". Calls back callback
 * with an error object as first argument, and a boolean that is true if the
 * handler ran, and false otherwise.
 */
function didRestifyHandlerRun(reqId, handlerName, callback) {
    assert.string(reqId, 'reqId');
    assert.string(handlerName, 'handlerName');

    // check in the docker service's logs if the last
    // log entry with the same request ID
    // doesn't have a req.timers entry for handlerName, which would
    // mean the handler was executed.
    vasync.waterfall([
        getDockerZoneId,
        getServiceLogFilePath,
        function (logFilePath, next) {
            findHandlerTimerInLogs(logFilePath, reqId, handlerName, next);
        }
    ], function allDone(err, handlerTimerFound) {
        return callback(err, handlerTimerFound);
    });
}

// --- exports

module.exports = {
    createDockerRemoteClient: createDockerRemoteClient,
    createSapiClient: createSapiClient,
    createFwapiClient: createFwapiClient,
    createPapiClient: createPapiClient,
    createVmapiClient: createVmapiClient,
    dockerIdToUuid: sdcCommon.dockerIdToUuid,
    initDockerEnv: initDockerEnv,
    listContainers: listContainers,
    createDockerContainer: createDockerContainer,
    buildDockerContainer: buildDockerContainer,

    getDockerEnv: getDockerEnv,

    didRestifyHandlerRun: didRestifyHandlerRun,

    ifErr: common.ifErr,
    assertInfo: assertInfo
};
