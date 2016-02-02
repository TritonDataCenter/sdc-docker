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

var test = require('tape');

var h = require('./helpers');
var cli = require('../lib/cli');



// --- Tests


test('docker pull', function (tt) {

    tt.test('setup: alice init', cli.init);

    /* BEGIN JSSTYLED */
    /**
     * DOCKER-639: Check for reasonable error messages for some 'docker pull'
     * failures.
     *
     *      $ docker pull nope
     *      Using default tag: latest
     *      Error pulling image: (UNAUTHORIZED) access to the requested resource is not authorized (3e95bf10-c14a-11e5-b369-af3866fc219f)
     *
     *      $ docker pull quay.io/nope
     *      Using default tag: latest
     *      Unauthorized error from registry quay.io trying to pull nope (711d1460-c14a-11e5-b369-af3866fc219f)
     */
    /* END JSSTYLED */
    tt.test('docker pull nope (error message)', function (t) {
        cli.docker('pull nope', function (err, stdout, stderr) {
            var unauthorizedCode;
            var unauthorizedMsg;

            /*
             * Actually expect a zero exit status, because `docker pull`s
             * JSON progress protocol doesn't handle communicating an error,
             * AFAIK.
             */
            t.ifError(err, 'expected successful pull');

            unauthorizedCode = /UNAUTHORIZED/.test(stdout);

            //JSSTYLED
            unauthorizedMsg = /access to the requested resource is not authorized/.test(stdout);

            t.ok(unauthorizedCode, 'error code is "UNAUTHORIZED"'
                + (unauthorizedCode ? '' : ', got: ' + stdout));

            t.ok(unauthorizedMsg,
                'error message matches "access ... not authorized"'
                + (unauthorizedMsg ? '' : ', got: ' + stdout));

            t.end();
        });
    });
    tt.test('docker pull quay.io/nope (error message)', function (t) {
        cli.docker('pull quay.io/nope', function (err, stdout, stderr) {
            var unauthorized;

            // expect zero exit status, see above
            t.ifError(err, 'expected successful pull');

            // JSSTYLED
            unauthorized = /Unauthorized error from registry quay.io trying to pull nope/.test(stdout);

            t.ok(unauthorized, 'expected that error is "Unauthorized..."'
                + (unauthorized ? '' : ', got: ' + stdout));
            t.end();
        });
    });
    tt.test('docker pull nope.example.com/nope (error message)', function (t) {
        cli.docker('pull nope.example.com/nope',
            function (err, stdout, stderr) {
            var notFound;

            // expect zero exit status, see above
            t.ifError(err, 'expected successful pull');

            // JSSTYLED
            notFound
                = /\(ENOTFOUND\) nope.example.com host not found/.test(stdout);
            t.ok(notFound, 'error is "ENOTFOUND"'
                + (notFound ? '' : ', got: ' + stdout));
            t.end();
        });
    });

});
