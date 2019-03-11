/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/* BEGIN JSSTYLED */
/*
 * Copyright 2019 Joyent, Inc.
 *
 * Container affinity support (i.e. the rules/hints for deciding to what
 * server a new container is provisioned). Parses affinity strings into an
 * affinity format sdc-designation understands.
 *
 * The goal is to provide the affinity features that Docker Swarm provides
 * with its "affinity" container filters, described here:
 *      https://docs.docker.com/swarm/scheduler/filter/#how-to-write-filter-expressions
 * The other Swarm filters are ignored. See DOCKER-630 for discussion.
 *
 * # Affinity types
 *
 * There are three affinity axes in the Swarm docs:
 *
 * - *container affinity*: Specify to land on the same or different server
 *   as an existing container(s).
 *      docker run -e affinity:container==db0 ...
 *      docker run --label 'com.docker.swarm.affinities=["container==db0"]' ...
 *
 * - *label affinity*: Specify to land on the same or different server as
 *   existing containers with a given label key/value.
 *      docker run --label role=webhead ...     # the starter container
 *      docker run -e affinity:role==webhead ...
 *      docker run --label 'com.docker.swarm.affinities=["role==webhead"]' ...
 *
 * - *image affinity*: Specify to land on a node with the given image.
 *      docker run -e affinity:image==redis ...
 *      docker run --label 'com.docker.swarm.affinities=["image==redis"]' ...
 *   Note: We will skip this one. For Triton an image is present on all nodes
 *   in the DC. Until a possible future when Triton acts as a Swarm master
 *   for multiple DCs, the semantics of this affinity don't apply.
 */
/* END JSSTYLED */

var assert = require('assert-plus');
var format = require('util').format;
var strsplit = require('strsplit');
var vasync = require('vasync');

var common = require('../../common');
var errors = require('../../errors');


// ---- globals

var FILTER_KEY_RE = /^[a-z_][a-z0-9\-_.]+$/i;

/*
 * Filter values can have the following chars:
 * - alphanumeric: a-z, A-Z, 0-9
 * - plus any of the following characters: `-:_.*()/?+[]\^$|`
 *
 * The Swarm docs and code do not agree, so it is hard to divine the intent
 * other than "pretty loose".
 *
 * Dev Note: This regex differs from the Swarm one in expr.go to fix some issues
 * (e.g. it looks to me like Swarm's regex usage is in error that it allows
 * a leading `=` because the surrounding parsing code parses out the full
 * operator already) and accomodate slight parsing differences (e.g. this code
 * parses off a leading `~` or `!` or `=` from the operator before using this
 * regex).
 */
// JSSTYLED
var FILTER_VALUE_RE = /^[-a-z0-9:_\s.*/()?+[\]\\^$|]+$/i;


// ---- internal support stuff

/* BEGIN JSSTYLED */
/**
 * Parse out affinities from a Docker container config.
 *
 * Compare to Swarm's processing for pulling from Env and Labels,
 * storing `Labels['com.docker.swarm.affinities']`:
 *    https://github.com/docker/swarm/blob/4ff0b10/cluster/config.go
 *
 * *Side-Effect*:
 * - This removes 'affinity:*' entries from `container.Env`.
 * - If affinities are provided in `container.Env` then
 *   `container.Labels['com.docker.swarm.affinities']` is updated with them.
 *
 * @throws {errors.ValidationError} if a given affinity label or envvar
 *      is invalid.
 */
/* END JSSTYLED */
function _affinitiesFromContainer(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.container, 'opts.container');

    var affinityStrs = [];

    // Labels, e.g.: { 'com.docker.swarm.affinities': '["a==b"]' }
    var labels = opts.container.Labels;
    if (labels && labels['com.docker.swarm.affinities']) {
        affinityStrs = affinityStrs.concat(
            _affinityStrsFromLabel(labels['com.docker.swarm.affinities']));
    }

    // Env, e.g.: [ 'affinity:foo==bar' ]
    var env = opts.container.Env;
    var envIdxToDel = [];
    var i, kv, parts;
    if (env) {
        for (i = 0; i < env.length; i++) {
            kv = env[i];
            if (kv.slice(0, 9) === 'affinity:') {
                parts = strsplit(kv, ':', 2);
                affinityStrs.push(parts[1]);
                envIdxToDel.push(i);
            }
        }
    }

    // Parse the expressions.
    var affinities = [];
    for (i = 0; i < affinityStrs.length; i++) {
        affinities.push(_parseFilterExpr(affinityStrs[i]));
    }

    // Side-effects.
    if (envIdxToDel.length > 0) {
        envIdxToDel.reverse().forEach(function (idx) {
            opts.container.Env.splice(idx, 1);
        });
        labels['com.docker.swarm.affinities'] = JSON.stringify(affinityStrs);
    }

    return affinities;
}


