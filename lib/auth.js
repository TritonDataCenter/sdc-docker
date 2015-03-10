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

var errors = require('./errors');

var fmt = util.format;



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
 * TODO lru-cache with expiry!
 * TODO cache results of _verifyKey
 */
function authTls(req, res, next) {
    var log = req.log;
    var authCache = req.app.authCache;
    var ufds = req.app.ufds;
    var cert = req.connection.getPeerCertificate();

    if (!cert.subject || !cert.subject.CN || !cert.fingerprint
        || !cert.modulus || !cert.exponent) {
        next(new errors.UnauthorizedError());
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
        log.debug('Cached authentication found token for %s', login);
        authenticated = true;
    } else {
        authFunctions.push(getKeys, findValidKey);
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

    function getKeys(_, cb) {
        ufds.listKeys(account, function (err, _keys) {
            if (err) {
                log.info({err: err, login: login, authn: true},
                    'ufds.listKeys err');
                cb(new errors.UnauthorizedError(err));
                return;
            } else if (!_keys.length) {
                log.info({login: login, authn: true}, 'account has no keys');
                cb(new errors.UnauthorizedError());
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

        openssl.exec('rsa', pkcsBuffer, {
            noout: true,
            modulus: true,
            pubin: true
        }, function (err, buffer) {
            if (err) {
                log.warn({err: err, login: login, keyName: sdcKey.name},
                    'openssl rsa failed');
                cb();
                return;
            }

            var sdcKeyModulusMd5 = crypto.createHash('md5')
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
                log.info({err: err, login: login, authn: true},
                    'unexpected _verifyKey err');
                cb(new errors.UnauthorizedError(err));
                return;
            } else if (!authenticated) {
                log.info({login: login, authn: true},
                    'certificate verification failed');
                cb(new errors.UnauthorizedError());
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
