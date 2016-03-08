/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * In Triton some per-VM configuration is controlled via special structured
 * tags on the VM's "tags" object. They are all prefixed with "triton.".
 * Let's call them "Triton tags".
 *
 * Triton tags are all optional.
 *
 * - `triton.cns.disable` (boolean): Can be set on a VM to tell the CNS service
 *   to not serve records for this VM.
 * - `triton.cns.services` (string): Comma-separated list of DNS-name strings
 *   for the CNS service.
 * - `triton.cns.reverse_ptr` (string): DNS reverse pointer for this VM. Used
 *   by the CNS service.
 */

var assert = require('assert-plus');
var format = require('util').format;


/*
 * For now, using the more limited labels allowed by RFC1123. RFC2181 supercedes
 * 1123, but the broader range of characters can sometimes cause problems with
 * other systems (e.g. see the underscore in RFC5321).
 */
var DNS_NAME_RE = /^[a-z0-9][a-z0-9\-]{0,62}(?:\.[a-z0-9][a-z0-9\-]{0,62})*$/i;


var typeFromKey = {
    'triton.cns.services': 'string',
    'triton.cns.disable': 'boolean',
    'triton.cns.reverse_ptr': 'string',

    // Internal testing Triton tags
    'triton._test.string': 'string',
    'triton._test.number': 'number',
    'triton._test.boolean': 'boolean'
};

/*
 * Validator functions take a `val` (already checked to be of the appropriate
 * type per `typeFromKey`) and return an error message if invalid. If valid,
 * null is returned.
 */
var validatorFromKey = {
    'triton.cns.services': function validateTritonCnsServices(val) {
        assert.string(val, 'val');

        var unsafes = [];
        var fqdns = val.split(',');
        for (var i = 0; i < fqdns.length; i++) {
            var fqdn = fqdns[i];
            if (fqdn.length > 255 || !fqdn.match(DNS_NAME_RE)) {
                unsafes.push(fqdn);
            }
        }

        if (unsafes.length > 0) {
            return format(
                'invalid "triton.cns.services" tag: "%s" %s not DNS safe',
                unsafes.join('", "'),
                (unsafes.length === 1 ? 'is' : 'are'));
        }

        return null;
    },

    'triton.cns.disable': function validateTritonCnsDisable(val) {
        assert.bool(val, 'val');

        // In other words, basically a no-op.
        return null;
    },

    'triton.cns.reverse_ptr': function validateTritonCnsReversePtr(val) {
        assert.string(val, 'val');

        if (val.length > 255 || !val.match(DNS_NAME_RE)) {
            return format(
                'invalid "triton.cns.reverse_ptr" tag: "%s" is not DNS safe',
                val);
        }

        return null;
    },

    /*
     * Triton tags used for internal testing.
     */
    'triton._test.string': function validateTritonTestString(val) {
        assert.string(val, 'val');
        return null;
    },
    'triton._test.number': function validateTritonTestNumber(val) {
        assert.number(val, 'val');
        return null;
    },
    'triton._test.boolean': function validateTritonTestBoolean(val) {
        assert.bool(val, 'val');
        return null;
    }
};



// --- exports

/*
 * Return true if the given key uses the Triton tag prefix.
 * Note that it still might not be one of the specific defined tags.
 */
function isTritonTag(key) {
    assert.string(key, 'key');
    const TRITON_TAG_PREFIX = 'triton.';
    return (key.substr(0, TRITON_TAG_PREFIX.length) === TRITON_TAG_PREFIX);
}


/**
 * Parse a Triton tag from the given string value.
 *
 * @param {String} key: The Triton tag key/name.
 * @param {String} str: The tag value to parse.
 * @param {Function} cb: `function (err, val)`
 *      On success, `err` is null and `val` is the parsed and validated
 *      tag value. On failure `err` is an Error instance.
 */
function parseTritonTagStr(key, str, cb) {
    assert.string(key, 'key');
    assert.string(str, 'str');
    assert.func(cb, 'cb');

    // Ensure it is a known triton tag.
    var type = typeFromKey[key];
    if (type === undefined) {
        cb(new Error(format('Unrecognized special triton tag "%s"', key)));
        return;
    }

    // Convert from string to value of appropriate type.
    var val;
    switch (type) {
    case 'string':
        val = str;
        break;
    case 'boolean':
        if (str === 'true') {
            val = true;
        } else if (str === 'false') {
            val = false;
        } else {
            cb(new Error(format(
                'Triton tag "%s" value must be "true" or "false": %j',
                key, str)));
            return;
        }
        break;
    case 'number':
        val = Number(str);
        if (str.length === 0  // Guard against `Number('') === 0` wat.
            || isNaN(val))
        {
            cb(new Error(format('Triton tag "%s" value must be a number: %j',
                key, str)));
            return;
        }
        break;
    default:
        throw new Error('unexpected Triton tag type: ' + type);
    }

    // Validate.
    var validator = validatorFromKey[key];
    assert.func(validator, 'validator for tag ' + key);
    var errmsg = validator(val);

    if (errmsg) {
        cb(new Error(errmsg));
    } else {
        cb(null, val);
    }
}


module.exports = {
    isTritonTag: isTritonTag,
    parseTritonTagStr: parseTritonTagStr
};