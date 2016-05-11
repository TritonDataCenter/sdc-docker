/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/* BEGIN JSSTYLED */
/*
 * Copyright 2016 Joyent, Inc.
 *
 * Container affinity support (i.e. the rules/hints for deciding to what
 * server a new container is provisioned).
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
 *
 * # Affinities -> Locality Hints
 *
 * Triton's feature for a VM creation providing affinity is "locality hints".
 * Therefore we'll be translating given Docker affinities (via both
 * the '-e' envvar syntax and the newer '--label' syntax) to Triton's
 * "locality hints". See here for the locality hints big-theory comment
 * and implementation:
 *      https://github.com/joyent/sdc-designation/blob/master/lib/algorithms/soft-filter-locality-hints.js
 *
 * # Limitations
 *
 * - sdc-designation's locality hints cannot handle mixed strict and non-strict
 *   rules. E.g.:
 *      docker run -e affinity:container==db0 -e 'affinity:container!=db1' ...
 *   To support that we'd need to extend the "locality" data structure format.
 *   Currently we just drop the non-strict rules when hitting this. An
 *   alternative would be to error out.
 */
/* END JSSTYLED */

var assert = require('assert-plus');
var format = require('util').format;
var strsplit = require('strsplit');
var vasync = require('vasync');
var XRegExp = require('xregexp');

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
            expr.valueRe = XRegExp(expr.value.slice(1, -1));
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

