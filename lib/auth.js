/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * sdc-docker authentication (authn) and authorization (authz).
 */

var assert = require('assert-plus');
var crypto = require('crypto');
var KeyAPI = require('keyapi');
var restify = require('restify');
var openssl = require('openssl-wrapper');
var vasync = require('vasync');



/*
 * This is a sample certificate as parsed by node TLS. We will authorize
 * the user by finding the corresponding UFDS user by their certificate CN
 * (login/username), compute the modulus and exponent of their SSH public
 * key to their parsed certificate's modulus and exponent.
 *
 * { subject:
 *    { C: 'CA',
 *      ST: 'BC',
 *      L: 'Vancouver',
 *      O: 'Joyent',
 *      CN: 'foo',
 *      emailAddress: 'foo@bar.com' },
 *   issuer:
 *    { C: 'CA',
 *      ST: 'BC',
 *      L: 'Vancouver',
 *      O: 'Joyent',
 *      CN: 'foo',
 *      emailAddress: 'foo@bar.com' },
 *   modulus: 1234',
 *   exponent: '00',
 *   valid_from: 'Feb 11 19:31:38 2015 GMT',
 *   valid_to: 'Feb 11 19:31:38 2016 GMT',
 *   fingerprint: 'AA:BB:CC:DD:EE:FF' }
 *
 * TODO lru-cache with expiry
 * TODO cache results of _verifyKey
 */
function authTls(req, res, next) {
    var log = req.log;
    var authCache = req.app.authCache;
    var ufds = req.app.ufds;
    var cert = req.connection.getPeerCertificate();

    if (!cert.subject || !cert.subject.CN || !cert.fingerprint
        || !cert.modulus || !cert.exponent) {
        next(new restify.UnauthorizedError());
        return;
    }

    var modulus = 'Modulus=' + cert.modulus;
    var certModulusMd5 = crypto.createHash('md5').update(modulus).digest('hex');

    var account;
    var authenticated = false;
    var keys;
    var login = cert.subject.CN;
    var authFunctions = [ getMainAccount ];

    if (authCache[login] && authCache[login] === certModulusMd5) {
        log.info('Cached authentication found token for %s', login);
        authenticated = true;
    } else {
        authFunctions.push(getKeys, findValidKey);
    }

    // No support for account subusers at the moment
    function getMainAccount(_, cb) {
        ufds.getUser(login, function (err, u) {
            if (err) {
                if (err.restCode === 'ResourceNotFound') {
                    log.info('UFDS.getUser found no account for %s', login);
                } else {
                    log.trace({err: err}, 'UFDS.getUser error for %s', login);
                }

                cb(new restify.UnauthorizedError());
                return;
            }

            account = u;
            cb();
        });
    }

    function getKeys(_, cb) {
        ufds.listKeys(account, function (err, _keys) {
            if (err) {
                log.trace({err: err}, 'UFDS.listKeys error for %s', login);
                cb(err);
                return;
            } else if (!_keys.length) {
                log.info('UFDS.listKeys no keys found for %s', login);
                cb(new restify.UnauthorizedError());
                return;
            }

            keys = _keys;
            cb();
        });
    }

    function _verifyKey(sdcKey, cb) {
        if (authenticated) {
            cb();
            return;
        }

        var pkcsBuffer = new Buffer(sdcKey.pkcs.trim());
        var sdcKeyModulusMd5;

        openssl.exec('rsa', pkcsBuffer, {
            noout: true,
            modulus: true,
            pubin: true
        }, function (err, buffer) {
            if (err) {
                if (!(err instanceof Error)) {
                    log.error('_verifyKey() failed for account %s, key %s: %s',
                        login, sdcKey.name, err);
                    err = new restify.UnauthorizedError();
                }
                cb(err);
                return;
            }

            sdcKeyModulusMd5 = crypto.createHash('md5')
                            .update(buffer.toString().trim()).digest('hex');

            authenticated = (sdcKeyModulusMd5 === certModulusMd5);
            cb();
        });
    }

    function findValidKey(_, cb) {
        vasync.forEachPipeline({
            func: _verifyKey,
            inputs: keys
        }, function (err) {
            if (err) {
                cb(err);
                return;
            } else if (!authenticated) {
                log.info('Certificate verification failed for %s', login);
                cb(new restify.UnauthorizedError());
                return;
            }

            authCache[login] = certModulusMd5;
            cb();
        });
    }

    vasync.pipeline({ funcs: authFunctions }, function (err) {
        if (err) {
            next(err);
            return;
        }

        req.account = account;
        next();
    });
}


function authXToken(keyapi, req, res, next) {
    keyapi.detoken(req.header('x-auth-token'), function (err, tokobj) {
        if (err || !tokobj) {
            req.log.info(err, 'malformed auth token');
            next(new restify.UnauthorizedError());
        } else if (tokobj.expires
            && (Date.now() > new Date(tokobj.expires).getTime()))
        {
            req.log.info({tokobj: tokobj}, 'auth token expired');
            next(new restify.UnauthorizedError());
        } else {
            req.app.ufds.getUser(tokobj.account.login,
                    function getInfo(ufdsErr, account) {
                if (ufdsErr) {
                    return next(ufdsErr);
                }
                req.account = account;
                next();
            });
        }
    });
}


/*
 * sdc-docker's "admin-only" mode for development. All images/containers will
 * belong to the admin user since there is no authentication from the client
 */
function getAdminAccount(req, res, next) {
    var log = req.log;
    var ufds = req.app.ufds;

    ufds.getUser('admin', function (err, u) {
        if (err) {
            if (err.restCode === 'ResourceNotFound') {
                log.info('UFDS.getUser found no account for admin');
            } else {
                log.trace({err: err}, 'UFDS.getUser error for admin');
            }

            next(new restify.UnauthorizedError());
            return;
        }

        req.account = u;
        next();
    });
}



// ---- exports

/**
 * Return restify middleware function that handles authn/authz. This
 * will set `req.account` or response with 401 Unauthorized.
 *
 * - Token auth if there is a x-auth-token header, else
 * - TLS auth if the server is configured useTls=true, else
 * - every request is 'admin' account (for non-production dev/testing)
 *
 * @param config {Object} The sdc-docker app config.
 * @param log {Bunyan Logger}
 */
function auth(config, log) {
    assert.object(config, 'config');
    assert.object(log, 'log');

    var useTls = config.useTls;
    var keyapi = new KeyAPI({log: log, ufds: config.ufds});

    return function reqAuth(req, res, next) {

        function updateReqLogAndFinish(err) {
            if (req.account) {
                req.log = req.log.child(
                    {account: req.account.uuid, login: req.account.login},
                    true);
            }
            next(err);
        }

        if (req.header('x-auth-token')) {
            authXToken(keyapi, req, res, updateReqLogAndFinish);
        } else if (useTls) {
            authTls(req, res, updateReqLogAndFinish);
        } else {
            /*
             * PERF: We *could* use a timed lru-cache to avoid reloading the
             * admin user on every request, but this is a dev-only code path
             * so low priority.
             */
            getAdminAccount(req, res, updateReqLogAndFinish);
        }
    };
}


module.exports = {
    auth: auth
};
