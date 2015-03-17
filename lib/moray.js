/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Moray API convenience wrappers
 */

var assert = require('assert-plus');
var async = require('async');
var restify = require('restify');
var util = require('util');


// --- Helpers

/**
 * Turn a value into an array, unless it is one already.
 */
function arrayify(obj) {
    if (typeof (obj) === 'object') {
        return obj;
    }

    if (obj === '') {
        return [];
    }

    return obj.split(',');
}


/**
 * Returns true if the hash is empty
 */
function hashEmpty(hash) {
    /* jsl:ignore (for unused variable warning) */
    for (var k in hash) {
        return false;
    }
    /* jsl:end */

    return true;
}


// --- Exports



/**
 * Creates an LDAP filter based on the parmeters in inObj, only allowing
 * searching by indexes in bucket.schema.index
 *
 * @param inObj {Object}
 * @param bucket {Bucket schema object}
 */
function ldapFilter(inObj, bucket) {
    if (!inObj) {
        return '';
    }

    if (typeof (inObj) === 'string') {
        return inObj;
    }

    if (hashEmpty(inObj)) {
        return '';
    }

    if (inObj.hasOwnProperty('filter') && typeof (inObj.filter === 'string')) {
        return inObj.filter;
    }

    var filterBy = [];
    if (Array.isArray(inObj)) {
        filterBy.push('(|');
        inObj.forEach(function (_inObj) {
            filterBy.push(ldapFilter(_inObj, bucket));
        });
        filterBy.push(')');
        return filterBy.join('');
    }

    filterBy = Object.keys(inObj).reduce(function reduce(arr, i) {

        if (bucket && !bucket.schema.index.hasOwnProperty(i)) {
            // XXX: should error out here if trying to search by a non-indexed
            // property
            return arr;
        }

        // Comma-separated values: turn them into a list
        if (typeof (inObj[i]) === 'string' && inObj[i].indexOf(',') !== -1) {
            /* JSSTYLED */
            inObj[i] = inObj[i].split(/\s*,\s*/);
        }

        if (typeof (inObj[i]) === 'object') {
            arr.push('(|');
            for (var j in inObj[i]) {
                if (typeof (inObj[i][j]) === 'number') {
                    arr.push(util.format('(%s=%d)', i, inObj[i][j]));
                } else {
                    // XXX: allow this outside of arrays?
                    if (inObj[i][j].substr(0, 1) === '!') {
                        arr.push(util.format('(!(%s=%s))', i,
                            inObj[i][j].substr(1)));
                    } else {
                        arr.push(util.format('(%s=%s)', i, inObj[i][j]));
                    }
                }
            }
            arr.push(')');

        } else {
            arr.push(util.format('(%s=%s)', i, inObj[i]));
        }

        return arr;
    }, []);

    if (filterBy.length > 1) {
        filterBy.unshift('(&');
        filterBy.push(')');
    }

    return filterBy.join('');
}


/**
 * Initializes a bucket in moray
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param callback {Function} `function (err, netObj)`
 */
function initBucket(moray, bucket, callback) {
    assert.object(moray, 'moray');
    assert.object(bucket, 'bucket');
    assert.string(bucket.desc, 'bucket.desc');
    assert.string(bucket.name, 'bucket.name');
    assert.object(bucket.schema, 'bucket.schema');
    assert.number(bucket.version, 'bucket.version');

    moray.getBucket(bucket.name, function (err, oldBucket) {
        if (err) {
            if (err.name === 'BucketNotFoundError') {
                moray.log.info(bucket.schema, 'initBucket: creating bucket %s',
                    bucket.name);
                return moray.createBucket(bucket.name, bucket.schema,
                    function (err2, res) {
                        if (err2) {
                            moray.log.error(err2,
                                'initBucket: error creating bucket %s',
                                bucket.name);
                        } else {
                            moray.log.info(bucket.schema,
                                'initBucket: successfully created bucket %s',
                                bucket.name);
                        }

                        return callback(err2, res);
                });
            }

            moray.log.error(err, 'initBucket: error getting bucket %s',
                bucket.name);
            return callback(err);
        }

        var prevVersion = oldBucket.options.version;
        if (prevVersion >= bucket.version) {
            moray.log.info({ bucketName: bucket.name, schema: bucket.schema,
                oldVersion: prevVersion, version: bucket.version },
                'initBucket: bucket version '
                + 'already up to date: not updating');
            return callback();
        }

        moray.log.info('initBucket: bucket %s needs to be updated',
            bucket.name);
        bucket.schema.options = { version: bucket.version };

        moray.updateBucket(bucket.name, bucket.schema, { noCache: true },
        function (err3) {
            if (err3) {
                moray.log.error(err3, 'Error updating bucket %s', bucket.name);
                return callback(err3);
            }

            reindexBucket(moray, bucket, function (idxErr) {
                if (idxErr) {
                    moray.log.error(idxErr, 'Error reindexing bucket %s',
                        bucket.name);
                    return callback(idxErr);
                }

                moray.log.info('initBucket: successfully reindexed %s bucket',
                    bucket.name);
                return callback(null, true);
            });
        });
    });
}


