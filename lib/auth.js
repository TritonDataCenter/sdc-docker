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
 *
 * Auth errors:
 * - All *authn* errors should return:
 *      new errors.UnauthorizedError([cause])
 *   Note that we explicitly override the restify.UnauthorizedError to force
 *   always having the same error body.
 * - All *authz* errors should return:
 *      new errors.ForbiddenError([cause], [message])
 *
 * Logging: All authn errors are logged with `authn: true` at INFO level
 * or above. The `msg` field is the reason auth failed. E.g.:
 *      log.info({login: login, authn: true}, 'login not found');
 * and all authz errors with `authz: true`:
 *      log.info({login: login, authz: true}, 'allowed_dcs ...');
 */

var assert = require('assert-plus');
var crypto = require('crypto');
var KeyAPI = require('keyapi');
var restify = require('restify');
var openssl = require('openssl-wrapper');
var util = require('util');
var vasync = require('vasync');
var sshpk = require('sshpk');
var sshpkUtils = require('sshpk/lib/utils');

var errors = require('./errors');

var fmt = util.format;

function authTls(req, res, next) {
    var log = req.log;
    var authCache = req.app.authCache;
    var ufds = req.app.ufds;

    var peerCert = req.connection.getPeerCertificate();
    if (!peerCert || !peerCert.raw) {
        next(new errors.UnauthorizedError());
        return;
    }

    var cert = sshpk.parseCertificate(peerCert.raw, 'x509');
    var peerKey = cert.subjectKey;
    var peerKeyFp = peerKey.fingerprint('sha512').toString();

    var account;
    var ufdsKey;
    var login = cert.subjects[0].cn;
    var authFunctions = [ getMainAccount ];

    if (authCache.get(login) && authCache.get(login) === peerKeyFp) {
        log.debug('Cached authentication found token for %s', login);
    } else {
        authFunctions.push(getKey, verifyKey);
    }

    // No support for account subusers at the moment
    function getMainAccount(_, cb) {
        ufds.getUser(login, function (err, u) {
            if (err) {
                if (err.restCode === 'ResourceNotFound') {
                    log.info({login: login, authn: true}, 'login not found');
                } else {
                    log.info({err: err, login: login, authn: true},
                        'ufds.getUser err');
                }
                cb(new errors.UnauthorizedError(err));
                return;
            }

            account = u;
            cb();
        });
    }

    function getKey(_, cb) {
        var fp = peerKey.fingerprint('md5').toString('hex');
        ufds.getKey(account, fp, function (err, key) {
            if (err) {
                log.info({err: err, login: login, authn: true},
                    'ufds.getKey err');
                cb(new errors.UnauthorizedError(err));
                return;
            }
            ufdsKey = key;
            cb();
        });
    }

    function verifyKey(_, cb) {
        var key;
        try {
            key = sshpk.parseKey(ufdsKey.pkcs);
        } catch (err) {
            log.error({err: err, login: login, key: ufdsKey.fingerprint},
                'failed to parse pkcs key from UFDS');
            cb(new errors.UnauthorizedError());
            return;
        }
        /*
         * Double-check with the SHA512 hash of the key, to prevent MD5
         * collisions from breaking our authentication.
         */
        if (key.fingerprint('sha512').matches(peerKey)) {
            authCache.set(login, peerKeyFp);
            cb();
        } else {
            log.info({login: login, authn: true},
                'certificate verification failed');
            cb(new errors.UnauthorizedError());
        }
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
            req.log.info({err: err, authn: true}, 'malformed auth token');
            next(new errors.UnauthorizedError(err));
        } else if (tokobj.expires
            && (Date.now() > new Date(tokobj.expires).getTime()))
        {
            req.log.info({tokobj: tokobj, authn: true}, 'auth token expired');
            next(new errors.UnauthorizedError());
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
                log.info({login: 'admin', authn: true},
                    'admin login not found');
            } else {
                log.info({login: 'admin', err: err, authn: true},
                    'ufds.getUser err');
            }
            next(new errors.UnauthorizedError(err));
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
    var datacenterName = config.datacenterName;
    var accountAllowedDcs = config.account_allowed_dcs;
    var forbiddenMsg = 'Forbidden';
    if (config.account_allowed_dcs_msg) {
        forbiddenMsg += fmt(' (%s)', config.account_allowed_dcs_msg);
    }

    return function reqAuth(req, res, next) {
        // authz
        function authzAndFinish(err) {
            if (req.account) {
                /**
                 * If the server is configured to check (accountAllowedDcs),
                 * then ensure the account has an `allowed_dcs` that includes
                 * this DC.
                 */
                var allowed_dcs = req.account.allowed_dcs;
                if (accountAllowedDcs
                    && (
                        !allowed_dcs
                        || (Array.isArray(allowed_dcs)
                            ? allowed_dcs.indexOf(datacenterName) === -1
                            : allowed_dcs !== datacenterName)
                    ))
                {
                    req.log.info({account: req.account.uuid,
                        login: req.account.login, authz: true,
                        dc: datacenterName, allowed_dcs: allowed_dcs},
                        'allowed_dcs does not include this dc');
                    next(new errors.ForbiddenError(forbiddenMsg));
                }

                /**
                 * If an account is disabled, prevent it from using sdc-docker.
                 */
                var disabled = req.account.disabled;
                if (disabled === 'true' || disabled === true) {
                    req.log.info({account: req.account.uuid,
                        login: req.account.login, authz: true },
                        'account is disabled');
                    next(new errors.ForbiddenError(forbiddenMsg));
                }

                req.log = req.log.child({account: req.account.uuid,
                    login: req.account.login}, true);
            }

            next(err);
        }

        // authn
        if (req.header('x-auth-token')) {
            authXToken(keyapi, req, res, authzAndFinish);
        } else if (useTls) {
            authTls(req, res, authzAndFinish);
        } else {
            /*
             * PERF: We *could* use a timed lru-cache to avoid reloading the
             * admin user on every request, but this is a dev-only code path
             * so low priority.
             */
            getAdminAccount(req, res, authzAndFinish);
        }
    };
}


module.exports = {
    auth: auth
};
