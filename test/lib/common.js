/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Helpers for SDC Docker tests and test/lib
 */

var assert = require('assert-plus');
var deepEqual = require('deep-equal');
var difflet = require('difflet');
var exec = require('child_process').exec;
var fmt = require('util').format;
var libuuid = require('libuuid');
var VError = require('verror').VError;


// --- Globals


/* BEGIN JSSTYLED */
/**
 * Parse docker error response.
 *
 * Starting with Docker v1.7 they look like this:
 *      Error response from daemon: (Validation) invalid label: Triton tag "triton.cns.disable" value must be "true" or "false": "nonbool" (af09fc40-e55b-11e5-a48d-bd9fb8c36dea)
 * Starting with Docker v1.10 they look like this:
 *      /path/to/docker-cli: Error response from daemon: (Validation) invalid label: Triton tag "triton.cns.disable" value must be "true" or "false": "nonbool" (af09fc40-e55b-11e5-a48d-bd9fb8c36dea)
 *
 * The 'm' multiline modifier on ERR_CLI_RE allows for leading output, e.g.
 * docker pull output implicitly part of a `docker run` command.
 *
 * Note: The match group/positioning must stay the same between these regexes.
 */
var ERR_API_RE = /^()(.*) \(([^)]+)\)$/;
var ERR_CLI_RE = /^(.*?\:\s?)?(Error response from daemon: .*) \(([^)]+)\)(\.\nSee '.* --help'\.)?$/m;
/* END JSSTYLED */


// --- Exports

/**
 * Copies over all keys in `from` to `to`, or
 * to a new object if `to` is not given.
 */
function objCopy(from, to) {
    if (to === undefined) {
        to = {};
    }
    for (var k in from) {
        to[k] = from[k];
    }
    return to;
}


/**
 * Call when done an operation in a test.  If callback exists, call that.
 * If not, end the test.
 */
function done(t, callback, err, res) {
    if (callback) {
        callback(err, res);
        return;
    }

    t.end();
}


/**
 * A convenience wrapper around `child_process.exec` to take away some
 * logging and error handling boilerplate.
 *
 * @param args {Object}
 *      - command {String} Required.
 *      - log {Bunyan Logger} Required. Use to log details at trace level.
 *      - execOpts {Array} Optional. child_process.exec options.
 *      - errMsg {String} Optional. Error string to use in error message on
 *        failure.
 * @param cb {Function} `function (err, stdout, stderr)` where `err` here is
 *      an `VError` wrapper around the child_process error.
 */
function execPlus(args, cb) {
    assert.object(args, 'args');
    assert.string(args.command, 'args.command');
    assert.optionalString(args.errMsg, 'args.errMsg');
    assert.optionalObject(args.execOpts, 'args.execOpts');
    assert.object(args.log, 'args.log');
    assert.func(cb);
    var command = args.command;
    var execOpts = args.execOpts;

    // args.log.trace({exec: true, command: command, execOpts: execOpts},
    //      'exec start');
    exec(command, execOpts, function (err, stdout, stderr) {
        args.log.trace({exec: true, command: command, execOpts: execOpts,
            err: err, stdout: stdout, stderr: stderr}, 'exec done');
        if (err) {
            cb(
                new VError(err,
                    '%s:\n'
                    + '\tcommand: %s\n'
                    + '\texit status: %s\n'
                    + '\tstdout:\n%s\n'
                    + '\tstderr:\n%s',
                    args.errMsg || 'exec error', command, err.code,
                    stdout.trim(), stderr.trim()),
                stdout, stderr);
        } else {
            cb(null, stdout, stderr);
        }
    });
}

var constants = {
    // canonical value is lib/backends/sdc/containers.js
    MAX_EXPOSED_PORTS: 128
};

/**
 * Does a deep equal of opts.expected and obj
 */
function expectedDeepEqual(t, opts, obj) {
    if (!opts.hasOwnProperty('expected')) {
        return;
    }

    t.deepEqual(obj, opts.expected, 'expected');
    if (!deepEqual(obj, opts.expected)) {
        t.comment(difflet({ indent: 4, comment: true })
            .compare(obj, opts.expected));
    }
}


/**
 * Tests for an expected error message, where `err` can either be an error
 * object or a string, and `expected` is the expected message (or regexp).
 */
