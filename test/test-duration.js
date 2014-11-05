/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */


var common = require('../lib/common');
var sprintf = require('sprintf').sprintf;
var humanDuration = common.humanDuration;

function testDuration(test) {
    var second = 1;
    var minute = 60;
    var hour = minute * 60;
    var day = hour * 24;
    var week = day * 7;
    var month = day * 30;
    var year = day * 365;

    test.equal(humanDuration(47*second), '47 seconds')
    test.equal(humanDuration(1*minute), 'About a minute')
    test.equal(humanDuration(3*minute), '3 minutes')
    test.equal(humanDuration(35*minute), '35 minutes')
    test.equal(humanDuration(35*minute + 40*second), '35 minutes')
    test.equal(humanDuration(1*hour), 'About an hour')
    test.equal(humanDuration(1*hour + 45*minute), 'About an hour')
    test.equal(humanDuration(3*hour), '3 hours')
    test.equal(humanDuration(3*hour + 59*minute), '3 hours')
    test.equal(humanDuration(3*hour + 60*minute), '4 hours')
    test.equal(humanDuration(24*hour), '24 hours')
    test.equal(humanDuration(1*day + 12*hour), '36 hours')
    test.equal(humanDuration(2*day), '2 days')
    test.equal(humanDuration(7*day), '7 days')
    test.equal(humanDuration(13*day + 5*hour), '13 days')
    test.equal(humanDuration(2*week), '2 weeks')
    test.equal(humanDuration(2*week + 4*day), '2 weeks')
    test.equal(humanDuration(3*week), '3 weeks')
    test.equal(humanDuration(4*week), '4 weeks')
    test.equal(humanDuration(4*week + 3*day), '4 weeks')
    test.equal(humanDuration(1*month), '4 weeks')
    test.equal(humanDuration(1*month + 2*week), '6 weeks')
    test.equal(humanDuration(2*month), '8 weeks')
    test.equal(humanDuration(3*month + 1*week), '3 months')
    test.equal(humanDuration(5*month + 2*week), '5 months')
    test.equal(humanDuration(13*month), '13 months')
    test.equal(humanDuration(23*month), '23 months')
    test.equal(humanDuration(24*month), '24 months')
    test.equal(humanDuration(24*month + 2*week), '2.010959 years')
    test.equal(humanDuration(3*year + 2*month), '3.164384 years')

    test.done();
}

module.exports = {
    "test conversion of elapsed seconds to human-readable duration":
        testDuration
}
