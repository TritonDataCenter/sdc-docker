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
    sdcadm post-setup common-external-nics  # imgapi needs external
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
