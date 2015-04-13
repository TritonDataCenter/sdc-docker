/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Integration tests for `docker info`
 */

var assert = require('assert-plus');
var cli = require('../lib/cli');
var common = require('../lib/common');
var extend = require('xtend');
var h = require('./helpers');
var vm = require('../lib/vm');
var test = require('tape');



// --- Globals


var EXPOSED_PORTS = {};
var CLIENTS = {};


// --- Helpers


/**
 * Transform a port into the NetworkSettings.Ports format
 */
function netSettingsPort(port) {
    return [ {
        HostIp: '0.0.0.0',
        HostPort: port.toString()
    } ];
}


/**
 * Transform a port into the HostConfig.PortBindings format
 */
function portBindingsPort(port) {
    return [ {
        HostIp: '',
        HostPort: port.toString()
    } ];
}


// --- Tests


test('setup', function (tt) {

    tt.test('DockerEnv: alice init', cli.init);


    tt.test('vmapi client', vm.init);


    tt.test('fwapi client', function (t) {
        h.createFwapiClient(function (err, client) {
            t.error(err, 'fwapi client err');
            CLIENTS.fwapi = client;
            t.end();
            return;
        });
    });


    tt.test('inspect: nginx image', function (t) {
        cli.inspect(t, {
            id: 'nginx:latest'
        }, function (err, img) {
            if (img) {
                EXPOSED_PORTS = img.Config.ExposedPorts;
            }

            t.end();
            return;
        });
    });

});


test('no port args', function (tt) {

    tt.test('docker run: no port args', function (t) {
        cli.run(t, { args: '-d nginx:latest' });
    });


    tt.test('firewall rules created', function (t) {
        var listOpts = {
            owner_uuid: cli.accountUuid,
            tag: 'sdc_docker'
        };

        CLIENTS.fwapi.listRules(listOpts, function (err, rules) {
            t.ifErr(err, 'list firewall rules');
            if (err) {
                t.end();
                return;
            }

            t.equal(rules.length, 2, '2 rules returned');
            t.deepEqual(rules.map(function (r) { return r.rule; }).sort(), [
                'FROM tag sdc_docker TO tag sdc_docker ALLOW tcp PORT all',
                'FROM tag sdc_docker TO tag sdc_docker ALLOW udp PORT all'
            ], 'ALLOW PORT all rules present');

            t.end();
            return;
        });
    });


    tt.test('no port args: VMAPI tags', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                tags: {
                    sdc_docker: true
                }
            }
        });
    });


    tt.test('no port args: inspect', function (t) {
        var partial = {
            Config: {
                ExposedPorts: EXPOSED_PORTS
            },
            HostConfig: {
                PortBindings: {},
                PublishAllPorts: false
            },
            NetworkSettings: {
                Ports: {
                    '80/tcp': null,
                    '443/tcp': null
                }
            }
        };

        cli.inspect(t, {
            id: cli.lastCreated,
            partialExp: partial
        });
    });

});


test('-P', function (tt) {

    tt.test('docker run -P', function (t) {
        cli.run(t, { args: '-P -d nginx:latest' });
    });


    tt.test('-P: inspect', function (t) {
        var partial = {
            Config: {
                ExposedPorts: EXPOSED_PORTS
            },
            HostConfig: {
                PortBindings: {},
                PublishAllPorts: true
            },
            NetworkSettings: {
                Ports: {
                    '80/tcp': netSettingsPort(80),
                    '443/tcp': netSettingsPort(443)
                }
            }
        };

        cli.inspect(t, {
            id: cli.lastCreated,
            partialExp: partial
        });
    });


    tt.test('-P: VMAPI metadata', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                internal_metadata: {
                    'docker:publish_all_ports': true,
                    'docker:tcp_published_ports': JSON.stringify([ 443, 80 ])
                },
                tags: {
                    sdc_docker: true
                }
            }
        });
    });

});


test('-p', function (tt) {

    tt.test('docker run -p 80:80', function (t) {
        cli.run(t, { args: '-p 80:80 -d nginx:latest' });
    });


    tt.test('-p 80:80: inspect', function (t) {
        var partial = {
            Config: {
                ExposedPorts: EXPOSED_PORTS
            },
            HostConfig: {
                PortBindings: {
                    '80/tcp': portBindingsPort(80)
                },
                PublishAllPorts: false
            },
            NetworkSettings: {
                Ports: {
                    '80/tcp': netSettingsPort(80),
                    '443/tcp': null
                }
            }
        };

        cli.inspect(t, {
            id: cli.lastCreated,
            partialExp: partial
        });
    });


    tt.test('-p 80:80: VMAPI metadata', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                internal_metadata: {
                    'docker:tcp_published_ports': JSON.stringify([ 80 ])
                },
                tags: {
                    sdc_docker: true
                }
            }
        });
    });


    tt.test('docker run -p 8080:80', function (t) {
        // We don't allow remapping of ports (for now, at least):
        cli.run(t, {
            args: '-p 8080:80 -d nginx:latest',
            expectedErr: 'Error response from daemon: publish port: '
                + 'remapping of port numbers not allowed'
        });
    });

});


test('-P and -p', function (tt) {

    tt.test('docker run -P -p 54:54/udp -p 90:90', function (t) {
        cli.run(t, { args: '-P -p 54:54/udp -p 90:90 -d nginx:latest' });
    });


    tt.test('-P: VMAPI metadata', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                internal_metadata: {
                    'docker:publish_all_ports': true,
                    'docker:tcp_bound_ports':
                        JSON.stringify([ 90 ]),
                    'docker:tcp_published_ports':
                        JSON.stringify([ 443, 80, 90 ]),
                    'docker:udp_bound_ports':
                        JSON.stringify([ 54 ]),
                    'docker:udp_published_ports':
                        JSON.stringify([ 54 ])
                },
                tags: {
                    sdc_docker: true
                }
            }
        });
    });


    tt.test('-P -p 54:54/udp -p 90:90: inspect', function (t) {
        var partial = {
            Config: {
                ExposedPorts: extend(EXPOSED_PORTS, {
                    '54/udp': {},
                    '90/tcp': {}
                })
            },
            HostConfig: {
                PortBindings: {
                    '54/udp': portBindingsPort(54),
                    '90/tcp': portBindingsPort(90)
                },
                PublishAllPorts: true
            },
            NetworkSettings: {
                Ports: {
                    '54/udp': netSettingsPort(54),
                    '80/tcp': netSettingsPort(80),
                    '90/tcp': netSettingsPort(90),
                    '443/tcp': netSettingsPort(443)
                }
            }
        };

        cli.inspect(t, {
            id: cli.lastCreated,
            partialExp: partial
        });
    });

});


test('teardown', cli.rmAllCreated);
