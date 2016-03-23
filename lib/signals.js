/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');

// This table is used for several purposes:
// 1. It defines the list of valid signal numbers and names that can be sent
//    to a Docker container.
// 2. It defines a mapping between Linux signal numbers to SmartOS signal names.
var linuxToSmartOSSigNames = {
    // Signal 0 is a "special" signal that doesn't trigger any handler: all the
    // code that checks whether the sender has the permission to send a signal
    // to the target process are performed though, so it can generally be used
    // to test permissions without having an impact on the target process. His
    // symbolic name is '0' too.
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
    // Signal 16 is SIGSTKFLT on Linux, which doesn't exists on SmartOS.
    // Instead, the SmartOS' lx brand maps it to SIGEMT, which doesn't exist
    // on Linux, so the mapping for any Linux signal to a SmartOS signal is
    // still unique.
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

// linuxSignalNames is just an array of all valid signal names on Linux
var linuxSignalNames = Object.keys(linuxToSmartOSSigNames);

/**
 * Returns a string that represents the signal with name "signalName" without
 * the 'SIG' prefix. For instance, toShortSignalName('SIGKILL') returns 'KILL'.
 */
function toShortSignalName(signalName) {
    assert.string(signalName, 'signalName');

    return signalName.replace(/^SIG/, '');
}

/**
 * Returns a string that represents the signal with name "signalName" with the
 * 'SIG' prefix. For instance, toShortSignalName('KILL') returns 'SIGKILL'.
 */
function toLongSignalName(signalName) {
    assert.string(signalName, 'signalName');

    if (signalName.length > 0
        && isNaN(Number(signalName))
        && signalName.indexOf('SIG') !== 0
        && isValidLinuxSignal(signalName)) {
        return 'SIG' + signalName;
    } else {
        return signalName;
    }
}

/*
 * Converts a signal number or string from a Linux signal to its equivalent
 * SmartOS signal long name as a string.
 *
 * If "signal" represents an invalid Linux signal, it returns undefined.
 *
 * Some examples:
 *
 *  - convertLinuxToSmartOSSignal('7') returns 'SIGBUS'
 *  - convertLinuxToSmartOSSignal('BUS') returns 'SIGBUS'.
 *  - convertLinuxToSmartOSSignal('SIGBUS') returns 'SIGBUS'.
 *  - convertLinuxToSmartOSSignal(42) returns undefined.
 *  - convertLinuxToSmartOSSignal('SIGFREEZE') returns undefined.
 */
function convertLinuxToSmartOSSignal(signal) {
    assert.string(signal, 'signal');

    var signalNumber = Number(signal);
    var linuxSignalName;
    var smartOSSignalName;

    if (isNaN(signalNumber)) {
        // Symbolic signal names don't need to be mapped to SmartOS signals,
        // as all signal names that are supported on Linux _and_ SmartOS have
        // the same semantics, e.g SIGBUS on Linux has the same semantics as
        // SIGBUS on SmartOS, even if they don't correspond to the same signal
        // numbers.
        smartOSSignalName = linuxToSmartOSSigNames[toShortSignalName(signal)];
    } else if (signal.length > 0) {
        // Numeric signals don't have the same semantics on Linux and SmartOS.
        // For instance, signal 7 means SIGBUS on Linux whereas it means
        // SIGEMT on SmartOS. Thus, when a user means to send signal 7 to her
        // Docker container, she means `SIGBUS`, and thus the kill task run by
        // cn-agent needs to send SIGBUS from the global zone to that
        // container's init process, _not_ signal 7.
        linuxSignalName = linuxSignalNames[signalNumber];
        smartOSSignalName = linuxToSmartOSSigNames[linuxSignalName];
    }

    return smartOSSignalName;
}

/**
 * Returns true if "signal" is a string that represents a valid Linux signal,
 * false otherwise.
 * For instance, isValidLinuxSignal('SIGKILL') returns true, but
 * isValidLinuxSignal('SIGFREEZE') returns false.
 */
function isValidLinuxSignal(signal) {
    assert.string(signal, 'signal');

    var signalNumber = Number(signal);

    if (isNaN(signalNumber)) {
        return linuxSignalNames.indexOf(toShortSignalName(signal)) !== -1;
    } else {
        // Check signal is not empty string, which coerces to 0,
        // and that it's within the range of valid linux signals.
        return signal.length > 0
            && signalNumber >= 0 && signalNumber < linuxSignalNames.length
            && linuxSignalNames[signalNumber] !== undefined;
    }
}

module.exports = {
    convertLinuxToSmartOSSignal: convertLinuxToSmartOSSignal,
    isValidLinuxSignal: isValidLinuxSignal,
    linuxSignalNames: linuxSignalNames,
    toShortSignalName: toShortSignalName,
    toLongSignalName: toLongSignalName
};