/**
 * Parse a Swarm filter expression.
 * https://github.com/docker/swarm/blob/ee28008f/scheduler/filter/expr.go
 *
 * The underlined part is the expression:
 *
 *      docker run -e affinity:container==db0 ...
 *                             ^^^^^^^^^^^^^^
 *      docker run --label 'com.docker.swarm.affinities=["container==db0"]' ...
 *                                                        ^^^^^^^^^^^^^^
 *
 * A parsed filter expression string is an object like this:
 *      {
 *          key: '<the key string>',        // e.g. 'container'
 *          operator: <'==' or '!='>,
 *          value: '<the value string>',
 *          isSoft: <true or false>,
 *          valueType: <'exact', 'glob' or 're'>,
 *          valueRe: <RegExp for `value`>   // only defined if valueType==='re'
 *      }
 *
 * @throws {errors.ValidationError} if a given expression string is invalid.
 */
function _parseFilterExpr(s) {
    var expr = {};
    var operators = ['==', '!='];
    // JSL doesn't like a `return` in a `for`-loop.
    // jsl:ignore
    for (var i = 0; i < operators.length; i++) {
        // jsl:end
        var idx = s.indexOf(operators[i]);
        if (idx === -1) {
            continue;
        }
        expr.key = s.slice(0, idx);
        if (!FILTER_KEY_RE.test(expr.key)) {
            throw new errors.ValidationError(format(
                'invalid key in filter expression: %j: %j does not match %s',
                s, expr.key, FILTER_KEY_RE));
        }
        expr.operator = operators[i];
        expr.value = s.slice(idx + expr.operator.length);
        if (expr.value.length > 0 && expr.value[0] === '~') {
            expr.isSoft = true;
            expr.value = expr.value.slice(1);
        } else {
            expr.isSoft = false;
        }
        if (!FILTER_VALUE_RE.test(expr.value)) {
            throw new errors.ValidationError(format(
                'invalid value in filter expression: %j: %j does not match %s',
                s, expr.value, FILTER_VALUE_RE));
        }
        if (expr.value.length >= 3 && expr.value[0] === '/'
            && expr.value[expr.value.length - 1] === '/')
        {
            expr.valueType = 're';
        } else if (expr.value.indexOf('*') !== -1) {
            expr.valueType = 'glob';
        } else {
            expr.valueType = 'exact';
        }
        return expr;
    }
    throw new errors.ValidationError(format(
        'could not find operator in filter expression: '
        + 'expected one of %s: %j', operators.join(', '), s));
}

/**
 * Parse an affinity string from a `docker run` "com.docker.swarm.affinities"
 * label.
 *
 * @throws {errors.ValidationError} if there is an error parsing.
 */
function _affinityStrsFromLabel(label) {
    assert.string(label, 'label');

    var affinityStrs;
    try {
        affinityStrs = JSON.parse(label);
    } catch (parseErr) {
        throw new errors.ValidationError(format(
            'invalid affinities label: %j: %s', label, parseErr));
    }

    if (!Array.isArray(affinityStrs)) {
        throw new errors.ValidationError(
            'affinities label is not an array: ' + label);
    }

    return affinityStrs;
}


// ---- exports

/**
 * Parse affitinies for a VMAPI CreateVm payload from Docker Swarm
 * "Env" and "Labels" affinity entries, if any, in a "docker run" API call.
 *
 * *Side-effects*:
 * - This *removes* affinity entries from `container.Env`.
 * - If affinities are provided in `container.Env` then
 *   `container.Labels['com.docker.swarm.affinities']` is updated with them.
 * Docker Swarm does the same.
 *
 * Swarm affinities can identify containers by id, id-prefix, name, name glob,
 * name regex, or via tag matches. They looks like the following:
 *      container<op><value>
 *      <tag><op><value>
 * where <op> is one of `==`, `!=`, `==~`, or `!=~` (`~` means a "soft"
 * affinity -- non-fatal if cannot match); and <value> can be a plain string
 * (exact match), a glob (simple '*'-only globbing), or a regexp (re2 syntax).
 * E.g.:
 *      container==1a8dae2f-d352-4340-8122-ae76b70a47bd
 *      container==1a8dae2fd352
 *      container!=db0
 *      container==db*
 *      container==/^db\d+$/
 *      flav!=staging
 *      role==/^web/
 *
 * @param {Function} cb: `function (err, parsedAffinities)` called back with
 *      one of: `err` is an Error instance if there was a problem; or err and
 *      affinity not set if there were no affinities; or `affinity` is set to
 *      an array of parsed affinity objects which sdc-designation understands.
 */
function affinityFromContainer(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.container, 'opts.container');
    assert.func(cb, 'cb');

    var log = opts.log;

    try {
        var affinities = _affinitiesFromContainer(opts);
    } catch (affErr) {
        cb(affErr);
        return;
    }

    log.debug({affinities: affinities}, 'affinityFromContainer: affinities');
    cb(null, affinities);
}


module.exports = {
    affinityFromContainer: affinityFromContainer
};