function _strFromFilterExpr(expr) {
    return format('%s%s%s%s', expr.key, expr.operator, expr.isSoft ? '~' : '',
        expr.value);
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


/*
 * Find the VM(s) matching the given 'affinity' (parsed by _parseFilterExpr).
 *
 * If `affinity.key === "container"`, the affinity value can be any of:
 * - instance uuid: use that directly
 * - docker id: if at least a 32-char prefix of a docker_id,
 *   then can construct instance UUID from that and use that
 *   directly
 * - short docker id: look up all docker containers by uuid
 * - name: lookup all (not just docker) containers by alias
 * - name glob: lookup all (not just docker) containers by alias
 *   IIUC, Swarm's impl. is just simple globbing: '*'-only
 * - name regex: lookup all (not just docker) containers by
 *   alias.
 *
 * Else `affinity.key` is a tag key:
 * Find any VMs matching that key/value. As above, the value can be an exact
 * value (stringified comparison), glob (simple '*'-only glob) or regex.
 *
 * Dev Note: Annoyingly we prefix docker labels with "docker:label:" on
 * VM.tags. So we search both. Note that this can look obtuse or ambiguious
 * to the docker user if a container has both 'foo' and 'docker:label:foo'
 * VM tags.
 *
 * @param {Object} opts.affinity
 * @param {Object} opts.log
 * @param {UUID} opts.ownerUuid
 * @param {Object} opts.vmapi
 * @param {Object} opts.cache: Used to cache data for repeated calls to this
 *      function for a single `localityFromContainer` call.
 * @param {Function} cb: `function (err, vmUuids)`
 */
function _vmUuidsFromAffinity(opts, cb) {
    assert.object(opts.affinity, 'opts.affinity');
    assert.object(opts.log, 'opts.log');
    assert.uuid(opts.ownerUuid, 'opts.ownerUuid');
    assert.object(opts.vmapi, 'opts.vmapi');
    assert.object(opts.cache, 'opts.cache');
    assert.func(cb, 'cb');

    var aff = opts.affinity;
    var i;
    var log = opts.log;
    var query;
    var vm;
    var vms;


    // A caching version of VMAPI 'ListVms?state=active&owner_uuid=$ownerUuid'.
    var getAllActiveVms = function (vmsCb) {
        if (opts.cache.allActiveVms) {
            vmsCb(null, opts.cache.allActiveVms);
            return;
        }
        opts.vmapi.listVms({
            fields: 'uuid,alias,internal_metadata,docker',
            owner_uuid: opts.ownerUuid,
            state: 'active'
        }, {
            headers: {'x-request-id': log.fields.req_id}
        }, function (err, allActiveVms) {
            if (err) {
                vmsCb(err);
            } else {
                opts.cache.allActiveVms = allActiveVms;
                vmsCb(null, allActiveVms);
            }
        });
    };


    // $tag=$value
    // $tag=$glob
    if (aff.key !== 'container' && aff.valueType !== 're') {
        query = {
            fields: 'uuid,alias,tags',
            owner_uuid: opts.ownerUuid,
            state: 'active',
            predicate: JSON.stringify({
                or: [
                    {eq: ['tag.' + aff.key,              aff.value]},
                    {eq: ['tag.docker:label:' + aff.key, aff.value]}
                ]
            })
        };
        opts.vmapi.listVms(query, {
            headers: {'x-request-id': log.fields.req_id}
        }, function (err, vms_) {
            if (err) {
                cb(err);
                return;
            }
            log.debug({affinity: _strFromFilterExpr(aff), vms: vms_},
                '_vmUuidsFromAffinity');
            var vmUuids = vms_.map(function (vm_) { return vm_.uuid; });
            cb(null, vmUuids);
        });

    // $tag==/regex/
    // Get a all '$key=*'-tagged VMs and post-filter with `valueRe`.
    } else if (aff.key !== 'container' && aff.valueType === 're') {
        query = {
            fields: 'uuid,alias,tags',
            owner_uuid: opts.ownerUuid,
            state: 'active',
            predicate: JSON.stringify({
                or: [
                    {eq: ['tag.' + aff.key,              '*']},
                    {eq: ['tag.docker:label:' + aff.key, '*']}
                ]
            })
        };
        opts.vmapi.listVms(query, {
            headers: {'x-request-id': log.fields.req_id}
        }, function (err, allVms) {
            if (err) {
                cb(err);
                return;
            }
            vms = [];
            for (i = 0; i < allVms.length; i++) {
                vm = allVms[i];

                var tag = vm.tags[aff.key];
                if (tag !== undefined && aff.valueRe.test(tag.toString())) {
                    // Docker labels can only be strings. Triton VM tags can
                    // also be booleans or numbers.
                    vms.push(vm);
                    continue;
                }
                var label = vm.tags['docker:label:' + aff.key];
                if (label !== undefined && aff.valueRe.test(label)) {
                    vms.push(vm);
                    continue;
                }
            }
            log.debug({affinity: _strFromFilterExpr(aff), vms: vms},
                '_vmUuidsFromAffinity');
            var vmUuids = vms.map(function (vm_) { return vm_.uuid; });
            cb(null, vmUuids);
        });

    // container==UUID
    } else if (common.isUUID(aff.value)) {
        assert.equal(aff.key, 'container');
        cb(null, [aff.value]);

    // container==<full 64-char docker id>
    //
    // Given a full 64-char docker id, Docker-docker will skip container
    // *name* matching (at least that's what containers.js#findContainerIdMatch
    // implies). We'll do the same here. Any other length means we need to
    // consider name matching.
    } else if (/^[a-f0-9]{64}$/.test(aff.value)) {
        assert.equal(aff.key, 'container');
        var vmUuid = common.dockerIdToUuid(aff.value);
        opts.vmapi.getVm({
            uuid: vmUuid,
            owner_uuid: opts.ownerUuid,
            fields: 'uuid,alias,state,internal_metadata,docker'
        }, {
            headers: {'x-request-id': log.fields.req_id}
        }, function (err, vm_) {
            if (err && err.statusCode !== 404) {
                cb(err);
            } else if (!err && vm_ && vm_.docker
                && ['destroyed', 'failed'].indexOf(vm_.state) === -1
                && vm_.internal_metadata['docker:id'] === aff.value)
            {
                cb(null, [vmUuid]);
            } else {
                cb(null, []);
            }
        });

    // container=<name>
    // container=<short docker id>
    // container=<name glob> (simple '*'-globbing only)
    // container=<name regex>
    //
    // List all active VMs (non-docker too) and pass to "containers.js"
    // filter function to select a match.
    } else {
        assert.equal(aff.key, 'container');

        vms = [];
        vasync.pipeline({funcs: [
            /*
             * First attempt an exact name (aka alias) match as a quick out,
             * if possible.
             */
            function attemptNameMatch(_, next) {
                if (aff.valueType !== 'exact' && aff.valueType !== 'glob') {
                    next();
                    return;
                }

                opts.vmapi.listVms({
                    fields: 'uuid,alias',
                    owner_uuid: opts.ownerUuid,
                    state: 'active',
                    predicate: JSON.stringify({
                        eq: ['alias', aff.value] // this supports simple glob
                    })
                }, {
                    headers: {'x-request-id': log.fields.req_id}
                }, function (err, vms_) {
                    if (err) {
                        next(err);
                    } else {
                        vms = vms_;
                        next();
                    }
                });
            },

            function fullVmListSearch(_, next) {
                if (vms.length) {
                    // Already got results.
                    next();
                    return;
                }

                getAllActiveVms(function (err, allVms) {
                    if (err) {
                        next(err);
                        return;
                    }

                    switch (aff.valueType) {
                    case 're':
                        // Regex is only on container name, not id.
                        for (i = 0; i < allVms.length; i++) {
                            vm = allVms[i];
                            if (vm.alias && aff.valueRe.test(vm.alias)) {
                                vms.push(vm);
                            }
                        }
                        next();
                        break;
                    case 'glob':
                        // Glob is only on container name, not id.
                        var valueRe = new RegExp(
                            '^' + XRegExp.escape(aff.value) + '$');
                        for (i = 0; i < allVms.length; i++) {
                            vm = allVms[i];
                            if (vm.alias && valueRe.test(vm.alias)) {
                                vms.push(vm);
                            }
                        }
                        next();
                        break;
                    case 'exact':
                        /*
                         * This is a exact name match (preferred) or id prefix.
                         * If there are multiple id-prefix matches, we'll
                         * raise an ambiguity error.
                         */
                        var exactErr;
                        var idPrefixMatches = [];
                        var nameMatch;
                        for (i = 0; i < allVms.length; i++) {
                            vm = allVms[i];
                            if (vm.alias && vm.alias === aff.value) {
                                nameMatch = vm;
                                break;
                            }
                            if (vm.docker
                                && vm.internal_metadata['docker:id']
                                && vm.internal_metadata['docker:id'].indexOf(
                                    aff.value) === 0)
                            {
                                idPrefixMatches.push(vm);
                            }
                        }
                        if (nameMatch) {
                            vms.push(nameMatch);
                        } else if (idPrefixMatches.length > 1) {
                            exactErr = new
                                errors.AmbiguousDockerContainerIdPrefixError(
                                    aff.value, idPrefixMatches);
                        } else if (idPrefixMatches.length === 1) {
                            vms.push(idPrefixMatches[0]);
                        }
                        next(exactErr);
                        break;
                    default:
                        next(new Error('unknown affinity valueType: '
                            + aff.valueType));
                        break;
                    }
                });
            }
        ]}, function (err) {
            if (err) {
                cb(err);
            } else {
                log.debug({affinity: _strFromFilterExpr(aff), vms: vms},
                    '_vmUuidsFromAffinity');
                var vmUuids = vms.map(function (vm_) { return vm_.uuid; });
                cb(null, vmUuids);
            }
        });
    }
}


// ---- exports

/**
 * Calculate "locality" hints for a VMAPI CreateVm payload from Docker Swarm
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
 * Locality hints only speak VM uuids. They look like the following (all
 * fields are optional):
 *      {
 *          strict: <true|false>,
 *          near: [<array of VM uuids>],
 *          far: [<array of VM uuids>]
 *      }
 *
 * Looking up VMs in VMAPI is necessary for the translation.
 * Some failure modes:
 * - VMAPI requests could fail.
 * - No VMs could be found matching the filter, and the affinity is
 *   a strict '=='. (If we didn't fail, then we'd end up setting no `
 *   locality` and the strict affinity would be blithely ignored.)
 *
 * @param {Function} cb: `function (err, locality)` called back with one of:
 *      `err` is an Error instance if there was a problem; or err and locality
 *      not set if there were no affinities; or `locality` is set to a
 *      locality hints object per the sdc-designation spec.
 */
function localityFromContainer(opts, cb) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.vmapi, 'opts.vmapi');
    assert.uuid(opts.ownerUuid, 'opts.ownerUuid');
    assert.object(opts.container, 'opts.container');
    assert.func(cb, 'cb');

    var log = opts.log;

    try {
        var affinities = _affinitiesFromContainer(opts);
    } catch (affErr) {
        cb(affErr);
        return;
    }
    if (affinities.length === 0) {
        cb();
        return;
    }
    log.debug({affinities: affinities}, 'localityFromContainer: affinities');

    /**
     * Limitation: sdc-designation's soft-filter-locality-hints.js can't
     * handle mixed hard (strict) and soft (non-strict) affinities. However,
     * while affinities just mean a specific server or not, we can effectively
     * handle this by just dropping soft affinities if there are hard ones.
     */
    var haveHard = false;
    var haveSoft = false;
    var softAffinities = [];
    var hardAffinities = [];
    for (var i = 0; i < affinities.length; i++) {
        var isSoft = affinities[i].isSoft;
        if (isSoft) {
            haveSoft = true;
            softAffinities.push(affinities[i]);
        } else {
            haveHard = true;
            hardAffinities.push(affinities[i]);
        }
    }
    if (haveHard && haveSoft) {
        log.debug({softAffinities: softAffinities},
            'localityFromContainer: mixed hard and soft affinities: '
            + 'drop soft affinities');
        affinities = hardAffinities;
    }

    var strict = haveHard;
    var near = [];
    var far = [];

    // TODO: Really want forEachParallel with concurrency.
    var cache = {};
    vasync.forEachPipeline({
        inputs: affinities,
        func: function setLocalityFromAff(aff, next) {
            if (aff.key === 'image') {
                log.debug({affinity: aff}, 'ignore "image" affinity');
                next();
            } else {
                _vmUuidsFromAffinity({
                    affinity: aff,
                    log: log,
                    ownerUuid: opts.ownerUuid,
                    vmapi: opts.vmapi,
                    cache: cache
                }, function (err, vmUuids) {
                    if (err) {
                        next(err);
                    } else if (vmUuids.length === 0) {
                        /*
                         * Either we drop the affinity or error out. If
                         * it is a strict '==', then we need to error out
                         * (no server will match). If it is non-strict, or
                         * '!=', then we are fine dropping the affinity.
                         *
                         * See some discussion in DAPI-306.
                         */
                        if (!strict || aff.operator === '!=') {
                            log.debug({affinity: aff},
                                'drop affinity, no matching vms');
                            next();
                        } else if (aff.key !== 'container') {
                            next(new errors.ResourceNotFoundError(format(
                                'no active containers found matching tag '
                                + '"%s=%s" for affinity "%s"',
                                aff.key, aff.value, _strFromFilterExpr(aff))));
                        } else {
                            next(new errors.ResourceNotFoundError(format(
                                'no active containers found matching "%s" '
                                + 'for affinity "%s"',
                                aff.value, _strFromFilterExpr(aff))));
                        }
                    } else {
                        if (aff.operator === '==') {
                            near = near.concat(vmUuids);
                        } else {
                            far = far.concat(vmUuids);
                        }
                        next();
                    }
                });
            }
        }
    }, function (err) {
        if (err) {
            cb(err);
        } else if (!near.length && !far.length) {
            cb();
        } else {
            var locality = {
                strict: strict
            };
            if (near.length > 0) locality.near = near;
            if (far.length > 0) locality.far = far;
            cb(null, locality);
        }
    });
}


module.exports = {
    localityFromContainer: localityFromContainer
};
