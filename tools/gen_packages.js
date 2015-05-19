#!/usr/node/bin/node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This is a script to add some linear packages to PAPI.
 * It expects to be run from the GZ on a recent platform.
 */

var child_process = require('child_process');
var execFile = child_process.execFile;
var spawn = child_process.spawn;
var vasync = require('/usr/img/node_modules/vasync/lib/vasync');

// Hardcoded values for all packages
var MAX_SWAP_MULTIPLIER = 4; // max_swap = max_physical_memory * this value
var MAX_LWPS = 4000;

// Table of packages to create
var package_data = [
    {name: "t4-standard-128M",  max_physical_memory: 128,    quota: 3072,    shares: 8},
    {name: "t4-standard-256M",  max_physical_memory: 256,    quota: 6144,    shares: 16},
    {name: "t4-standard-512M",  max_physical_memory: 512,    quota: 12288,   shares: 32},
    {name: "t4-standard-1G",    max_physical_memory: 1024,   quota: 25600,   shares: 64, default: true},
    {name: "t4-standard-2G",    max_physical_memory: 2048,   quota: 51200,   shares: 128},
    {name: "t4-standard-4G",    max_physical_memory: 4096,   quota: 102400,  shares: 256},
    {name: "t4-standard-8G",    max_physical_memory: 8192,   quota: 204800,  shares: 512},
    {name: "t4-standard-16G",   max_physical_memory: 16384,  quota: 409600,  shares: 1024},
    {name: "t4-standard-32G",   max_physical_memory: 32768,  quota: 819200,  shares: 2048},
    {name: "t4-standard-64G",   max_physical_memory: 65536,  quota: 1638400, shares: 4096},
    {name: "t4-standard-96G",   max_physical_memory: 98304,  quota: 2457600, shares: 6144},
    {name: "t4-standard-128G",  max_physical_memory: 131072, quota: 3276800, shares: 8192},
    {name: "t4-standard-160G",  max_physical_memory: 163840, quota: 4096000, shares: 10240},
    {name: "t4-standard-192G",  max_physical_memory: 200704, quota: 4915200, shares: 12288},
    {name: "t4-standard-224G",  max_physical_memory: 229376, quota: 5734400, shares: 14336}
];


function ltrim(str, chars)
{
    chars = chars || '\\s';
    str = str || '';
    return str.replace(new RegExp('^[' + chars + ']+', 'g'), '');
}

function rtrim(str, chars)
{
    chars = chars || '\\s';
    str = str || '';
    return str.replace(new RegExp('[' + chars + ']+$', 'g'), '');
}

function trim(str, chars)
{
    return ltrim(rtrim(str, chars), chars);
}

function checkPackage(name, callback)
{
    execFile('/opt/smartdc/bin/sdc-papi', ['/packages?name=' + name],
        function (err, stdout, stderr) {
            var count;
            var lines;

            if (err) {
                callback(err);
                return;
            }

            lines = stdout.split('\n');
            if (trim(lines[0]) !== 'HTTP/1.1 200 OK') {
                callback(new Error('HTTP code was not 200: ' + trim(lines[0])));
                return;
            }

            lines.forEach(function (line) {
                var key = 'x-resource-count: ';

                if (line.indexOf(key) === 0) {
                    count = Number(line.slice(key.length));
                }
            });

            if (isNaN(count)) {
                callback(new Error('failed to find x-resource-count'));
                return;
            }

            callback(null, count);
            return;
        }
    );
}

function createPackage(pkg, callback)
{
    var child;
    var stdout = '';
    var stderr = '';

    child = spawn('/opt/smartdc/bin/sdc-papi',
        ['/packages', '-X', 'POST', '-d@-']);

    child.stdin.setEncoding = 'utf-8';

    child.stdout.on('data', function (data) {
        stdout += data.toString();
    });

    child.stderr.on('data', function (data) {
        stderr += data.toString();
    });

    child.on('exit', function (code, signal) {
        var lines;
        var uuid;

        if (code !== 0) {
            callback(new Error('non-zero exit: ' + code + ',' + signal));
            return;
        }

        lines = stdout.split('\n');

        if (trim(lines[0]) !== 'HTTP/1.1 201 Created') {
            console.error('While creating ' + pkg.name + ':');
            console.error(stdout);
            console.error(stderr);
            callback(new Error('HTTP code was not 201: '
                + trim(lines[0])));
            return;
        }

        lines.forEach(function _lineProcessor(line) {
            var check_str = 'Location: /packages/';
            if (line.indexOf(check_str) === 0) {
                uuid = trim(line.slice(check_str.length));
            }
        });

        if (uuid) {
            console.error('CREATED ' + uuid + ' ' + pkg.name);
            callback(null, uuid);
            return;
        }

        callback(new Error('failed to find uuid for new package'));
    });

    child.stdin.end(JSON.stringify(pkg, null, 2));
}

function processPackage(pkg, callback)
{
    pkg.active = true;
    pkg.billing_tag = pkg.name;
    pkg.default = !!pkg.default;
    pkg.fss = pkg.shares;
    pkg.max_lwps = MAX_LWPS;
    pkg.max_swap = pkg.max_physical_memory * MAX_SWAP_MULTIPLIER;
    pkg.version = '1.0.0';
    pkg.zfs_io_priority = pkg.shares;

    // we added this only to set the other share values
    delete pkg.shares;

    checkPackage(pkg.name, function (err, count) {
        if (err) {
            callback(err);
            return;
        }

        if (count > 0) {
            console.error('SKIP ' + pkg.name + ' already exists');
            callback(null);
            return;
        }

        createPackage(pkg, callback);
    });
}

function main()
{
    vasync.forEachPipeline({
        func: processPackage,
        inputs: package_data
    }, function (err) {
        if (err) {
            console.error('FAILED to add packages: ' + err.message);
            process.exit(1);
        }
        console.error('SUCCESS');
    });
}

main();
