/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

/**
 * `docker volume create <opts.args>`
 */
function cliCreateVolume(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.user, 'opts.user');
    assert.optionalObject(opts.t, 'opts.t');
    assert.optionalString(opts.args, 'opts.args');

    var t = opts.t;
    var command = [
        'volume create'
    ];
    var user = opts.user;

    if (opts.args) {
        command.push(opts.args);
    }

    user.docker(command.join(' '), function (err, stdout, stderr) {
        if (t) {
            t.ifErr(err, 'docker volume create ' + opts.args);
        }

        callback(err, stdout, stderr);
    });
}

/**
 * `docker volume rm <opts.args>`
 */
function cliDeleteVolume(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.user, 'opts.user');
    assert.optionalObject(opts.t, 'opts.t');
    assert.string(opts.args, 'opts.args');

    var t = opts.t;
    var user = opts.user;

    user.docker('volume rm ' + opts.args, function (err, stdout, stderr) {
        if (t) {
            t.ifErr(err, 'docker volume rm ' + opts.args);
        }

        callback(err, stdout, stderr);
    });
}

/**
 * `docker volume ls <opts.args>`
 */
function cliListVolumes(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.user, 'opts.user');
    assert.optionalObject(opts.t, 'opts.t');
    assert.optionalString(opts.args, 'opts.args');

    var t = opts.t;
    var listVolumesCommand = 'volume ls';
    var user = opts.user;

    if (opts.args) {
        listVolumesCommand += ' ' + opts.args;
    }

    user.docker(listVolumesCommand, function (err, stdout, stderr) {
        if (t) {
            t.ifErr(err, 'docker volume ls ' + opts.args);
        }

        callback(err, stdout, stderr);
    });
}

/*
 * `docker volume inspect <opts.args>`
 */
function cliInspectVolume(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.user, 'opts.user');
    assert.optionalObject(opts.t, 'opts.t');
    assert.string(opts.args, 'opts.args');

    var t = opts.t;
    var user = opts.user;

    user.docker('volume inspect ' + opts.args, function (err, stdout, stderr) {
        if (t) {
            t.ifErr(err, 'docker volume inspect ' + opts.args);
        }

        callback(err, stdout, stderr);
    });
}

/*
 * Creates a test volume using the docker command "docker volume create". It
 * passes any parameter key/value present in the object "params" as arguments to
 * "docker volume create" as following:
 *
 * docker volume create --name someName --opt argName1=argValue1
 *      --opt argName2=argValue2
 *
 * The key/value for the key "name" in the "params" object is treated
 * differently from other parameters, as it generates a "--name someName"
 * command line parameter, instead of "--opt name=someName".
 *
 * The function callback is called with an error object, the output written on
 * stdout and the output written on stderr.
 */
function createTestVolume(user, params, callback) {
    assert.object(user, 'user');
    assert.object(params, 'params');
    assert.func(callback, 'callback');

    var cmdLineArgs = [];
    var paramName;

    for (paramName in params) {
        if (paramName === 'name') {
            cmdLineArgs.push('--name ' + params[paramName]);
        } else {
            cmdLineArgs.push('--opt ' + paramName + '=' + params[paramName]);
        }
    }

    cliCreateVolume({
        user: user,
        args: cmdLineArgs.join(' ')
    }, callback);
}

function cliDeleteVolumes(user, volumeNames, callback) {
    assert.object(user, 'user');
    assert.arrayOfString(volumeNames, 'volumeNames');
    assert.func(callback, 'callback');

    vasync.forEachParallel({
        func: function _deleteVolume(volumeName, done) {
            cliDeleteVolume({
                user: user,
                args: volumeName
            }, done);
        },
        inputs: volumeNames
    }, callback);
}

/*
 * Deletes all volumes that are in the state 'ready', and calls the function
 * `callback` when done. 'callback' is passed an error object as its first
 * argument if an error occured.
 */
function cliDeleteAllVolumes(user, callback) {
    assert.object(user, 'user');
    assert.func(callback, 'callback');

    var leftoverVolumeNames = [];

    vasync.pipeline({funcs: [
        function listLeftoverVolumes(ctx, next) {
            cliListVolumes({
                user: user
            }, function onVolumesListed(listVolumesErr, stdout, stderr) {
                var outputLines;
                var err;

                if (!listVolumesErr) {
                    outputLines = stdout.trim().split(/\n/);
                    // Remove header from docker volume ls' output.
                    outputLines = outputLines.slice(1);

                    outputLines.forEach(function addLeftoverVolume(line) {
                        var driverAndName = line.trim().split(/\s+/);
                        var volumeName = driverAndName[1];

                        leftoverVolumeNames.push(volumeName);
                    });
                } else {
                    err = listVolumesErr;
                }

                next(err);
            });
        },
        function deleteVolumesFound(ctx, next) {
            cliDeleteVolumes(user, leftoverVolumeNames, next);
        }
    ]}, function cleanupDone(err) {
        callback(err);
    });
}

module.exports = {
    createVolume: cliCreateVolume,
    rmVolume: cliDeleteVolume,
    listVolumes: cliListVolumes,
    inspectVolume: cliInspectVolume,
    createTestVolume: createTestVolume,
    deleteAllVolumes: cliDeleteAllVolumes,
    deleteVolumes: cliDeleteVolumes
};