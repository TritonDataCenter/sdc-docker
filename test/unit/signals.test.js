/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var test = require('tape');

var signals = require('../../lib/signals');

var VALID_SIGNAL_NUMBERS = [];
for (var i = 0; i < signals.linuxSignalNames.length; ++i) {
    VALID_SIGNAL_NUMBERS.push('' + i);
}

var VALID_LINUX_LONG_SIGNAL_NAMES = [
    '0', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
    'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2',
    'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGSTKFLT', 'SIGCHLD', 'SIGCONT',
    'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU',
    'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGPOLL', 'SIGPWR',
    'SIGSYS'
];

var VALID_LINUX_SHORT_SIGNAL_NAMES = [
    '0', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT',
    'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE',
    'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP',
    'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ',
    'VTALRM', 'PROF', 'WINCH', 'POLL', 'PWR', 'SYS'
];

var SMARTOS_ONLY_LONG_SIGNAL_NAMES = [
    'SIGWAITING', 'SIGLWP', 'SIGFREEZE', 'SIGTHAW', 'SIGCANCEL', 'SIGLOST',
    'SIGXRES', 'SIGINFO'
];

var SMARTOS_ONLY_SHORT_SIGNAL_NAMES = [
    'WAITING', 'LWP', 'FREEZE', 'THAW', 'CANCEL', 'LOST', 'XRES', 'INFO'
];

var INVALID_SIGNAL_NAMES = ['', 'foo'];

var NON_STRING_SIGNALS = [
    6, {}, undefined, null
];

var LINUX_TO_SMARTOS_SHORT_SYMBOLIC_NAMES = {
    '0':         '0',
    'HUP':       'SIGHUP',
    'INT':       'SIGINT',
    'QUIT':      'SIGQUIT',
    'ILL':       'SIGILL',
    'TRAP':      'SIGTRAP',
    'ABRT':      'SIGABRT',
    'BUS':       'SIGBUS',
    'FPE':       'SIGFPE',
    'KILL':      'SIGKILL',
    'USR1':      'SIGUSR1',
    'SEGV':      'SIGSEGV',
    'USR2':      'SIGUSR2',
    'PIPE':      'SIGPIPE',
    'ALRM':      'SIGALRM',
    'TERM':      'SIGTERM',
    'STKFLT':    'SIGEMT',
    'CHLD':      'SIGCHLD',
    'CONT':      'SIGCONT',
    'STOP':      'SIGSTOP',
    'TSTP':      'SIGTSTP',
    'TTIN':      'SIGTTIN',
    'TTOU':      'SIGTTOU',
    'URG':       'SIGURG',
    'XCPU':      'SIGXCPU',
    'XFSZ':      'SIGXFSZ',
    'VTALRM':    'SIGVTALRM',
    'PROF':      'SIGPROF',
    'WINCH':     'SIGWINCH',
    'POLL':      'SIGPOLL',
    'PWR':       'SIGPWR',
    'SYS':       'SIGSYS'
};

var LINUX_TO_SMARTOS_LONG_SYMBOLIC_NAMES = {
    '0':            '0',
    'SIGHUP':       'SIGHUP',
    'SIGINT':       'SIGINT',
    'SIGQUIT':      'SIGQUIT',
    'SIGILL':       'SIGILL',
    'SIGTRAP':      'SIGTRAP',
    'SIGABRT':      'SIGABRT',
    'SIGBUS':       'SIGBUS',
    'SIGFPE':       'SIGFPE',
    'SIGKILL':      'SIGKILL',
    'SIGUSR1':      'SIGUSR1',
    'SIGSEGV':      'SIGSEGV',
    'SIGUSR2':      'SIGUSR2',
    'SIGPIPE':      'SIGPIPE',
    'SIGALRM':      'SIGALRM',
    'SIGTERM':      'SIGTERM',
    'SIGSTKFLT':    'SIGEMT',
    'SIGCHLD':      'SIGCHLD',
    'SIGCONT':      'SIGCONT',
    'SIGSTOP':      'SIGSTOP',
    'SIGTSTP':      'SIGTSTP',
    'SIGTTIN':      'SIGTTIN',
    'SIGTTOU':      'SIGTTOU',
    'SIGURG':       'SIGURG',
    'SIGXCPU':      'SIGXCPU',
    'SIGXFSZ':      'SIGXFSZ',
    'SIGVTALRM':    'SIGVTALRM',
    'SIGPROF':      'SIGPROF',
    'SIGWINCH':     'SIGWINCH',
    'SIGPOLL':      'SIGPOLL',
    'SIGPWR':       'SIGPWR',
    'SIGSYS':       'SIGSYS'
};