/**
 * Reindexes all objects in the bucket if it has been updated
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param callback {Function} `function (err)`
 */
function reindexBucket(moray, bucket, callback) {
    assert.object(moray, 'moray');
    assert.object(bucket, 'bucket');
    assert.string(bucket.desc, 'bucket.desc');
    assert.string(bucket.name, 'bucket.name');
    assert.object(bucket.schema, 'bucket.schema');
    assert.number(bucket.version, 'bucket.version');

    var rowsPerCall = 100;
    var processed = rowsPerCall;

    async.whilst(
        function () { return processed > 0; },
        function (cb) {
            moray.reindexObjects(bucket.name, rowsPerCall, { noCache: true },
            function (err, res) {
                if (err) {
                    return cb(err);
                }

                processed = res.processed;
                cb();
            });
        },
        callback
    );
}


/**
 * Deletes an object from moray
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param key {String}
 * @param callback {Function} `function (err, netObj)`
 */
function delObj(moray, bucket, key, callback) {
    moray.delObject(bucket.name, key, function (err) {
        if (err && err.name === 'ObjectNotFoundError') {
            return callback(new restify.ResourceNotFoundError(err,
                '%s not found', bucket.desc));
        }

        return callback(err);
    });
}


/**
 * Gets an object from moray
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param key {String}
 * @param callback {Function} `function (err, netObj)`
 */
function getObj(moray, bucket, key, callback) {
    moray.getObject(bucket.name, key, function (err, res) {
        if (err) {
            if (err.name === 'ObjectNotFoundError') {
                return callback(new restify.ResourceNotFoundError(err,
                    '%s not found', bucket.desc));
            }

            return callback(err);
        }

        return callback(null, res);
    });
}


/**
 * Lists objects in moray
 *
 * @param opts {Object}
 * - `filter` {String}
 * - `log` {Bunyan Logger}
 * - `moray` {MorayClient}
 * - `name` {String}
 * - `bucket` {Bucket schema object}
 * - `network_uuid`: Network UUID (required)
 * - `sort` {Object}
 * @param callback {Function} `function (err, netObj)`
 */
function listObjs(opts, callback) {
    var listOpts = {};
    var results = [];

    if (opts.sort) {
        listOpts.sort = opts.sort;
    }

    var filter = ldapFilter(opts.filter, opts.bucket) || opts.defaultFilter;
    opts.log.trace({ params: opts.filter }, 'LDAP filter: "%s"', filter);

    var req = opts.moray.findObjects(opts.bucket.name,
        filter, listOpts);

    req.on('error', function _onListErr(err) {
        return callback(err);
    });

    req.on('record', function _onListRec(rec) {
        opts.log.trace(rec, 'record from moray');
        results.push(opts.model ? new opts.model(rec.value) : rec);
    });

    req.on('end', function _endList() {
        return callback(null, results);
    });
}


/**
 * Updates an object in moray
 *
 * @param opts {Object}
 * - `moray` {MorayClient}
 * - `bucket` {Bucket schema object}
 * - `key` {String} : bucket key to update
 * - `remove` {Boolean} : remove all keys in val from the object (optional)
 * - `replace` {Boolean} : replace the object in moray with val (optional)
 * - `val` {Object} : keys to update in the object
 * @param callback {Function} `function (err, netObj)`
 */
function updateObj(opts, callback) {
    // XXX: should assert opts.* here
    if (opts.replace) {
        return opts.moray.putObject(opts.bucket.name, opts.key, opts.val,
            function (err2) {
            if (err2) {
                return callback(err2);
            }

            // Return an object in similar form to getObject()
            return callback(null, { value: opts.val });
        });
    }

    getObj(opts.moray, opts.bucket, opts.key, function (err, res) {
        if (err) {
            return callback(err);
        }

        for (var k in opts.val) {
            if (opts.remove) {
                delete res.value[k];
            } else {
                res.value[k] = opts.val[k];
            }
        }

        opts.moray.putObject(opts.bucket.name, opts.key, res.value,
            function (err2) {
            if (err2) {
                return callback(err2);
            }

            return callback(null, res);
        });
    });
}


/**
 * Converts an array to a scalar value suitable for indexed fields in
 * moray, since array types can't be indexed on properly.
 */
function arrayToVal(arr) {
    return ',' + arr.join(',') + ',';
}


/**
 * Converts an moray indexed array value as returned by arraytoVal() to a
 * real array object.
 */
function valToArray(params, key) {
    if (!params.hasOwnProperty(key)) {
        return;
    }

    if (typeof (params[key]) === 'object') {
        return;
    }

    if (params[key] === ',,') {
        delete params[key];
        return;
    }
    /*JSSTYLED*/
    params[key] = arrayify(params[key].replace(/^,/, '').replace(/,$/, ''));
}



module.exports = {
    arrayToVal: arrayToVal,
    delObj: delObj,
    filter: ldapFilter,
    getObj: getObj,
    initBucket: initBucket,
    listObjs: listObjs,
    updateObj: updateObj,
    valToArray: valToArray
};
