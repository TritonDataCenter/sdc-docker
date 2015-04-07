<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2015, Joyent, Inc.
-->

# sdc-docker

A Docker Engine for SmartDataCenter, where the data center is exposed
as a single Docker host. The Docker remote API is served from a "docker" core
SDC zone built from this repo.


# User Guide

For users of the beta service in Joyent's public cloud, or those using
an SDC Docker stand up, but not administering it, please see the
[User Guide](./docs/index.md).  The rest of this README is targetted at
*development* of sdc-docker.


# Current State

Many commands are currently at least partially implemented. See
[docs/divergence.md](./docs/divergence.md) for details on where sdc-docker
diverges from Docker Inc's docker.  While Joyent has deployed this into early
access, this software is still under active development and should be used in
production with care.


# Installation

Note: Examples in this section are for
[CoaL](https://github.com/joyent/sdc#cloud-on-a-laptop-coal). However the
only thing CoaL-specific is the IP for the headnode (root@10.99.99.7).
For example, you could do the same on Joyent Engineering's internal
"nightly-1" DC with "root@172.26.1.4".

Installing sdc-docker means getting a running 'docker' SDC core zone.

    ssh root@10.99.99.7                                 # ssh to the CoaL GZ
    sdcadm self-update
    sdcadm post-setup common-external-nics && sleep 10  # imgapi needs external
    sdcadm post-setup dev-headnode-prov
    sdcadm post-setup cloudapi
    sdcadm experimental update-docker

Then setup `DOCKER_*` env vars on your Mac or wherever you have a `docker`
client. **The backticks are required to modify your shell environment.**

    cd sdc-docker  # your clone of this repo
    `./tools/docker-client-env root@10.99.99.7`

Now you should be able to run the docker client:

    $ docker info
    Containers: 0
    Images: 0
    Storage Driver: sdc
    Execution Driver: sdc-0.1
    Kernel Version: 7.x
    Operating System: SmartDataCenter
    Debug mode (server): true
    Debug mode (client): false
    Fds: 42
    Goroutines: 42
    EventsListeners: 0
    Init Path: /usr/bin/docker

If you don't have a `docker` client, see [Docker's installation
instructions](https://docs.docker.com/installation/).


Let's create your first docker container:

    $ docker run -d nginx
    Unable to find image 'nginx:latest' locally
    Pulling repository nginx
    90081fa15a0c: Download complete.
    511136ea3c5a: Download complete.
    d0a18d3b84de: Download complete.
    4d6ce913b130: Download complete.
    b8b06bfad66f: Download complete.
    344f86171557: Download complete.
    c06c31cde4f4: Download complete.
    78bb52b79c8e: Download complete.
    402a3573fdf5: Download complete.
    7ed80e9ad494: Download complete.
    1b436f7d2f5c: Download complete.
    1e9db8768b4c: Download complete.
    9270c8b178a6: Download complete.
    90081fa15a0c: Download complete.
    90081fa15a0c: Status: Downloaded newer image for nginx:latest
    c6c0c650aa41463294000ba997c049c2aafe75b61f124de5a55c46d4a5b04d38

    $ docker ps
    CONTAINER ID        IMAGE               COMMAND                CREATED             STATUS              PORTS               NAMES
    c6c0c650aa41        nginx:latest        "nginx -g daemon off   4 minutes ago       Up 4 minutes                            backstabbing_curie

    # Let's get its IP.
    $ docker inspect --format '{{ .NetworkSettings.IPAddress }}' c6c0c650aa41
    10.88.88.15

    # Then see if nginx is serving:
    $ curl -i http://10.88.88.15
    HTTP/1.1 200 OK
    Server: nginx/1.7.9
    Date: Tue, 27 Jan 2015 23:55:35 GMT
    Content-Type: text/html
    Content-Length: 612
    Last-Modified: Tue, 23 Dec 2014 16:25:09 GMT
    Connection: keep-alive
    ETag: "54999765-264"
    Accept-Ranges: bytes

    <!DOCTYPE html>
    <html>
    <head>
    <title>Welcome to nginx!</title>
    ...

    # Inspect its logs
    $ docker logs backstabbing_curie
    10.88.88.1 - - [27/Jan/2015:23:43:58 +0000] "GET / HTTP/1.1" 200 612 "-" "curl/7.24.0 (x86_64-apple-darwin12.0) libcurl/7.24.0 OpenSSL/0.9.8z zlib/1.2.5" "-"
    10.88.88.1 - - [27/Jan/2015:23:44:17 +0000] "GET / HTTP/1.1" 200 612 "-" "curl/7.24.0 (x86_64-apple-darwin12.0) libcurl/7.24.0 OpenSSL/0.9.8z zlib/1.2.5" "-"


# Running sdc-docker with TLS support

By default *for now*, sdc-docker will run in a non-secure (non-production) mode
with no user authentication. In this mode, there is no notion of users so every
single client call will be assumed to belong to the default SDC local admin user
(`ufds_admin_uuid`). To enable user authentication on sdc-docker we must
complete three steps:

1.  Enable TLS support on sdc-docker

    In order to allow multiple SDC users to interact with sdc-docker, TLS
    support must be activated first. The sdc-docker install contains a sample
    self-signed certificate that should only be used for development/testing.
    The sample key and certificate are located at:

        /opt/smartdc/docker/tls/server-key.pem
        /opt/smartdc/docker/tls/server-cert.pem

    Switch to TLS support by running the following commands:

        ssh root@10.99.99.7                     # ssh to the COAL GZ
        sdcadm self-update
        sdcadm experimental update-docker       # ensure the latest sdc-docker

        docker_svc=$(sdc-sapi /services?name=docker | json -Ha uuid)
        sapiadm update $docker_svc metadata.USE_TLS=true

        # make sure service picks up new configuration
        sdc-login docker 'svcadm restart config-agent' </dev/null && sleep 3
        sdc-login docker netstat -f inet -an | grep 2376

2.  Ensure the docker client user has added SSH keys to their account.

    For development purposes, we are going to add our own SSH private key to
    the local SDC admin user. This step is optional for existing SDC users that
    already have their SSH keys added to UFDS:

        scp ~/.ssh/id_rsa.pub root@10.99.99.7:/var/tmp/id_rsa.pub
        ssh root@10.99.99.7                     # ssh to the COAL GZ
        sdc-useradm add-key admin /var/tmp/id_rsa.pub

3.  Generate a client TLS certificate and set `docker` to use `--tls` mode:

    This script in the sdc-docker repo will create the client certificate
    and print how to configure `docker`:

        ./tools/sdc-docker-setup.sh coal admin ~/.ssh/id_rsa

    For example, something like:

        export DOCKER_CERT_PATH=$HOME/.sdc/docker/admin
        export DOCKER_HOST=tcp://10.88.88.5:2376
        alias docker="docker --tls"

You should now able to get `docker info` and see "SDCAccount: admin":

    $ docker info
    Containers: 0
    Images: 32
    Storage Driver: sdc
     SDCAccount: admin
    Execution Driver: sdc-0.1.0
    Operating System: SmartDataCenter
    Name: coal


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
the internal "sdc_" set of packages closest to 'ram=1024 MiB'. The "sdc_"
packages are really only applicable for development. More appropriate for
production is a set of packages separate from "sdc_". The following can be
run to add a number of "t4-*" packages and to configure the Docker service
to use them:

    sdc-login docker /opt/smartdc/docker/tools/gen_packages.js
    /opt/smartdc/bin/sapiadm update \
       $(/opt/smartdc/bin/sdc-sapi /services?name=docker | json -H 0.uuid) \
       metadata.PACKAGE_PREFIX="t4-"



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

    ./test/runtest ./test/integration/info.test.js


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