var LINUX_SIG_NUMBER_TO_SMARTOS_SIG_NAME = [
    '0',
    'SIGHUP',
    'SIGINT',
    'SIGQUIT',
    'SIGILL',
    'SIGTRAP',
    'SIGABRT',
    'SIGBUS',
    'SIGFPE',
    'SIGKILL',
    'SIGUSR1',
    'SIGSEGV',
    'SIGUSR2',
    'SIGPIPE',
    'SIGALRM',
    'SIGTERM',
    'SIGEMT',
    'SIGCHLD',
    'SIGCONT',
    'SIGSTOP',
    'SIGTSTP',
    'SIGTTIN',
    'SIGTTOU',
    'SIGURG',
    'SIGXCPU',
    'SIGXFSZ',
    'SIGVTALRM',
    'SIGPROF',
    'SIGWINCH',
    'SIGPOLL',
    'SIGPWR',
    'SIGSYS'
];

test('signals.toLongSignalName with signal numbers', function (t) {
    function testSigNumberToLongSignalName(signalNumber) {
        t.equal(signalNumber, signals.toLongSignalName(signalNumber),
            'signals.toLongSignalName(\'' + signalNumber + '\') === \''
            + signalNumber + '\'');
    }

    VALID_SIGNAL_NUMBERS.forEach(testSigNumberToLongSignalName);

    t.end();
});

test('signals.toLongSignalName with long signal names', function (t) {
    function testLongToLong(longSignalName) {
        t.equal(longSignalName, signals.toLongSignalName(longSignalName),
            'signals.toLongSignalName(\'' + longSignalName + '\') === \''
            + longSignalName + '\'');
    }

    VALID_LINUX_LONG_SIGNAL_NAMES.forEach(testLongToLong);

    t.end();
});

test('signals.toLongSignalName with short signal names', function (t) {
    function testShortToLong(shortSignalName) {
        var expectedResult = 'SIG' + shortSignalName;
        if (shortSignalName === '0') {
            expectedResult = '0';
        }

        t.equal(expectedResult, signals.toLongSignalName(shortSignalName),
            'signals.toLongSignalName(\'' + shortSignalName + '\') === \''
            + expectedResult + '\'');
    }

    VALID_LINUX_SHORT_SIGNAL_NAMES.forEach(testShortToLong);

    t.end();
});

test('signals.toLongSignalName with invalid signal names', function (t) {
    INVALID_SIGNAL_NAMES.forEach(function testInvalidToLong(invalidSignalName) {
        t.equal(invalidSignalName, signals.toLongSignalName(invalidSignalName),
            'signals.toLongSignalName(\'' + invalidSignalName + '\') === \''
            + invalidSignalName + '\'');
    });

    t.end();
});

test('signals.toLongSignalName throws on non-string signal parameter',
    function (t) {
        var nonStringSignals = [6, {}, undefined, null];

        nonStringSignals.forEach(function testNonStringToLong(nonStringSignal) {
            t.throws(signals.toLongSignalName.bind(null, nonStringSignal),
                'signals.toLongSignalName(' + nonStringSignal + ') throws');
        });

        t.end();
    });

test('signals.toShortSignalName with signal numbers', function (t) {
    function testSigNumbertoShortSignalName(signalNumber) {
        t.equal(signalNumber, signals.toShortSignalName(signalNumber),
            'signals.toShortSignalName(\'' + signalNumber + '\') === \''
            + signalNumber + '\'');
    }

    VALID_SIGNAL_NUMBERS.forEach(testSigNumbertoShortSignalName);

    t.end();
});

test('signals.toShortSignalName with long signal names', function (t) {
    function testLongToShort(longSignalName) {
        var expectedResult = longSignalName.replace(/^SIG/, '');
        t.equal(expectedResult, signals.toShortSignalName(longSignalName),
            'signals.toShortSignalName(\'' + longSignalName + '\') === \''
            + expectedResult + '\'');
    }

    VALID_LINUX_LONG_SIGNAL_NAMES.forEach(testLongToShort);

    t.end();
});

