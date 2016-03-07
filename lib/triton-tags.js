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

const TRITON_TAG_PREFIX = 'triton.';

var typeFromKey = {
    'triton.cns.services': 'string',
    'triton.cns.disable': 'boolean',
    'triton.cns.reverse_ptr': 'string'
};

/*
 * Validator functions take a `val` (already checked to be of the appropriate
 * type per `typeFromKey`) and should throw an `Error` if invalid. The don't
 * return a value.
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
            throw new Error(format(
                'invalid "triton.cns.services" tag: "%s" %s not DNS safe',
                unsafes.join('", "'),
                (unsafes.length === 1 ? 'is' : 'are')));
        }
    },

    'triton.cns.disable': function validateTritonCnsDisable(val) {
        assert.bool(val, 'val');
    },

    'triton.cns.reverse_ptr': function validateTritonCnsReversePtr(val) {
        assert.string(val, 'val');
        if (val.length > 255 || !val.match(DNS_NAME_RE)) {
            throw new Error(format(
                'invalid "triton.cns.reverse_ptr" tag: "%s" is not DNS safe',
                val));
        }
    }
};


// --- exports

/*
 * Return true if the given key uses the Triton tag prefix.
 * Note that it still might not be one of the specific defined tag
 *
 */
function isTritonTag(key) {
    assert.string(key, 'key');
    return (key.substr(0, TRITON_TAG_PREFIX.length) === TRITON_TAG_PREFIX);
}


/**
 * Validate the given Triton tag key and value. This differs from
 * `validateTritonTagStr` in that the `val` argument should already be of
 * the correct type.
 *
 * @returns {String} On success, the validated value is returned.
 * @throws {Error} if the key is an unknown tag or val is invalid.
 */
function validateTritonTag(key, val) {
    assert.string(key, 'key');

    // Check type.
    var expectedType = typeFromKey[key];
    var actualType = typeof (val);
    if (expectedType === undefined) {
        throw new Error('Unrecognized special triton tag "' + key + '"');
    } else if (expectedType !== actualType) {
        throw new Error(format('Triton tag "%s" must be a %s: %j (%s)',
            key, expectedType, val, actualType));
    }

    var validator = validatorFromKey[key];
    assert.func(validator, 'validator for tag ' + key);
    validator(val);

    return val;
}

/*
 * Convert and validate the given Triton tag string value.
 *
 * @returns {String} On success, the validated value is returned.
 * @throws {Error} if the key is an unknown tag or val is of the wrong type
 *      or is invalid.
 */
function validateTritonTagStr(key, str) {
    assert.string(key, 'key');
    assert.string(str, 'str');

    // Ensure it is a known triton tag.
    var type = typeFromKey[key];
    if (type === undefined) {
        throw new Error('Unrecognized special triton tag "' + key + '"');
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
            throw new Error(format(
                'Triton tag "%s" value must be "true" or "false": %j',
                key, str));
        }
        break;
    case 'number':
        val = Number(str);
        if (isNaN) {
            throw new Error(format('Triton tag "%s" value must be a number: %j',
                key, str));
        }
        break;
    default:
        throw new Error('unexpected Triton tag type: ' + type);
    }

    // Validate.
    var validator = validatorFromKey[key];
    assert.func(validator, 'validator for tag ' + key);
    validator(val);

    return val;
}


module.exports = {
    isTritonTag: isTritonTag,
    validateTritonTag: validateTritonTag,
    validateTritonTagStr: validateTritonTagStr
};