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
var constants = common.constants;
var extend = require('xtend');
var fmt = require('util').format;
var h = require('./helpers');
var vm = require('../lib/vm');
var test = require('tape');



// --- Globals
var MAX_PORTS_PER_RULE = 8;
var FWRULE_VERSION = 1;

var EXPOSED_PORTS = {};
var CLIENTS = {};


// --- Helpers


/**
 * Return a rule for exposing ports
 */
function exposeRule(proto, vmID, ports) {
    var ruleVM = vmID;
    if (ruleVM.length > 36) {
        ruleVM = h.dockerIdToUuid(vmID);
    }

    return fmt('FROM any TO vm %s ALLOW %s %sPORT %s%s',
        ruleVM, proto,
        (ports.length === 1 ? '' : '('),
        ports.join(' AND PORT '),
        (ports.length === 1 ? '' : ')'));
}

function exposeRange(proto, vmID, start, end) {
    var ruleVM = vmID;
    if (ruleVM.length > 36) {
        ruleVM = h.dockerIdToUuid(vmID);
    }

    return fmt('FROM any TO vm %s ALLOW %s PORTS %s - %s',
        ruleVM, proto, start, end);
}


/**
 * List firewall rules and compare to opts.expected
 */
function listFwRules(t, opts) {
    CLIENTS.fwapi.listRules(opts.filter, function (err, rules) {
        t.ifErr(err, 'list firewall rules');
        if (err) {
            t.end();
            return;
        }

        var expLength = opts.expected.length;
        t.equal(rules.length, expLength, expLength + ' rules returned');
        t.deepEqual(rules.map(function (r) { return r.rule; }).sort(),
            opts.expected, 'expected rules present');

        t.end();
        return;
    });
}


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


/**
 * Return an all-zeros IP + port
 */