test('signals.toShortSignalName with short signal names', function (t) {
    function testShortToLong(shortSignalName) {
        t.equal(shortSignalName, signals.toShortSignalName(shortSignalName),
            'signals.toShortSignalName(\'' + shortSignalName + '\') === \''
            + shortSignalName + '\'');
    }

    VALID_LINUX_SHORT_SIGNAL_NAMES.forEach(testShortToLong);

    t.end();
});

test('signals.toShortSignalName with invalid signal names', function (t) {
    function testInvalidToShort(invalidSignalName) {
        t.equal(invalidSignalName, signals.toShortSignalName(invalidSignalName),
            'signals.toShortSignalName(\'' + invalidSignalName + '\') === \''
            + invalidSignalName + '\'');
    }

    INVALID_SIGNAL_NAMES.forEach(testInvalidToShort);

    t.end();
});

test('signals.toShortSignalName throws on non-string signal parameter',
    function (t) {
        function testNonStringToShort(nonStringSignal) {
            t.throws(signals.toShortSignalName.bind(null, nonStringSignal),
                'signals.toShortSignalName(' + nonStringSignal + ') throws');
        }

        NON_STRING_SIGNALS.forEach(testNonStringToShort);

        t.end();
    });

test('signals.isValidLinuxSignal returns true for long valid Linux signal '
    + 'names', function (t) {
        function checkIsValidLinuxLongSignal(validLinuxLongSignalName) {
            t.ok(signals.isValidLinuxSignal(validLinuxLongSignalName),
                'signals.isValidLinuxSignal(\'' + validLinuxLongSignalName
                + '\') returns true');
        }

        VALID_LINUX_LONG_SIGNAL_NAMES.forEach(checkIsValidLinuxLongSignal);

        t.end();
    });


test('signals.isValidLinuxSignal returns true for short valid Linux signal '
    + 'names', function (t) {
        function checkValidLinuxShortSignal(validLinuxShortSignalName) {
            t.ok(signals.isValidLinuxSignal(validLinuxShortSignalName),
                'signals.isValidLinuxSignal(\'' + validLinuxShortSignalName
                + '\') returns true');
        }

        VALID_LINUX_SHORT_SIGNAL_NAMES.forEach(checkValidLinuxShortSignal);

        t.end();
    });


test('signals.isValidLinuxSignal returns false for SmartOS only long signal '
    + 'names', function (t) {
        function checkSmartOSOnlyLongSignal(smartOSOnlyLongSignalName) {
            t.notOk(signals.isValidLinuxSignal(smartOSOnlyLongSignalName),
                'signals.isValidLinuxSignal(\'' + smartOSOnlyLongSignalName
                + '\') returns false');
        }

        SMARTOS_ONLY_LONG_SIGNAL_NAMES.forEach(checkSmartOSOnlyLongSignal);

        t.end();
    });

test('signals.isValidLinuxSignal returns false for SmartOS only short signal '
    + 'names', function (t) {
        function checkSmartOSOnlyShortSignal(smartOSOnlyShortSignalName) {
            t.notOk(signals.isValidLinuxSignal(smartOSOnlyShortSignalName),
                'signals.isValidLinuxSignal(\'' + smartOSOnlyShortSignalName
                + '\') returns false');
        }

        SMARTOS_ONLY_SHORT_SIGNAL_NAMES.forEach(checkSmartOSOnlyShortSignal);

        t.end();
    });

test('signals.isValidLinuxSignal returns false for invalid signal names',
    function (t) {
        INVALID_SIGNAL_NAMES.forEach(function (invalidSignalName) {
            t.notOk(signals.isValidLinuxSignal(invalidSignalName),
                'signals.isValidLinuxSignal(\'' + invalidSignalName
                + '\') returns false');
        });

        t.end();
    });

test('signals.isValidLinuxSignal throws for non-string signal names',
    function (t) {
        NON_STRING_SIGNALS.forEach(function (nonStringSignal) {
            t.throws(signals.isValidLinuxSignal.bind(null, nonStringSignal),
                'signals.isValidLinuxSignal(' + nonStringSignal + ') throws');
        });

        t.end();
    });

