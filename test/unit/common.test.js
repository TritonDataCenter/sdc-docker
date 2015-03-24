/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Unit tests for "lib/common.js".
 */

var common = require('../../lib/common');
var sprintf = require('sprintf').sprintf;
var test = require('tape');



// --- Tests

test('humanDuration', function (t) {
    var humanDuration = common.humanDuration;
    var second = 1;
    var minute = 60;
    var hour = minute * 60;
    var day = hour * 24;
    var week = day * 7;
    var month = day * 30;
    var year = day * 365;

    t.equal(humanDuration(47*second), '47 seconds');
    t.equal(humanDuration(1*minute), 'About a minute');
    t.equal(humanDuration(3*minute), '3 minutes');
    t.equal(humanDuration(35*minute), '35 minutes');
    t.equal(humanDuration(35*minute + 40*second), '35 minutes');
    t.equal(humanDuration(1*hour), 'About an hour');
    t.equal(humanDuration(1*hour + 45*minute), 'About an hour');
    t.equal(humanDuration(3*hour), '3 hours');
    t.equal(humanDuration(3*hour + 59*minute), '3 hours');
    t.equal(humanDuration(3*hour + 60*minute), '4 hours');
    t.equal(humanDuration(24*hour), '24 hours');
    t.equal(humanDuration(1*day + 12*hour), '36 hours');
    t.equal(humanDuration(2*day), '2 days');
    t.equal(humanDuration(7*day), '7 days');
    t.equal(humanDuration(13*day + 5*hour), '13 days');
    t.equal(humanDuration(2*week), '2 weeks');
    t.equal(humanDuration(2*week + 4*day), '2 weeks');
    t.equal(humanDuration(3*week), '3 weeks');
    t.equal(humanDuration(4*week), '4 weeks');
    t.equal(humanDuration(4*week + 3*day), '4 weeks');
    t.equal(humanDuration(1*month), '4 weeks');
    t.equal(humanDuration(1*month + 2*week), '6 weeks');
    t.equal(humanDuration(2*month), '8 weeks');
    t.equal(humanDuration(3*month + 1*week), '3 months');
    t.equal(humanDuration(5*month + 2*week), '5 months');
    t.equal(humanDuration(13*month), '13 months');
    t.equal(humanDuration(23*month), '23 months');
    t.equal(humanDuration(24*month), '24 months');
    t.equal(humanDuration(24*month + 2*week), '2.010959 years');
    t.equal(humanDuration(3*year + 2*month), '3.164384 years');

    t.end();
});


test('boolFromQueryParam', function (t) {
    var boolFromQueryParam = common.boolFromQueryParam;

    t.equal(boolFromQueryParam(undefined), false);

    t.equal(boolFromQueryParam(''), false);
    t.equal(boolFromQueryParam(' '), false);
    t.equal(boolFromQueryParam('0'), false);
    t.equal(boolFromQueryParam('no'), false);
    t.equal(boolFromQueryParam('false'), false);
    t.equal(boolFromQueryParam('none'), false);
    t.equal(boolFromQueryParam('No'), false);
    t.equal(boolFromQueryParam('NO'), false);
    t.equal(boolFromQueryParam('nO '), false);
    t.equal(boolFromQueryParam('\t FaLse'), false);
    t.equal(boolFromQueryParam('None'), false);

    t.equal(boolFromQueryParam('true'), true);
    t.equal(boolFromQueryParam('True'), true);
    t.equal(boolFromQueryParam('1'), true);
    t.equal(boolFromQueryParam('yes'), true);
    t.equal(boolFromQueryParam('nope'), true);
    t.equal(boolFromQueryParam('nein'), true);
    t.equal(boolFromQueryParam('nyet'), true);

    t.end();
});
