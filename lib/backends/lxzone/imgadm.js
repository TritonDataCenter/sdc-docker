/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

// getImage() code taken from sdc-cn-agent's lib/imgadm.js

var assert = require('assert');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    execFile = child_process.execFile;
var format = require('util').format;


// ---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


// ---- internal support stuff

function objCopy(obj) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return copy;
}


// ---- main functionality

/**
 * Get the given image.
 *
 * @param {Object} options:
 *      - @param {UUID} uuid - The UUID of the image
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err, image)`
 */
function getImage(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.uuid && UUID_RE.test(options.uuid), 'options.uuid');
    assert.ok(options.log, 'options.log');

    var argv = ['/usr/sbin/imgadm', 'get',  options.uuid];
    var env = objCopy(process.env);
    // Get 'debug' level logging in imgadm >=2.6.0 without triggering trace
    // level logging in imgadm versions before that. Trace level logging is
    // too much here.
    env.IMGADM_LOG_LEVEL = 'debug';
    var execOpts = {
        encoding: 'utf8',
        env: env
    };
    options.log.info('calling: ' + argv.join(' '));
    execFile(argv[0], argv.slice(1), execOpts, function (err, stdout, stderr) {
        if (err) {
            callback(new Error(format(
                'Error getting image %s: %s', options.uuid, stderr.trim())));
            return;
        }
        options.log.info(format(
            'got image %s: stdout=%s stderr=%s',
            options.uuid, stdout.trim(), stderr.trim()));
        var image = JSON.parse(stdout.trim()).manifest;
        callback(null, image);
    });
}

/**
 * Get all the images
 *
 * @param {Object} options:
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err, images)`
 */
function getImages(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.log, 'options.log');

    var argv = ['/usr/sbin/imgadm', 'list', '-j'];
    var execOpts = {
        encoding: 'utf8'
    };
    options.log.info('calling: ' + argv.join(' '));
    execFile(argv[0], argv.slice(1), execOpts, function (err, stdout, stderr) {
        if (err) {
            callback(new Error(format(
                'Error getting images: %s', stderr.trim())));
            return;
        }
        options.log.info(format('got images: stdout=%s stderr=%s',
            stdout.trim(), stderr.trim()));
        var images = JSON.parse(stdout.trim());
        callback(null, images);
    });
}


// ---- exports

module.exports = {
    getImage: getImage,
    getImages: getImages
};