function zeroAddr(port) {
    return '0.0.0.0:' + port.toString();
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

    tt.test('sapi client', function (t) {
        h.createSapiClient(function (err, client) {
            t.error(err, 'Error creating SAPI client');
            CLIENTS.sapi = client;
            t.end();
            return;
        });
    });

    tt.test('FWRULE_VERSION', function (t) {
        CLIENTS.sapi.getConfig(process.env.DOCKER_UUID, {},
            function (err, config) {

            t.error(err, 'Error getting Docker config');
            if (config.metadata.hasOwnProperty('FWRULE_VERSION')) {
                FWRULE_VERSION = config.metadata.FWRULE_VERSION;
            }
            t.end();
        });
    });

    tt.test('pull nginx image', function (t) {
        cli.pull(t, {
            image: 'nginx:latest'
        });
    });


    tt.test('inspect nginx image', function (t) {
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


    tt.test('docker firewall rules created', function (t) {
        listFwRules(t, {
            filter: {
                owner_uuid: cli.accountUuid,
                tag: 'sdc_docker'
            },
            expected: [
                'FROM tag "sdc_docker" TO tag "sdc_docker" ALLOW tcp PORT all',
                'FROM tag "sdc_docker" TO tag "sdc_docker" ALLOW udp PORT all'
            ]
        });
    });


    tt.test('expose firewall rules not created', function (t) {
        listFwRules(t, {
            filter: {
                owner_uuid: cli.accountUuid,
                vm: h.dockerIdToUuid(cli.lastCreated)
            },
            expected: []
        });
    });


    tt.test('no port args: VMAPI tags', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                internal_metadata: {
                    'docker:tcp_unpublished_ports': JSON.stringify([ 443, 80 ])
                },
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


    tt.test('no port args: port', function (t) {
        cli.port(t, {
            id: cli.lastCreated,
            expected: {}
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
                PortBindings: {
                    '80/tcp' : portBindingsPort(80),
                    '443/tcp' : portBindingsPort(443)
                },
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


    tt.test('-P: expose firewall rules created', function (t) {
        listFwRules(t, {
            filter: {
                owner_uuid: cli.accountUuid,
                vm: h.dockerIdToUuid(cli.lastCreated)
            },
            expected: [
                exposeRule('tcp', cli.lastCreated, [80, 443])
            ]
        });
    });

    tt.test('-P: VMAPI metadata', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                internal_metadata: {
                    'docker:publish_all_ports': true
                },
                tags: {
                    sdc_docker: true
                }
            }
        });
    });


    tt.test('-P: port', function (t) {
        cli.port(t, {
            id: cli.lastCreated,
            expected: {
                '80/tcp': zeroAddr(80),
                '443/tcp': zeroAddr(443)
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


    tt.test('-p 80:80: expose firewall rules created', function (t) {
        listFwRules(t, {
            filter: {
                owner_uuid: cli.accountUuid,
                vm: h.dockerIdToUuid(cli.lastCreated)
            },
            expected: [
                exposeRule('tcp', cli.lastCreated, [80])
            ]
        });
    });


    tt.test('-p 80:80: VMAPI metadata', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                internal_metadata: {
                    'docker:tcp_unpublished_ports': JSON.stringify([ 443 ])
                },
                tags: {
                    sdc_docker: true
                }
            }
        });
    });


    tt.test('-P: port', function (t) {
        cli.port(t, {
            id: cli.lastCreated,
            expected: {
                '80/tcp': zeroAddr(80)
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


    tt.test('-P and -p: expose firewall rules created', function (t) {
        listFwRules(t, {
            filter: {
                owner_uuid: cli.accountUuid,
                vm: h.dockerIdToUuid(cli.lastCreated)
            },
            expected: [
                exposeRule('tcp', cli.lastCreated, [80, 90, 443]),
                exposeRule('udp', cli.lastCreated, [54])
            ]
        });
    });


    tt.test('-P and -p: VMAPI metadata', function (t) {
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                internal_metadata: {
                    'docker:publish_all_ports': true
                },
                tags: {
                    sdc_docker: true
                }
            }
        });
    });


    tt.test('-P and -p: inspect', function (t) {
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
                    '80/tcp': portBindingsPort(80),
                    '90/tcp': portBindingsPort(90),
                    '443/tcp': portBindingsPort(443)
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


    tt.test('-P and -p: port', function (t) {
        cli.port(t, {
            id: cli.lastCreated,
            expected: {
                '54/udp': zeroAddr(54),
                '80/tcp': zeroAddr(80),
                '90/tcp': zeroAddr(90),
                '443/tcp': zeroAddr(443)
            }
        });
    });

});


test('-p range', function (tt) {
    var large_range = '';
    var p;
    var ports = [];

    var START_PORT = 50;
    var END_PORT = START_PORT + constants.MAX_EXPOSED_PORTS - 1;

    tt.test(fmt('docker run -p %d-%d:%d-%d', START_PORT, END_PORT,
        START_PORT, END_PORT), function (t) {
        cli.run(t, { args: fmt('-p %d-%d:%d-%d/tcp -d nginx:latest', START_PORT,
            END_PORT, START_PORT, END_PORT) });
    });


    tt.test('-p range: inspect', function (t) {
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
                    '443/tcp': null
                }
            }
        };

        for (p = START_PORT; p <= END_PORT; p++) {
            partial.Config.ExposedPorts[p + '/tcp'] = {};
            partial.HostConfig.PortBindings[p + '/tcp'] = portBindingsPort(p);
            partial.NetworkSettings.Ports[p + '/tcp'] = netSettingsPort(p);
            ports.push(p);
        }

        cli.inspect(t, {
            id: cli.lastCreated,
            partialExp: partial
        });
    });

    tt.test('-p range:80: expose firewall rules created', function (t) {
        // odd implementation details here:
        // FWAPI supports 8 ports per rule, and rules are returned in
        // lexicographic order. Port groupings are also determined by
        // lexicographic order, however, port ordering within the rule
        // is by numeric order.
        //
        // example, 50-177 results in:
        // 100-107, 108-115, etc, until we reach the point where lex order
        // differs from numeric order producing the group:
        //     [172, 173, 174, 175, 176, 177, 50, 51]
        // which results in the rule:
        // 'FROM any TO vm 0cc75764-eed2-4353-9928-87e525e05dca ALLOW tcp
        // (PORT 50 AND PORT 51 AND PORT 172 AND PORT 173 AND PORT 174...
        //
        // If the API has been set up to make use of a new version of the
        // firewall language, it will take advantage of port ranges and
        // should therefore only make a single rule.
        var expectedRules = [];
        if (FWRULE_VERSION > 1) {
            expectedRules.push(
                exposeRange('tcp', cli.lastCreated, START_PORT, END_PORT));
        } else {
            ports.sort();
            for (var i = 0; i < ports.length; i += MAX_PORTS_PER_RULE) {
                expectedRules.push(exposeRule('tcp', cli.lastCreated,
                    ports.slice(i, i + MAX_PORTS_PER_RULE)
                        .sort(function (a, b) { return a > b; })));
            }
            expectedRules.sort();
        }

        listFwRules(t, {
            filter: {
                owner_uuid: cli.accountUuid,
                vm: h.dockerIdToUuid(cli.lastCreated)
            },
            expected: expectedRules
        });
    });


    tt.test('-p range: VMAPI metadata', function (t) {
        // expect lexicographic order.
        ports.sort();
        vm.get(t, {
            id: cli.lastCreated,
            partialExp: {
                firewall_enabled: true,
                internal_metadata: {},
                tags: {
                    sdc_docker: true
                }
            }
        });
    });


    tt.test('-P: port', function (t) {
        var exp = {};
        for (p = START_PORT; p <= END_PORT; p++) {
            exp[p + '/tcp'] = zeroAddr(p);
        }

        cli.port(t, {
            id: cli.lastCreated,
            expected: exp
        });
    });

    for (p = 1; p < (constants.MAX_EXPOSED_PORTS + 1) * 2; p += 2) {
        large_range += fmt(' -p %d:%d', p, p);
    }

    // Make sure the limit of 32 ports is enforced:
    tt.test(fmt('docker run %s', large_range), function (t) {
        cli.run(t, {
            args: fmt('%s -d nginx:latest', large_range),
            expectedErr: 'Error response from daemon: publish port: '
                + fmt('only support exposing %d TCP %s',
                    constants.MAX_EXPOSED_PORTS,
                    FWRULE_VERSION > 1 ? 'port ranges' : 'ports')
        });
    });

});

test('teardown', cli.rmAllCreated);
