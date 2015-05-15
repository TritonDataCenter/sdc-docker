The SDC Docker test suite.

There are two sets of tests here: *unit* tests which can be run in your local
clone (see "test/unit/") and *integration* tests which are run in an SDC
standup. Eventually the latter will include running Docker's own
"integration-cli" tests.


# Usage

Unit tests should be run before commits:

    make test

Or you can run a specific test file via:

    cd test
    ./runtest unit/foo.test.js


Integration tests run from the headnode GZ -- using an LX zone that hosts the
`docker` client the test suites will call. See the "Integration tests design"
section below for why. To run the integration tests use:

    make test-integration-in-coal

It's also possible to run the integration tests on a per-file basis, though you
will need to set the correct environment variables, example:

    FWAPI_URL=http://10.99.99.26 VMAPI_URL=http://10.99.99.27 node ./test/integration/run-ports.test.js


The [nightly](https://jenkins.joyent.us/view/nightly/) test system runs [the
SDC docker tests
nightly](https://jenkins.joyent.us/view/nightly/job/nightly1-095-test-docker/).



# Development Guidelines

- We are using [tape](https://github.com/substack/tape).

- Use "test/lib/\*.js" and "test/{unit,integration}/helpers.js" to help make
  ".test.js" code more expressive:

    1. Put setup-y stuff in those files.
    2. Move logical chunks of testing to functions here with
       the signature `function (t, opts, callback)`, where `t`
       is the test object on which you can assert steps along
       the way.

- Unit tests (i.e. not requiring the full SDC setup) in "unit/\*.test.js".
  Integration tests "integration/\*.test.js".

- When in doubt, follow Rob's style. Structure and style borrows from
  sdc-napi.git's and sdc-fwapi.git's test suites.


# Integration tests design

For most (if not all) integration tests a test will:

1. run one or more `docker ...` client commands to do something
2. test that things worked as expected by doing any of:
    - running more `docker ...` client commands
    - checking internal SDC APIs (sdc-docker admin API, moray, vmapi, etc.)

IOW, we want to be running a `docker` client somewhere. That means running
those commands, and possibly the whole test suite, on Linux -- and presumably
in an LX zone.

Ideal: Our ideal is to have a Docker image including the test suite and builds
of the clients, and run that. Each commit to sdc-docker.git would make a new
"sdc-docker-test" image and publish that to updates.joyent.com. However, at the
time of writing we can't yet build Docker images. When we can we'll reconsider
this option.

Reality: A feasible option right now is to have the test suite (a) create a
generic LX zone (whether a vanilla LX Ubuntu zone, or a docker busybox or
Ubuntu zone is TBD), (b) copy in the docker client with which we'll be testing,
and (c) ssh/zlogin into that zone for each `docker ...` command.
