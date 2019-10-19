<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# sdc-docker

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md)
and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

SDC Docker is the Docker Engine for Triton, where the data center is exposed
as a single Docker host. The Docker remote API is served from a "docker" core
SDC zone built from this repo.


# User Guide

For users of the Triton service in Joyent's public cloud, or those using
a private SDC Docker stand-up, but not administering it, please see the
[User Guide](./docs/api/README.md).  The rest of this README is targeted at
*development* of sdc-docker.


# Docker Version

Offically supported version: 1.21 (equivalent to docker client version 1.9)

Supported version range:

- Remote API: 1.20 to 1.24
- Docker CLI: 1.8 to 1.12
- Docker Compose: 1.6 to 1.8

When a client makes a remote API call to sdc-docker and it does not specify a
version, then sdc-docker will default to the officially supported version.

Newer clients may continue to work, but until we've tested and marked
a newer version as officially supported, then it's best to use an older
and officially supported version.

Devs: When updating the sdc-docker server official version, you'll need to
be sure to update the following:

1. update both *API_VERSION* and *SERVER_VERSION* version in lib/constants.js
2. update the docker cli test client version in
   globe-theatre/bin/nightly-test-docker-integration-cli


# Current State

Many commands are currently at least partially implemented. See
[docs/divergence.md](./docs/api/divergence.md) for details on where sdc-docker
diverges from Docker Inc's docker.  This software is under active development
to provide parity to the newer Docker features that are relevant to SDC, as
well as to integrate with other new Triton features .


# Installation

