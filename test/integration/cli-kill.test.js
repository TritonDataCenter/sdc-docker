/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for `docker kill`
 */

var assert = require('assert-plus');
var test = require('tape');
var vasync = require('vasync');


var cli = require('../lib/cli');
var container = require('../lib/container');
var h = require('./helpers');
var log = require('../lib/log');
var signals = require('../../lib/signals');

var STATE = {
    log: log
};

var ALICE;
var DOCKER_API_CLIENT;
var IMAGE_NAME = 'joyent/test-echo-signals:latest';

function removeUnsupportedSignals(signal) {
    assert.string(signal, 'signal');

    signal = signals.toLongSignalName(signal);

    // Sending SIGSTKFLT is currently _not_ supported on Triton because it maps
    // to SIGEMT on SmartOS, which is not supported by node-vmadm.
    return signal !== 'SIGSTKFLT' && signal !== '16';
}

function removeStoppingSignals(signal) {
    assert.string(signal, 'signal');

    signal = signals.toLongSignalName(signal);

    // Sending SIGSTOP (19) stops the init process running in a container. Thus,
    // any subsequent signal sent would not be handled since the init process
    // would be stop. So this tests suite does not test that SIGSTOP is properly
    // handled in the test that checks for other signals, and instead it tests
    // it in a separate test.
    return signal !== 'SIGSTOP' && signal !== '19';
}

function removeKillingSignals(signal) {
    assert.string(signal, 'signal');

    signal = signals.toLongSignalName(signal);

    // SIGKILL (9) and SIGSTOP (19) are the only signals for which one cannot
    // setup a custom handler and whose default behavior is to kill the process.
    // So if we want to keep the container alive in order to test that all other
    // signals are properly sent and received, we must avoid sending them. The
    // behavior for these two signals is tested separately.
    return signal !== 'SIGKILL' && signal !== '9' && signal !== 'SIGSTOP'
        && signal !== '19';
}

function removeZeroSignal(signal) {
    assert.string(signal, 'signal');

    return signal !== '0';
}

function testSignal(t, targetContainerId, signal, callback) {
    assert.object(t, 't');
    assert.string(targetContainerId, 'containerId');
    assert.string(signal, 'signal');
    assert.func(callback, 'callback');

    vasync.pipeline({
        funcs: [
            function sendSignal(args, next) {
                cli.kill({
                    args: '-s ' + signal + ' ' + targetContainerId,
                    t: t
                },
                function onKillDone(err, stdout, stderr) {
                    next(err);
                    return;
                });
            },
            function checkSignalReceived(args, next) {
                var signalName = signal;
                if (!isNaN(Number(signal))) {
                    signalName = signals.linuxSignalNames[signal];
                }

                assert.string(signalName, 'signalName');

                cli.logs(t, { args: targetContainerId},
                    function onLogsDone(err, stdout, stderr) {
                        t.ok(stdout.match(signalName), 'sent signal ' + signal
                            + ' and ' + signals.toLongSignalName(signalName)
                            + ' should have been received');

                        next(err);
                        return;
                    });
            }
        ]
    },
    function testDone(err) {
        // Do not forward error since we don't want to abort
        // the pipeline even if some tests failed: we want to
        // run all tests.
        callback();
        return;
    });
}

function testStatusAfterSendingSignal(t, signal, expectedStatus) {
    assert.object(t, 't');
    assert.string(signal, 'signal');
    assert.regexp(expectedStatus, 'expectedStatus');

    var containerId;

    vasync.pipeline({
        funcs: [
            function createContainer(args, next) {
                cli.run(t, { args: '-d ' + IMAGE_NAME}, function (err, id) {
                    t.ifErr(err, 'docker run ' + IMAGE_NAME
                        + ' should not error');
                    containerId = id;

                    next(err);
                    return;
                });
            },
            function sendSignal(args, next) {
                var dockerKillArgs = [];

                if (signal.length > 0) {
                    dockerKillArgs = dockerKillArgs.concat('-s', signal);
                }

                dockerKillArgs.push(containerId);

                cli.kill({
                    args: dockerKillArgs.join(' ')
                }, function onKillDone(err, stdout, stderr) {
                        t.ifErr(err, 'Sending signal ' + signal
                            + ' should not error');

                        next(err);
                        return;
                    });
            },
            function checkContainerExited(args, next) {
                container.checkContainerStatus(containerId, expectedStatus, {
                    helper: h,
                    dockerClient: DOCKER_API_CLIENT,
                    retries: 10
                }, function _onCheckDone(err, success) {
                    t.ifErr(err, 'Checking container status should not error');
                    t.ok(success, 'Container should be in status '
                        + expectedStatus);

                    next(err);
                    return;
                });
            }
        ]
    },
    function testDone(err) {
        cli.rm(t, {args: ['-f', containerId].join(' ')},
            function onContainerDeleted(rmErr) {
                t.end();
                return;
            });
    });
}

