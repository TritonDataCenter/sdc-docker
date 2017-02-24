/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * Integration tests for 'docker pull'.
 */

var format = require('util').format;
var test = require('tape');

var h = require('./helpers');
var cli = require('../lib/cli');


// --- Tests

test('docker pull', function (tt) {

    tt.test('  setup: alice init', cli.init);


    /**
     * Check for reasonable error messages for some 'docker pull' failures.
     * Some related issues: DOCKER-639, DOCKER-689
     */

    /* BEGIN JSSTYLED */
    /**
     * Docker-docker 1.12:
     *  $ docker pull no-such-repo
     *  Using default tag: latest
     *  Pulling repository docker.io/library/no-such-repo
     *  Error: image library/no-such-repo not found
     *  $ echo $?
     *  1
     *
     * Note that Triton-docker won't have that "Pulling repository ..." line.
     * In Docker-docker, that is from the docker v1 fallback pull attempt.
     * I.e. cruft, IMO.
     *
     * The docker 1.6 client emits the error like this:
     *  time="2017-01-03T21:39:05Z" level=fatal msg="Error: image no-such-repo:latest not found (50e45d88-9b6e-4faa-9f92-56d81f8d27c1)"
     */
    /* END JSSTYLED */
    tt.test('  docker pull no-such-repo', function (t) {
        cli.docker('pull no-such-repo', function (err, stdout, stderr) {
            t.ok(err, 'expect failed pull: ' + err);

            // With Docker 1.6 the error
            t.ok(/Error: image no-such-repo:latest not found/m.test(stderr),
                format('stderr includes "Error: image $name not found", '
                    + 'stdout=%j, stderr=%j', stdout, stderr));
            t.ok(! /unauthorized/i.test(stderr), format('stderr does '
                + '*not* contain "unauthorized", from stderr=%j', stderr));

            t.end();
        });
    });

    /* BEGIN JSSTYLED */
    /**
     * Docker-docker 1.12:
     *  $ docker pull quay.io/no-such-user
     *  Using default tag: latest
     *  Error response from daemon: error parsing HTTP 404 response body: invalid character '<' looking for beginning of value: "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 3.2 Final//EN\">\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server.  If you entered the URL manually please check your spelling and try again.</p>\n"
     *
     * Triton-docker:
     *  $ docker --tls pull quay.io/no-such-user
     *  Using default tag: latest
     *  Error: image quay.io/no-such-user:latest not found (71a0653b...)
     *
     * I think Triton's is an improvement.
     */
    /* END JSSTYLED */
    tt.test('  docker pull quay.io/no-such-user', function (t) {
        cli.docker('pull quay.io/no-such-user',
                function (err, stdout, stderr) {
            t.ok(err, 'expect failed pull: ' + err);

            t.ok(/Error: image quay.io\/no-such-user:latest not found/m
                    .test(stderr),
                format('stderr includes "Error: image $name not found", '
                    + 'stdout=%j, stderr=%j', stdout, stderr));
            t.ok(! /unauthorized/i.test(stderr), format('stderr does '
                + '*not* contain "unauthorized", from stderr=%j', stderr));

            t.end();
        });
    });

    /* BEGIN JSSTYLED */
    /*
     * Docker-docker 1.12:
     *  $ docker pull nope.example.com/nope
     *  Using default tag: latest
     *  Error response from daemon: Get https://nope.example.com/v1/_ping: dial tcp: lookup nope.example.com on 8.8.8.8:53: no such host
     *
     * Triton-docker:
     *  $ docker --tls pull nope.example.com/nope
     *  Using default tag: latest
     *  Error pulling image: (RemoteSourceError) nope.example.com host not found (...)
     */
    /* END JSSTYLED */
    tt.test('  docker pull nope.example.com/nope', function (t) {
        cli.docker('pull nope.example.com/nope',
            function (err, stdout, stderr) {
            t.ok(err, 'expect failed pull: ' + err);

            /* JSSTYLED */
            var pat = /Error pulling image: \(RemoteSourceError\) nope.example.com host not found/m;
            t.ok(pat.test(stderr), format('stderr matches %s, stderr=%j',
                pat, stderr));

            t.end();
        });
    });

});
