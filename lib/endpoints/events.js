/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var EventEmitter = require('events').EventEmitter;
var restify = require('restify');
var util = require('util');

var common = require('../common');
var errors = require('../errors');


var queryParser = restify.queryParser({
    allowDots: false,
    mapParams: false,
    plainObjects: false
});


function formatEvent(evt) {
    var dockerEvt = {};

    assert.object(evt, 'evt');
    assert.string(evt.action, 'evt.action');
    assert.string(evt.dockerId, 'evt.dockerId');
    assert.optionalNumber(evt.exitCode, 'evt.exitCode');
    assert.number(evt.timestamp, 'evt.timestamp');

    switch (evt.action) {
        case 'died':
            dockerEvt = {
                status: 'die',
                id: evt.dockerId,
                // Docker 1.13.0 also has: from:"alpine:latest",
                Type: 'container',
                Action: 'die',
                Actor:{
                    ID: evt.dockerId,
                    Attributes: {
                        exitCode: evt.exitCode.toString() //,
                        // Docker 1.13.0 also has -- image: "alpine:latest",
                        // Docker 1.13.0 also has -- name: "fervent_mestorf"
                }
                }, time: Math.floor(evt.timestamp / 1000),
                timeNano: evt.timestamp * 1000000
            };
            break;
        default:
            assert.fail('Unimplemented event action: ' + evt.action);
            break;
    }

    return (dockerEvt);
}


//
// Watch events for a container
//
function EventStreamer(dockerId) {
    var self = this;

    EventEmitter.call(self);

    self.dockerId = dockerId;

    // XXX This is a silly implementation for proof-of-concept.
    //     Obviously it's stupid. It just waits 20 seconds and assumes the
    //     container died with exit code 13. The real implementation should
    //     obviously watch for real events.

    self._timer = setTimeout(function _fakeDeath() {
        self.emit('event', {
            action: 'died',
            dockerId: self.dockerId,
            exitCode: 13,
            timestamp: new Date().getTime(),
        });
    }, 20000);
}

util.inherits(EventStreamer, EventEmitter);

EventStreamer.prototype.shutdown = function shutdown() {
    var self = this;

    clearTimeout(self._timer);
    self.removeAllListeners();
};


//
// GET /events
//
function events(req, res, next) {
    var dockerId;
    var filters;
    var keys;
    var type;

    //
    // Documentation says for type:
    //
    // type=<string> object to filter by, one of container, image, volume,
    // network, or daemon
    //
    // but the value actually used by Docker looks like:
    //
    // filter='{"container":{"<DockerId>":true},"type":{"container":true}}'
    //
    // yuck.
    //

    if (!req.query.filters) {
        return next(new errors.NotImplementedError('events w/o filter'));
    }

    filters = JSON.parse(req.query.filters);

    if (!filters.type) {
        return next(new errors.NotImplementedError('events w/o type'));
    }

    if (filters.type.container !== true) {
        return next(new errors.NotImplementedError(
            'events w/ type other than container'));
    }

    // We're doing a filter on container which is what docker 1.13.0 uses
    // instead of /wait to determine when a container has exited and get the
    // exit status.

    keys = Object.keys(filters.container);
    if (keys.length !== 1) {
        return next(new errors.ValidationError(
            'expected single container filter'));
    }

    dockerId = keys[0];

    // Need to send the header right away so client knows the streamed messages
    // are coming.
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked'
    });
    res.flushHeaders();

    // XXX ugly monkeypatch to work around restify
    //
    // restify thinks it's helpful by trying to set Content-Type. No thanks
    // restify.
    res.setHeader = function _dontSetHeader() {
        console.trace('ignoring setHeader');
    };

    // XXX ugly monkeypatch to work around restify
    //
    // restify also thinks it wants to write the headers, even though we
    // already did. SAD.
    res.writeHead = function _dontWriteHead() {
        console.trace('ignoring writeHead');
    };

    eventStream = new EventStreamer(dockerId);

    req.log.debug({dockerId: dockerId}, 'following eventStream');

    eventStream.on('event', function _sawEvent(evt) {
        res.send(formatEvent(evt));

        if (evt.action === 'died') {
            // done with events, moving on
            req.log.debug({dockerId: dockerId}, 'shutting down eventStream');
            eventStream.shutdown();
            res.end();
            next();
        }
    });
}


//
// Register all endpoints with the restify server
//
function register(http, before) {
    http.get({ path: /^(\/v[^\/]+)?\/events$/, name: 'Events' }, before, queryParser, events);
}


module.exports = {
    register: register
};