function testSignalUnsupported(t, signal) {
    assert.object(t, 't');
    assert.string(signal, 'signal');

    var containerId;

    vasync.pipeline({
        funcs: [
            function createContainer(args, next) {
                cli.run(t, { args: '-d ' + IMAGE_NAME}, function (err, id) {
                    t.ifErr(err, 'docker run ' + IMAGE_NAME
                        + ' should not error');
                    containerId = id;

                    next(err);
                    return;
                });
            },
            function sendSignal(args, next) {
                cli.kill({ args: '-s ' + signal + ' ' + containerId},
                    function onKillDone(err, stdout, stderr) {
                        t.ok(err, 'Sending signal ' + signal + ' should error');

                        if (!err) {
                            next(new Error('Sending unsupported signal '
                            + signal
                            + ' should have resulted in an error'));
                        } else {
                            next();
                        }

                        return;
                    });
            }
        ]
    },
    function testDone(err) {
        t.ifErr(err);

        cli.rm(t, {args: ['-f', containerId].join(' ')},
            function onContainerDeleted(rmErr) {
                t.end();
                return;
            });
    });
}

function testSignalStopsProcess(t, signal) {
    assert.object(t, 't');
    assert.string(signal, 'signal');

    var containerId;

    vasync.pipeline({
        funcs: [
            function createContainer(args, next) {
                cli.run(t, { args: '-d ' + IMAGE_NAME}, function (err, id) {
                    t.ifErr(err, 'docker run ' + IMAGE_NAME
                        + ' should not error');
                    containerId = id;

                    next(err);
                    return;
                });
            },
            function sendSignal(args, next) {
                cli.kill({ args: '-s ' + signal + ' ' + containerId},
                    function onKillDone(err, stdout, stderr) {
                        t.ifErr(err, 'Sending signal ' + signal
                            + ' should not error');

                        next(err);
                        return;
                    });
            },
            function checkInitProcessStopped(args, next) {
                var nbRetries = 0;
                var MAX_RETRIES = 10;

                function checkProcessStatus(callback) {
                    cli.exec(t, {args: containerId + ' cat /proc/1/status'},
                        callback);
                }

                function onProcessStatusChecked(err, stdout, stderr) {
                    var processStopped = false;
                    ++nbRetries;

                    if (err) {
                        next(err);
                        return;
                    }

                    processStopped = stdout.indexOf('State:	T (stopped)')
                        !== -1;

                    if (processStopped || nbRetries >= MAX_RETRIES) {
                        t.ok(processStopped,
                            'init process should be in state stopped');
                        next();
                        return;
                    } else {
                        setTimeout(function retryCheckProcessStatus() {
                            checkProcessStatus(onProcessStatusChecked);
                        }, 1000);
                    }
                }

                checkProcessStatus(onProcessStatusChecked);
            }
        ]
    },
    function testDone(err) {
        t.ifErr(err);

        cli.rm(t, {args: ['-f', containerId].join(' ')},
            function onContainerDeleted(rmErr) {
                t.end();
                return;
            });
    });
}

// Takes a list of signals as strings "signalsList" and returns a new list
// that contains only signals that can be handled by a custom signal handler
// without making a process exit.
function removeUnhandledSignals(signalsList) {
    assert.arrayOfString(signalsList, 'signals');
    var handledSignals = signalsList.slice(0);

    handledSignals = handledSignals.filter(removeKillingSignals);
    handledSignals = handledSignals.filter(removeUnsupportedSignals);
    handledSignals = handledSignals.filter(removeStoppingSignals);
    handledSignals = handledSignals.filter(removeZeroSignal);

    return handledSignals;
}

test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.getDockerEnv(t, STATE, {account: 'sdcdockertest_alice'},
                function (err, env) {
            t.ifErr(err, 'docker env: alice');
            t.ok(env, 'have a DockerEnv for alice');
            ALICE = env;

            t.end();
        });
    });

    tt.test('DockerEnv: alice init', function (t) {
        cli.init(t, ALICE);
    });

    tt.test('Docker API client init', function (t) {
        h.createDockerRemoteClient({user: ALICE}, function (err, client) {
            t.ifErr(err, 'docker client init');
            DOCKER_API_CLIENT = client;

            t.end();
        });
    });

    tt.test('pull joyent/test-echo-signals image', function (t) {
        cli.pull(t, {
            image: 'joyent/test-echo-signals:latest'
        });
    });
});

