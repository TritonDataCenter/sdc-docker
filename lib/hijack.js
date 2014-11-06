var assert = require('assert-plus');

HIJACK_ROUTES = {
    'POST': [ new RegExp('\/v1.15\/exec\/[a-z0-9]+\/start') ]
};

function canHjiack(req) {
    var hijackRoutes = HIJACK_ROUTES[req.method];
    if (!hijackRoutes) {
        return false;
    }

    // Should match only one route
    matches = hijackRoutes.filter(function (regex) {
        return regex.test(req.url);
    });

    if (!matches.length) {
        return false;
    }

    return true;
}

function hijack(opts) {
    assert.object(opts.socket, 'opts.socket');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var socket = opts.socket;
    var parser = socket.parser;

    // Stash our original parser functions
    var execute = parser.execute;
    var onincoming = parser.onIncoming;

    var push;
    var incoming;

    // var close = socket._handle.close;
    // socket._handle.close = function() {
    //     log.error('Socket _handle close event with hijack');
    // }

    socket.on('close', function() {
        log.trace('Client connection closed');
    });

    parser.onIncoming = function newIncoming(req, keepalive) {
        if (canHjiack(req)) {
            incoming = req;
        }
        onincoming.apply(this, arguments);
    };

    parser.execute = function cryingInside(d, start, end) {
        var ret = execute.call(this, d, start, end);

        if ((ret instanceof Error) && canHjiack(parser.incoming)) {
            // danger territory
            parser.incoming.upgrade = true;
            return ret.bytesParsed;
        } else {
            log.trace('Skipping hijack');
        }

        return ret;
    };
}

module.exports = {
    hijack: hijack,
    canHjiack: canHjiack
};