Note: Examples in this section are for
[CoaL](https://github.com/joyent/sdc#cloud-on-a-laptop-coal), i.e. some
setup will not be appropriate for a production DC.

1. Installing sdc-docker and supporting services:

        ssh root@10.99.99.7                                 # ssh to the CoaL GZ
        sdcadm self-update
        sdcadm post-setup common-external-nics && sleep 10  # imgapi needs external
        sdcadm post-setup dev-headnode-prov
        sdcadm post-setup dev-sample-data  # sample packages for docker containers
        sdcadm post-setup cloudapi
        sdcadm post-setup docker
        sdcadm experimental update dockerlogger
        # Optional additional steps for VXLAN setup.
        # TODO: This isn't well automated yet.
        #    sdcadm post-setup fabrics ...
        #    <reboot>

For compute nodes added after the first-time setup, you will need to install
the dockerlogger on them by executing:

        sdcadm experimental update dockerlogger --servers ${CN1},${CN2},...

SDC Docker uses (as of [DOCKER-312](https://smartos.org/bugview/DOCKER-312))
TLS by default. That means you need to setup a user (or use the 'admin' user)
and add an SSH key for access.

2. Create a test user (we'll use "jill"):

        # On your dev machine, create a key
        ssh-keygen -t rsa -m PEM -f ~/.ssh/sdc-docker-jill.id_rsa -b 2048 -N ""

        # Copy it to COAL so we can add it to the 'jill' account.
        scp ~/.ssh/sdc-docker-jill.id_rsa.pub root@10.99.99.7:/var/tmp/

        ssh root@10.99.99.7      # ssh to the CoaL GZ
        sdc-useradm create -A login=jill email=jill@localhost userpassword=secret123
        sdc-useradm add-key jill /var/tmp/sdc-docker-jill.id_rsa.pub

3. Generate a client TLS certificate and set `docker` to use `--tls` mode:

    This script in the sdc-docker repo will create the client certificate
    and print how to configure `docker`:

        ./tools/sdc-docker-setup.sh coal jill ~/.ssh/sdc-docker-jill.id_rsa

    This also puts the env setup in "~/.sdc/docker/jill/env.sh".

        source ~/.sdc/docker/jill/env.sh

You should now able to get `docker info` and see "SDCAccount: jill":

    $ docker info
    Containers: 0
    Images: 0
    Storage Driver: sdc
     SDCAccount: jill
    Execution Driver: sdc-0.1.0
    Operating System: SmartDataCenter
    Name: coal

Docker Compose uses different environment variables across different versions
to configure timeout. If you receive any warning about the DOCKER_CLIENT_TIMEOUT
environment variable being deprecated, simply unset it and remove it from env.sh.

# Using custom TLS server certificates for SDC Docker

SDC Docker can optionally be setup to use your own TLS certificates. By
default, the Docker VM is provisioned with a self-signed certificate
that can always be overridden with the following commands:

        # Copy your TLS certificate to the SDC headnode (assuming COAL)
        scp ./my-key.pem root@10.99.99.7:/var/tmp/
        scp ./my-cert.pem root@10.99.99.7:/var/tmp/

        # Install the TLS certificate
        sdcadm experimental install-docker-cert -k /var/tmp/my-key.pem -c /var/tmp/my-cert.pem

This command will automatically restart the SDC Docker service so certificate
changes will take effect immediately. After changing the TLS certificates, you
will need to re-run the ./tools/sdc-docker-setup.sh script.

# Running SDC docker in invite-only mode

The public APIs to an SDC -- sdc-docker and cloudapi -- can be configured to
be in invite-only mode where only explicitly allowed accounts are given
authorized. This mode is configured via the `account_allowed_dcs`
[SDC Application config var](https://github.com/joyent/sdc/blob/master/docs/operator-guide/configuration.md#sdc-application-configuration).

    sdc-sapi /applications/$(sdc-sapi /applications?name=sdc | json -H 0.uuid) \
        -X PUT -d '{"metadata": {"account_allowed_dcs": true}}'
    # Optional "403 Forbidden" response body.
    sdc-sapi /applications/$(sdc-sapi /applications?name=sdc | json -H 0.uuid) \
        -X PUT -d '{"metadata": {"account_allowed_dcs_msg": "talk to your Administrator"}}'

Once enabled, one can allow an account via:

    DC=$(sh /lib/sdc/config.sh -json | json datacenter_name)
    sdc-useradm add-attr LOGIN allowed_dcs $DC

and an account access removed via:

    sdc-useradm delete-attr LOGIN allowed_dcs $DC

Allowed users can be listed via:

    sdc-useradm search allowed_dcs=$DC -o uuid,login,email,allowed_dcs

For example:

    [root@headnode (coal) ~]# sdc-useradm add-attr admin allowed_dcs coal
    Added attribute on user 930896af-bf8c-48d4-885c-6573a94b1853 (admin): allowed_dcs=coal

    [root@headnode (coal) ~]# sdc-useradm search allowed_dcs=coal -o uuid,login,email,allowed_dcs
    UUID                                  LOGIN  EMAIL           ALLOWED_DCS
    930896af-bf8c-48d4-885c-6573a94b1853  admin  root@localhost  ["us-west-2","coal"]

    [root@headnode (coal) ~]# sdc-useradm delete-attr admin allowed_dcs coal
    Deleted attribute "allowed_dcs=coal" from user 930896af-bf8c-48d4-885c-6573a94b1853 (admin)

Limitation: Currently adding access can take a minute or two to take effect
(caching) and removing access **requires the sdc-docker server to be
restarted (DOCKER-233).**


# Adding packages

By default the size of the container (ram, disk, cpu shares) uses the package in
the internal `sdc_` set of packages closest to 'ram=1024 MiB'. The `sdc_`
packages are really only applicable for development. More appropriate for
production is a set of packages separate from `sdc_`. The following can be
run to add a number of `sample-*` packages and to configure the Docker service
to use them:

    # In the headnode global zone:
    sdcadm post-setup dev-sample-data
    /opt/smartdc/bin/sapiadm update \
       $(/opt/smartdc/bin/sdc-sapi /services?name=docker | json -H 0.uuid) \
       metadata.PACKAGE_PREFIX="sample-"


# Configurations

The SDC Docker service can be configured with the following Service API
(SAPI) metadata values.

| Key                            | Type    | Default | Description                                                                  |
| ------------------------------ | ------- | ------- | ----------- |
| **USE_TLS**                    | Boolean | false   | Turn on TLS authentication. |
| **DEFAULT_MEMORY**       | Number | 1024 | The default ram/memory to use for docker containers. |
| **PACKAGE_PREFIX** | String | 'sample-'    | The prefix for packages to use for docker container package selection. |
| **USE_FABRICS**          | Boolean | false   | Provision container internal nic on default fabric network. |
| **ENABLED_LOG_DRIVERS**  | String  | 'json-file,none' | Comma-delimited list of log drivers allowed (see [Log Drivers](./docs/api/features/logdrivers.md)) |

Here is an example of modifying the service configurations with SAPI,

    docker_svc=$(sdc-sapi /services?name=docker | json -Ha uuid)
    sdc-sapi /services/$docker_svc -X PUT -d '{ "metadata": { "USE_TLS": true } }'


# Development hooks

Before commiting be sure to:

    make check      # lint and style checks
    make test       # run unit tests

A good way to do that is to install the stock pre-commit hook in your
clone via:

    make git-hooks


# Testing

As shown above, the run unit tests locally:

    make test

To run *integration* tests, you need to call the "test/runtests" driver from
the *global zone* (GZ) of a SmartDataCenter setup with sdc-docker,
e.g. with COAL that would be:

    ssh root@10.99.99.7
    /zones/$(vmadm lookup -1 alias=docker0)/root/opt/smartdc/docker/test/runtests

specifically for COAL there is a target for that:

    make test-integration-in-coal

To run (a) a particular subset of integration tests -- using 'info' as a filter
on test names in this example -- and (b) with trace-level logging:

    LOG_LEVEL=trace /zones/$(vmadm lookup -1 alias=docker0)/root/opt/smartdc/docker/test/runtests -f info 2>&1 | bunyan

Some integration tests (those that don't depend on running in the GZ) can be
run from your Mac dev tree, e.g.:

    ./test/runtest ./test/integration/cli-info.test.js


By default all "cli" integration tests ("test/integration/cli-\*.test.js") are
run against the latest Docker CLI version (see the
`DOCKER_AVAILABLE_CLI_VERSIONS` variable in "test/runtest.common"). To run
against against other versions, or all supported versions, set the
`DOCKER_CLI_VERSIONS` (plural) environment variable, e.g.:

    make test-integration-in-coal DOCKER_CLI_VERSIONS=all
    make test-integration-in-coal DOCKER_CLI_VERSIONS="1.11.1 1.10.3"
    DOCKER_CLI_VERSIONS=1.11.1 /zones/$(vmadm lookup -1 alias=docker0)/root/opt/smartdc/docker/test/runtests -f cli-info
    DOCKER_CLI_VERSIONS=latest /zones/$(vmadm lookup -1 alias=docker0)/root/opt/smartdc/docker/test/runtests -f cli-labels



# Testing locally

It's also possible to run tests directly from your local development machine,
by specifying the sdc environment and launching node on the test file(s):

    FWAPI_URL=http://10.99.99.26 VMAPI_URL=http://10.99.99.27 node ./test/integration/run-ports.test.js

# Official docker test suite

Docker have their own test suite *integration-cli* for testing a real docker
environment. To run the docker cli tests against coal, you will need a local
docker binary and go (golang) installed, then do the following:

    # Target coal
    export DOCKER_HOST=tcp://my.docker.coal:2376
    export DOCKER_TEST_HOST=$DOCKER_HOST

    # Set go path, so `go get` works correctly
    mkdir go && cd go
    export GOPATH=`pwd`

    # Checkout docker from git
    mkdir -p src/github.com/docker
    cd src/github.com/docker
    git clone https://github.com/docker/docker.git
    cd docker

    # Build docker test infrastructure.
    sh hack/make/.go-autogen   # docker automated build files
    # If `go get` shows an error - just ignore it.
    go get ./...               # docker dependencies

    cd integration-cli

    # Run an individual test
    go test -test.run "^TestPsListContainers"

    # Run all tests - this will take forever... a specific test will be faster.
    go test -v


# Development from your Mac

1. Add a 'coal' entry to your '~/.ssh/config'. Not required, but we'll use this
   as a shortcut in examples below.

        Host coal
            User root
            Hostname 10.99.99.7
            ForwardAgent yes
            StrictHostKeyChecking no
            UserKnownHostsFile /dev/null
            ControlMaster no

2. Get a clone on your Mac:

        git clone git@github.com:joyent/sdc-docker.git
        cd sdc-docker

3. Make changes in your local clone:

        vi

4. Sync your changes to your 'docker0' zone in COAL (see
   [Installation](#installation) above):

        ./tools/rsync-to coal

   This will rsync over changes (excepting binary bits like a change in
   sdcnode version, or added binary node modules) and restart the docker
   SMF service.


For testing I tend to have a shell open tailing the docker service's log file:

    ssh coal
    sdc-login docker
    tail -f `svcs -L docker` | bunyan


# Coding style

You've gotta have one to put to rest some of the bikeshedding. Here's the one
for this repo:

- 4-space indentation

- `camelCase` capitalization for variables. This is within reason -- exceptions
  where case is required due to outside APIs (e.g. Docker APIs) is fine.

- `ClassCase` for classes (i.e. JS prototype'd functions).

- Imports from "lib/models" shall consistently be imported as follows to allow
  grepping for "Link.list", etc.

        var ImageTag = require('.../models/image-tag');
        var Link = require('.../models/link');


## Naming

Some variable/function naming patterns in this repo.

| *Pattern* | *Description* |
| --------- | ------------- |
| `req*`    | A restify handler that operates (primarily) on a request and adds a request param. E.g. `reqClientApiVersion` adds `req.clientApiVersion`. |
