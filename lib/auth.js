/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 * Copyright 2021 Alex Wilson
 * Copyright 2023 MNX Cloud, Inc.
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


/**
 * This function is responsible for authentication for the docker service. It
 * parses the given key/fingerprints and compares them to what we have stored
 * in UFDS for the user account, and if successful saves the account object
 * onto the restify request object.
 */

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
    var lookupFp = peerKey.fingerprint('md5').toString('hex');

    /*
     * As well as a simple self-signed certificate for an actual account key,
     * we also accept a certificate for a different key that is validly signed
     * by an account key.
     *
     * If the user is using one of these new types of certificates, enforce
     * the expiry time and use the issuer's CN to look up the real account
     * key.
     */
    if (cert.purposes && cert.purposes.indexOf('joyentDocker') !== -1) {
        log.trace('found "joyentDocker" certificate purpose, will treat as '
            + 'new-style certificate');

        if (cert.isExpired()) {
            /*
             * It's ok to tell the client details about this error -- we aren't
             * telling them about anything in the DB, just about the cert they
             * sent to us.
             */
            next(new errors.UnauthorizedError('Client certificate expired'));
            return;
        }

        if (!cert.subjects[0].equals(cert.issuer)) {
            var fp;
            try {
                fp = sshpk.parseFingerprint(cert.issuer.cn);
                if (fp.algorithm === 'md5') {
                    lookupFp = fp.toString('hex');
                } else {
                    log.info('CN= fingerprint in issuer was not MD5');
                    fp = undefined;
                }
            } catch (e) {
                log.info({err: e}, 'failed to parse CN= fingerprint in issuer');
            }
            if (fp === undefined) {
                next(new errors.UnauthorizedError('Client certificate is not '
                    + 'self-signed, and the issuer DN could not be parsed'));
                return;
            }
        }
    }

    var account;
    var ufdsKey;
    var adminRoleMembers;
    var login = cert.subjects[0].cn;
    var authFunctions = [ getMainAccount, getAdminRole ];

    if (authCache.get(login) && authCache.get(login) === peerKeyFp) {
        log.debug('Cached authentication found token for %s', login);
    } else {
        authFunctions.push(getKey, getAdminRoleKeys, verifyKey);
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

    function getAdminRole(_, cb) {
        var roleFilter = '(&(objectclass=sdcaccountrole)(name=administrator))';
        ufds.listRoles(account.uuid, roleFilter, function (err, rs) {
            if (err) {
                cb();
                return;
            }

            var adminRole = rs[0];
            if (!adminRole || !adminRole.uniquememberdefault) {
                cb();
                return;
            }

            var members = adminRole.uniquememberdefault;
            if (!Array.isArray(members)) {
                members = [members];
            }

            adminRoleMembers = members;
            cb();
        });
    }

    function getKey(_, cb) {
        ufds.getKey(account, lookupFp, function (err, key) {
            if (err) {
                log.info({err: err, login: login, authn: true},
                    'ufds.getKey err');
                cb();
                return;
            }
            ufdsKey = key;
            cb();
        });
    }

    function getAdminRoleKeys(_, cb) {
        if (ufdsKey || !adminRoleMembers) {
            cb();
            return;
        }

        vasync.forEachParallel({
            func: getUserKey,
            inputs: adminRoleMembers
        }, cb);

        function getUserKey(dn, ccb) {
            /*
             * Note scope: one not sub, the DN might be an account rather
             * than a sub-user, and we don't want its sub-user's keys.
             */
            ufds.search(dn, {
                scope: 'one',
                filter: '(&(fingerprint=' + lookupFp + ')'
                    + '(objectclass=sdckey))'
            }, function (err2, userKeys) {
                if (err2) {
                    ccb(err2);
                    return;
                }
                if (userKeys[0] && userKeys[0].pkcs) {
                    ufdsKey = userKeys[0];
                }
                ccb();
            });
        }
    }

    function verifyKey(_, cb) {
        if (!ufdsKey) {
            log.info({login: login, authn: true}, 'key not found');
            cb(new errors.UnauthorizedError());
            return;
        }

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
         * Check the actual signature on the certificate -- this will prevent
         * MD5 collisions from authing the key in the self-signed case,
         * and will do the actual validation in the account-key-signed case.
         */
        if (cert.isSignedByKey(key)) {
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
