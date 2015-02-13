<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdc-docker

A Docker Engine for SmartDataCenter, where the whole DC is exposed as a single
docker host. The Docker remote API is served from a 'docker' core SDC zone
(built from this repo).


# Current State

Disclaimer: This is still very much alpha. Use at your own risk!

Many commands are currently at least partially implemented. See
[docs/divergence.md](./docs/divergence.md) for details on where sdc-docker
diverges from Docker Inc's docker.


# Installation

Note: Examples in this section are for
[CoaL](https://github.com/joyent/sdc#cloud-on-a-laptop-coal). However the
only thing CoaL-specific is the IP for the headnode (root@10.99.99.7).
For example, you could do the same on Joyent Engineering's internal
"nightly-1" DC with "root@172.26.1.4".

Installing sdc-docker means getting a running 'docker' SDC core zone.

    ssh root@10.99.99.7                     # ssh to the CoaL GZ
    sdcadm self-update
    sdcadm post-setup common-external-nics && sleep 10  # imgapi needs external
    sdcadm post-setup dev-headnode-prov
    sdcadm experimental update-docker

Then setup `DOCKER_*` envvars on your Mac (or whever you have a `docker`
client). **The backticks are required to modify your shell environment.**

    cd .../sdc-docker     # your clone of this repo
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

    # The see if nginx is serving:
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

By default, sdc-docker will run in a non-secure mode with no user
authentication. In this mode, there is no notion of users so every single
client call will be assumed to belong to the default SDC local admin user
(UUID 00000000-0000-0000-0000-000000000000). To enable user authentication
on sdc-docker we must complete four steps:

1) Enable TLS support on sdc-docker
2) Ensure the docker client user has added SSH keys to their account
3) Generate a client TLS certificate
3) Set docker client to --tls mode

1) In order to allow multiple SDC users to interact with sdc-docker, TLS
support must be activated first. The sdc-docker install contains a sample self-signed certificate that should only be used for development/testing.
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
    sdc-login docker
    svcadm restart config-agent && sleep 1
    svcadm restart docker
    netstat -f inet -an | grep 2376
    exit

2) For development purposes, we are going to add our own SSH private key to
the local SDC admin user. This step is optional for existing SDC users that
already have their SSH keys added to UFDS:

    scp ~/.ssh/id_rsa.pub root@10.99.99.7:/var/tmp/id_rsa.pub
    ssh root@10.99.99.7                     # ssh to the COAL GZ
    sdc-useradm add-key admin /var/tmp/id_rsa.pub

3) Now, the docker client must be configured to use TLS by running the
following command on your sdc-docker development install:

    ./tools/gen-client-certificate root@10.99.99.7 ~/.ssh/id_rsa

After following the steps, there is going to be a new client certificate at

    ~/.sdc_docker/cert.pem

4) The 'gen-client-certificate' should print instructions to configure the
docker client to work on TLS mode. After exporting the two environment
variables specified, docker can now be used with the --tls option:

    export DOCKER_CERT_PATH=~/.sdc_docker/
    export DOCKER_HOST=tcp://10.88.88.5:2376

    docker --tls info


# Development hooks

Before commiting be sure to:

    make check      # lint and style checks
    make test       # run unit tests

A good way to do that is to install the stock pre-commit hook in your
clone via:

    make git-hooks


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


For testing I tend to have a shell open tailing the docker

    ssh coal
    sdc-login docker
    tail -f `svcs -L docker` | bunyan