test('docker kill with default signal makes a container\'s init process exit',
    function (t) {
        testStatusAfterSendingSignal(t, '', /^Exited /);
    });


test('docker kill with signal numbers sends the proper signal to containers',
    function (t) {
        function mapSignalNumber(signalName, index) {
            return '' + index;
        }

        var containerId;

        var linuxSignalNumbers = signals.linuxSignalNames.map(mapSignalNumber);
        linuxSignalNumbers = removeUnhandledSignals(linuxSignalNumbers);

        cli.run(t, { args: '-d ' + IMAGE_NAME}, function (dockerRunErr, id) {
            t.ifErr(dockerRunErr, 'docker run ' + IMAGE_NAME);
            containerId = id;

            vasync.forEachPipeline({
                func: testSignal.bind(null, t, containerId),
                inputs: linuxSignalNumbers
            }, function allTestsDone(err) {
                t.ifErr(err);
                cli.rm(t, {args: ['-f', containerId].join(' ')},
                    function onContainerDeleted(delErr) {
                        t.end();
                        return;
                    });
            });
        });
    });

test('docker kill with signal number 9 makes a container\'s init process exit',
    function (t) {
        testStatusAfterSendingSignal(t, '9', /^Exited /);
    });

test('docker kill with signal 16 is not supported', function (t) {
    testSignalUnsupported(t, '16');
});

test('docker kill with signal number 19 stops a container\'s init process',
    function (t) {
        testSignalStopsProcess(t, '19');
    });

test('docker kill with short signal names sends the proper signal to '
    + 'containers', function (t) {
    var containerId;
    var linuxSignalNames = signals.linuxSignalNames;
    linuxSignalNames = removeUnhandledSignals(linuxSignalNames);

    cli.run(t, { args: '-d ' + IMAGE_NAME}, function (dockerRunErr, id) {
        t.ifErr(dockerRunErr, 'docker run ' + IMAGE_NAME);
        containerId = id;

        vasync.forEachPipeline({
            func: testSignal.bind(null, t, containerId),
            inputs: linuxSignalNames
        }, function allTestsDone(err) {
            t.ifErr(err);
            cli.rm(t, {args: ['-f', containerId].join(' ')},
                function onContainerDeleted(delErr) {
                    t.end();
                    return;
                });
        });
    });
});

test('docker kill with long signal names sends the proper signal to '
    + 'containers', function (t) {
    var containerId;
    var linuxSignalNames = signals.linuxSignalNames;
    var longLinuxSignalNames;

    linuxSignalNames = removeUnhandledSignals(linuxSignalNames);
    longLinuxSignalNames = linuxSignalNames.map(signals.toLongSignalName);

    cli.run(t, { args: '-d ' + IMAGE_NAME}, function (dockerRunErr, id) {
        t.ifErr(dockerRunErr, 'docker run ' + IMAGE_NAME);
        containerId = id;

        vasync.forEachPipeline({
            func: testSignal.bind(null, t, containerId),
            inputs: longLinuxSignalNames
        }, function allTestsDone(err) {
            t.ifErr(err);
            cli.rm(t, {args: ['-f', containerId].join(' ')},
                function onContainerDeleted(delErr) {
                    t.end();
                    return;
                });
        });
    });
});

test('docker kill with signal SIGKILL makes a container\'s init process exit',
    function (t) {
        testStatusAfterSendingSignal(t, 'SIGKILL', /^Exited /);
    });

test('docker kill with signal KILL makes a container\'s init process exit',
    function (t) {
        testStatusAfterSendingSignal(t, 'KILL', /^Exited /);
    });

test('docker kill with signal SIGSTKFLT is not supported', function (t) {
    testSignalUnsupported(t, 'SIGSTKFLT');
});

test('docker kill with signal STKFLT is not supported', function (t) {
    testSignalUnsupported(t, 'STKFLT');
});

test('docker kill with signal SIGSTOP stops a container\'s init process',
    function (t) {
        testSignalStopsProcess(t, 'SIGSTOP');
    });

test('docker kill with signal STOP stops a container\'s init process',
    function (t) {
        testSignalStopsProcess(t, 'STOP');
    });

test('docker kill with signal \'0\' results in a request error', function (t) {
    testSignalUnsupported(t, '0');
});