/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var http = require('http');
var net = require('net');
var child_process = require('child_process');
var pty = require('pty.js');
var spawn = child_process.spawn;

var PORT = 2376;
var commands = {};

var server = http.createServer();

// Sample requests:
//
// curl -i 10.99.99.7:1337 -X POST -d '{
//   "User": "",
//   "Privileged": false,
//   "Tty": true,
//   "Container": "96b594bd38ad",
//   "AttachStdin": false,
//   "AttachStderr": true,
//   "AttachStdout": true,
//   "Detach": false,
//   "Cmd": [
//     "ls",
//     "-la"
//   ]
// }' | json
//
// curl -i 10.99.99.7:1337 -X POST -d '{
//   "User": "",
//   "Privileged": false,
//   "Tty": true,
//   "Container": "96b594bd38ad",
//   "AttachStdin": true,
//   "AttachStderr": true,
//   "AttachStdout": true,
//   "Detach": false,
//   "Cmd": [
//     "/bin/sh"
//   ]
// }' | json
//
//
// Run the servers:
//
// - /usr/node/bin/node console.js
// - Then one of the curl commands above
// - Then from another terminal on the headnode:
//      telnet localhost 2376
//

server.on('request', function (req, res) {
    var data = '';

    req.on('data', function (chunk) {
        data += chunk;
    });

    req.on('end', function (chunk) {
        try {
            data = JSON.parse(data);
            // One port per command
            commands[PORT] = data;
            console.log(commands);
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ port: PORT }));
        } catch (e) {
            res.writeHead(409, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({ code: 'InvalidRequest' }));
        }
    });
});


var STREAM_TYPES = {
    stdin: 0,
    stdout: 1,
    stderr: 2
};

/**
 * Write to docker-raw compatible streams
 */
function writeToDockerRawStream(type, stream, data) {
    var streamType = STREAM_TYPES[type];
    var messageSize = data.length;
    var message = new Buffer(8 + messageSize);

    message.writeUInt8(streamType, 0);
    message[1] = 0;
    message[2] = 0;
    message[3] = 0;
    message.writeUInt32BE(messageSize, 4);
    message.write(data.toString(), 8);
    stream.write(message);
}


var tcpServer = net.createServer()

tcpServer.on('connection', function (socket) {
    // We need to translate command.Container into a UUID
    // Replace with your own test container
    var container = '96b594bd-38ad-4c88-8545-3ecc92960457';
    var command = commands[PORT];
    var cmd = '/usr/sbin/zlogin';

    var args = [];

    if (command.AttachStdin && command.Tty) {
        args.push('-t', container);
        args = args.concat(command.Cmd);
        runContainerPtyCommand(command, cmd, args, socket);
    } else {
        args.push(container);
        args = args.concat(command.Cmd);
        runContainerCommand(command, cmd, args, socket);
    }
});

function runContainerCommand(params, cmd, args, socket) {
    console.log('going to spawn: ' + cmd + ' ' + args.join(' '));

    var cmdSpawn = spawn(cmd, args);

    function write(streamType, stream, data) {
        if (params.Tty) {
            stream.write(data);
        } else {
            writeToDockerRawStream(streamType, stream, data);
        }
    }

    if (params.AttachStdin) {
        socket.on('data', function (data) {
            cmdSpawn.stdin.write(data);
        });
    }

    cmdSpawn.stdout.on('data', function (data) {
        write('stdout', socket, data);
    });

    cmdSpawn.stderr.on('data', function (data) {
        write('stderr', socket, data);
    });

    cmdSpawn.on('exit', function (code) {
        console.log('cmdSpawn %s exited with status code %s',
            params.Cmd.join(' '), code);
        socket.end();
    });

    cmdSpawn.on('close', function (code) {
        console.log('cmdSpawn %s closed with status code %s',
            params.Cmd.join(' '), code);
        socket.end();
    });

    cmdSpawn.on('error', function (error) {
        console.log('cmdSpawn threw an error %s', error.toString());
    });
}

function runContainerPtyCommand(params, cmd, args, socket) {
    console.log('going to pty spawn: ' + cmd + ' ' + args.join(' '));

    // No rows/columns for now
    var cmdSpawn = pty.spawn(cmd, args);

    socket.on('data', function (data) {
        cmdSpawn.write(data);
    });

    cmdSpawn.on('data', function (data) {
        socket.write(data);
    });

    cmdSpawn.on('exit', function (code) {
        console.log('cmdSpawn %s closed', params.Cmd.join(' '));
        socket.end();
    });

    cmdSpawn.on('close', function (code) {
        console.log('cmdSpawn %s closed', params.Cmd.join(' '));
        socket.end();
    });
}

server.listen(1337);
tcpServer.listen(PORT);

console.log('HTTP server listening on 1337');
console.log('TCP server listening on %s', PORT);