function expErr(t, err, expected, isCliErr, callback) {
    var errorString;
    var message;

    t.ok(err, 'expected error');

    if (!err) {
        done(t, callback, new Error('no error found'));
        return;
    }

    message = (typeof (err) === 'object' ? err.message : err)
        .replace(/\n$/, '');

    /* BEGIN JSSTYLED */
    /*
     * Messages from Docker *version 1.6 and lower* on stderr (when not
     * attached to a terminal) look like:
     *      time="2016-03-08T18:28:44Z" level=fatal msg="Error response from daemon: (Validation) invalid label: Triton tag \"triton.cns.disable\" value must be \"true\" or \"false\": \"nonbool\" (96aad1b0-e55b-11e5-a48d-bd9fb8c36dea)"
     * Starting with Docker v1.7 they look like this:
     *      Error response from daemon: (Validation) invalid label: Triton tag "triton.cns.disable" value must be "true" or "false": "nonbool" (af09fc40-e55b-11e5-a48d-bd9fb8c36dea)
     * Starting with Docker v1.10 they look like this:
     *      /path/to/docker-cli: Error response from daemon: (Validation) invalid label: Triton tag "triton.cns.disable" value must be "true" or "false": "nonbool" (af09fc40-e55b-11e5-a48d-bd9fb8c36dea)
     *
     * For testing we want to normalize on the latter, so we'll attempt to sniff
     * and normalize the former. Note two things:
     * 1. the separate 'time', 'level', 'msg' fields; and
     * 2. the double-quote escaping
     *
     * Limitation: only handling first line if possible multiline stderr.
     */
    var docker16StderrRe = /^time=".*?" level=.*? msg="(.*?)"\s*$/m;
    var docker16Match = docker16StderrRe.exec(message);
    if (docker16Match) {
        message = docker16Match[1].replace(/\\"/g, '"');
    }
    /* END JSSTYLED */

    var expectedErrRe = (isCliErr ? ERR_CLI_RE : ERR_API_RE);
    var matches = message.match(expectedErrRe);
    if (!matches) {
        t.ok(matches, fmt('err message does not match %s: %j',
            expectedErrRe, message));
        done(t, callback, new Error('unexpected error output'));
        return;
    }
    t.ok(matches[3], 'error req id: ' + matches[3]);
    errorString = matches[2];

    if (RegExp.prototype.isPrototypeOf(expected)) {
        t.ok(expected.test(errorString),
            fmt('error message matches %s: %j', expected, errorString));
    } else {
        t.equal(errorString, expected,
            'error message matches expected pattern');
    }

    done(t, callback, err);
}


/**
 * Tests for an expected api error message, where `err` can either be an error
 * object or a string, and `expected` is the expected message.
 */
function expApiErr(t, err, expected, callback) {
    return expErr(t, err, expected, false, callback);
}


/**
 * Tests for an expected cli error message, where `err` can either be an error
 * object or a string, and `expected` is the expected message.
 */
function expCliErr(t, err, expected, callback) {
    return expErr(t, err, expected, true, callback);
}


/**
 * Calls t.ifError, outputs the error body for diagnostic purposes, and
 * returns true if there was an error
 */
function ifErr(t, err, desc) {
    t.ifError(err, desc);
    if (err) {
        t.deepEqual(err.body, {}, desc + ': error body');
        return true;
    }

    return false;
}


/**
 * Partial expected output - check equality of pieces of an object (specified
 * by `opts.partialExp`), not the whole thing.
 */
function partialExp(t, opts, obj) {
    if (!opts.partialExp) {
        return;
    }

    var compareMessage = 'partial expected';
    var partial = {};

    if (opts.compareMessage) {
        compareMessage = opts.compareMessage;
    }

    for (var p in opts.partialExp) {
        // Allow specifying some properties of sub-objects, but
        // not all:
        if (typeof (opts.partialExp[p]) === 'object') {
            partial[p] = {};

            for (var e in opts.partialExp[p]) {
                partial[p][e] = obj[p][e];
            }

        } else {
            partial[p] = obj[p];
        }
    }

    t.deepEqual(partial, opts.partialExp, compareMessage);
    if (!deepEqual(partial, opts.partialExp)) {
        t.comment(difflet({ indent: 4, comment: true })
            .compare(partial, opts.partialExp));
    }
}


/*
 * Make a prefixed, randomized name for a test container.
 */
function makeResourceName(prefix) {
    return prefix + '-' + libuuid.create().split('-')[0];
}

function parseDockerVersion(dockerVersionString) {
    assert.string(dockerVersionString);

    var dockerVersionRegExp = /^(\d+)\.(\d+)\.(\d+)(\-[a-z0-9]+)?$/;
    var matches = dockerVersionString.match(dockerVersionRegExp);
    var major, minor, patch, label;

    if (!matches) {
        return null;
    }

    major = Number(matches[1]);
    minor = Number(matches[2]);
    patch = Number(matches[3]);
    label = matches[4];
    if (label !== undefined) {
        label = label.substr(1);
    }

    // major, minor and patch version info are mandatory, label is optional
    if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
        return null;
    }

    return {
        major: major,
        minor: minor,
        patch: patch,
        label: label
    };
}

/*
 * Parse docker columnar output by using the widths in the first header row.
 */
function parseOutputUsingHeader(stdout, opts) {
    var entries = [];
    var i, j;
    var lines = stdout.trim().split('\n');
    var re = /\s+/;
    var headerLine = lines[0].toLowerCase();
    // Some header names use spaces, like 'image id', so adjust those.
    if (opts.headerNamesWithSpaces) {
        var snames = opts.headerNamesWithSpaces;
        snames.forEach(function (name) {
            headerLine = headerLine.replace(name, name.replace(/\s/g, '_'));
        });
    }
    var header = headerLine.split(re);

    if (opts.linesOnly) {
        entries = lines;
    } else {
        // From header, determine where each section begins/ends:
        var headerStartEnds = header.map(function (val, idx) {
            var nextval = header[idx + 1];
            if (idx + 1 == header.length) {
                return [headerLine.indexOf(val), 100000];
            } else {
                return [headerLine.indexOf(val),
                    headerLine.indexOf(nextval)];
            }
        });
        //console.log('header:', header, 'startEnds', headerStartEnds);

        // Split the output lines:
        for (i = 1; i < lines.length; i++) {
            var entry = {};
            var line = lines[i].trim();
            if (!line) {
                continue;
            }
            for (j = 0; j < header.length; j++) {
                var se = headerStartEnds[j];
                entry[header[j]] = line.substring(se[0], se[1]).trim();
            }
            entries.push(entry);
            //console.log('entry: ', entry);
        }
    }

    return entries;
}


module.exports = {
    constants: constants,
    done: done,
    execPlus: execPlus,
    expected: expectedDeepEqual,
    expApiErr: expApiErr,
    expCliErr: expCliErr,
    ifErr: ifErr,
    makeResourceName: makeResourceName,
    objCopy: objCopy,
    parseOutputUsingHeader: parseOutputUsingHeader,
    partialExp: partialExp,
    parseDockerVersion: parseDockerVersion
};
