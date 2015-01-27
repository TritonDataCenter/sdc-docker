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

    $ docker run -ti busybox
    Unable to find image 'busybox:latest' locally
    Pulling repository busybox
    4986bf8c1536: Download complete.
    511136ea3c5a: Download complete.
    df7546f9f060: Download complete.
    ea13149945cb: Download complete.
    4986bf8c1536: Download complete.
    4986bf8c1536: Status: Downloaded newer image for busybox:latest
    ... TODO: fill this in


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
