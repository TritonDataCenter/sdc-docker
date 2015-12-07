/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var compressPorts = require('../../lib/backends/sdc/utils').compressPorts;

var test = require('tape');

var base = mkRangeArray(20, 400)
    .concat(mkRangeArray(800, 1100))
    .concat(mkRangeArray(5000, 5200));

/*
 * Perform a Fisher-Yates shuffle
 */
function shuffle(arr) {
    var curr, tmp, other;

    for (curr = arr.length; curr !== 0; ) {
        other = Math.floor(Math.random() * curr--);
        // Swap the two elements
        tmp = arr[curr];
        arr[curr] = arr[other];
        arr[other] = tmp;
    }

    return arr;
}

/*
 * Create an in-order range of numbers from start to end
 */
function mkRangeArray(start, end) {
    var length = end - start + 1;
    var arr = new Array(length);
    var i, val;
    for (i = 0, val = start; i < length; i++, val++) {
        arr[i] = val;
    }
    return arr;
}


/*
 * A note about these tests: they were initially written for a more complex
 * implementation of compressPorts, so some of them exercise edge cases that
 * the current implementation does not have, since it sorts all of the numbers
 * at the beginning. They are still valid tests though, and may become more
 * relevant again if the implementation changes.
 */
[
    {
        name: 'A single range in increasing order',
        input: [ 1, 2, 3, 4, 5, 6, 7, 8 ],
        result: [ { start: 1, end: 8 } ]
    },
    {
        name: 'A range and two isolated numbers before and after the range',
        input: [ 1, 3, 4, 5, 6, 8 ],
        result: [ 1, { start: 3, end: 6 }, 8 ]
    },
    {
        name: 'A range of a numbers and an isolated number after the range ',
        input: [1, 3, 4, 2, 5, 6, 8, 2, 2, 5],
        result: [ { start: 1, end: 6 }, 8 ]
    },
    {
        name: 'A single element',
        input: [ 1 ],
        result: [ 1 ]
    },
    {
        name: 'Two ranges in a random order with repeated elements',
        input: [ 1, 3, 4, 2, 5, 6, 8, 2, 2, 5, 3, 3, 9, 1 ],
        result: [ { start: 1, end: 6 }, { start: 8, end: 9 } ]
    },
    {
        name: 'Range with no input elements whose neighbours are one away',
        input: [ 1, 3, 5, 7, 9, 11, 2, 10, 4, 8, 6, 20 ],
        result: [ { start: 1, end: 11 }, 20 ]
    },
    {
        name: 'Shuffled range',
        input: shuffle(mkRangeArray(20, 400)),
        result: [ { start: 20, end: 400 } ]
    },
    {
        name: '2 different ranges shuffled',
        input: shuffle(mkRangeArray(20, 400).concat(mkRangeArray(800, 1100))),
        result: [ { start: 20, end: 400 }, { start: 800, end: 1100 } ]
    },
    {
        name: '3 different ranges shuffled',
        input: shuffle(base),
        result: [ { start: 20, end: 400 }, { start: 800, end: 1100 },
            { start: 5000, end: 5200 } ]
    },
    {
        name: '3 ranges repeated 4 times and shuffled',
        input: shuffle(base.concat(base).concat(base).concat(base)),
        result: [ { start: 20, end: 400 }, { start: 800, end: 1100 },
            { start: 5000, end: 5200 } ]
    }
].forEach(function (run) {
    test(run.name, function (t) {
        t.deepEquals(compressPorts(run.input), run.result);
        t.end();
    });
});
