module.exports = {

    // The docker server version reported for 'docker version'.
    SERVER_VERSION: '1.9.0',

    // The docker remote API version reported for 'docker version', and also
    // the default API version assumed when a client does not specify a version.
    API_VERSION: '1.21',

    // The minimum remote API version supported - clients using a version less
    // than this will be rejected. Can be null, which means there is no
    // minimum version.
    MIN_API_VERSION: '1.20',

    // The maximum remote API version supported - clients using a version
    // greater than this will be rejected. Can be null, which means there is
    // no maximum version.
    MAX_API_VERSION: null
};