test('signals.convertLinuxToSmartOSSignal returns undefined on invalid '
    + 'signal names', function (t) {
        function checkInvalidSignal(invalidSignalName) {
            t.equal(signals.convertLinuxToSmartOSSignal(invalidSignalName),
                undefined, 'signals.convertLinuxToSmartOSSignal('
                + invalidSignalName + ') === undefined');
        }

        INVALID_SIGNAL_NAMES.forEach(checkInvalidSignal);

        t.end();
    });


test('signals.convertLinuxToSmartOSSignal returns undefined on SmartOS-only '
    + ' short signal name', function (t) {
    function checkSmartOSOnlyShortSignal(smartOSOnlyShortSignalName) {
        t.equal(signals.convertLinuxToSmartOSSignal(smartOSOnlyShortSignalName),
        undefined, 'signals.convertLinuxToSmartOSSignal(\''
            + smartOSOnlyShortSignalName +  '\') === undefined');
    }

    SMARTOS_ONLY_SHORT_SIGNAL_NAMES.forEach(checkSmartOSOnlyShortSignal);

    t.end();
});

test('signals.convertLinuxToSmartOSSignal returns undefined on SmartOS-only '
    + 'long signal name', function (t) {

    function checkSmartOSOnlyLongSignal(smartOSOnlyLongSignalName) {
        t.equal(signals.convertLinuxToSmartOSSignal(smartOSOnlyLongSignalName),
        undefined, 'signals.convertLinuxToSmartOSSignal(\''
            + smartOSOnlyLongSignalName +  '\') === undefined');
    }

    SMARTOS_ONLY_LONG_SIGNAL_NAMES.forEach(checkSmartOSOnlyLongSignal);

    t.end();
});

test('signals.convertLinusToSmartOSSignal works for numeric signals',
    function (t) {
        function checkToSmartOSConversion(signalNumber) {
            t.equal(LINUX_SIG_NUMBER_TO_SMARTOS_SIG_NAME[signalNumber],
                signals.convertLinuxToSmartOSSignal(signalNumber),
                'signals.convertLinuxToSmartOSSignal(\'' + signalNumber
                + '\') === ' + '\''
                + LINUX_SIG_NUMBER_TO_SMARTOS_SIG_NAME[signalNumber] + '\'');
        }

        VALID_SIGNAL_NUMBERS.forEach(checkToSmartOSConversion);

        t.end();
    });

test('signals.convertLinusToSmartOSSignal works for short symbolic signal '
    + 'names', function (t) {
    function checkToSmartOSConversion(signalName) {
        var expectedResult = LINUX_TO_SMARTOS_SHORT_SYMBOLIC_NAMES[signalName];
        t.equal(expectedResult,
            signals.convertLinuxToSmartOSSignal(signalName),
            'signals.convertLinuxToSmartOSSignal(\'' + signalName
            + '\') === ' + '\''
            + expectedResult + '\'');
    }

    VALID_LINUX_SHORT_SIGNAL_NAMES.forEach(checkToSmartOSConversion);

    t.end();
});

test('signals.convertLinusToSmartOSSignal works for long symbolic signal '
    + 'names', function (t) {
    function checkToSmartOSConversion(signalName) {
        var expectedResult = LINUX_TO_SMARTOS_LONG_SYMBOLIC_NAMES[signalName];
        t.equal(expectedResult,
            signals.convertLinuxToSmartOSSignal(signalName),
            'signals.convertLinuxToSmartOSSignal(\'' + signalName
            + '\') === ' + '\''
            + expectedResult + '\'');
    }

    VALID_LINUX_LONG_SIGNAL_NAMES.forEach(checkToSmartOSConversion);

    t.end();
});

test('signals.convertLinuxToSmartOSSignal throws on invalid input',
    function (t) {
    NON_STRING_SIGNALS.forEach(function (nonStringSignal) {
        t.throws(signals.convertLinuxToSmartOSSignal.bind(null,
            nonStringSignal),
            'signals.convertLinuxToSmartOSSignal(' + nonStringSignal
            + ') throws');
    });

    t.end();
});
