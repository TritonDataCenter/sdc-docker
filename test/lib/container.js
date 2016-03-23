var assert = require('assert-plus');

function checkContainerStatus(containerId, statusPattern, options, callback) {
    assert.string(containerId, 'containerId');
    assert.regexp(statusPattern, 'statusPattern');
    assert.object(options, 'options');
    assert.object(options.helper, 'options.helper');
    assert.object(options.dockerClient, 'options.dockerClient');
    assert.func(callback, 'callback');

    var helper = options.helper;
    var dockerClient = options.dockerClient;

    var retries = options.retries || 10;
    var nbChecksPerformed = 0;

    assert.ok(retries > 0, 'retries must be a positive number');

    function performCheck() {
        ++nbChecksPerformed;

        helper.listContainers({
            all: true,
            dockerClient: dockerClient
        }, function (err, containers) {
            if (err) {
                return callback(err);
            }

            var found = containers.filter(function (c) {
                if (c.Id === containerId) {
                    return true;
                }
            });

            var matched = found[0].Status.match(statusPattern);
            if (matched || nbChecksPerformed >= retries) {
                return callback(null, matched);
            } else {
                performCheck();
            }
        });
    }

    performCheck();
}

module.exports = {
    checkContainerStatus: checkContainerStatus
};
