<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdc-docker

A Docker Engine for SmartDataCenter, where the whole DC is
exposed as a single docker host. The Docker remote API is
served from a 'docker' core SDC zone (built from this repo).


# Disclaimer

This is still very much alpha. Use at your own risk!


# Current State

Many commands are currently at least partially implemented. See
docs/divergence.md for details on where sdc-docker diverges from Docker Inc's
docker.


# Installation

Installing sdc-docker means getting a running 'docker' core zone. This
has been coded into sdcadm as of version 1.3.9:

    [root@headnode (coal) ~]# sdcadm --version
    sdcadm 1.3.9 (master-20141027T114237Z-ge4f2eed)

If you don't yet have a sufficient version, then update:

    sdcadm self-update

Then you can update your 'docker' instance (creating an SAPI service and
first instance if necessary) via:

    sdcadm post-setup common-external-nics  # imgapi needs external
    sdcadm experimental update-docker

Then setup `DOCKER_*` envvars on your Mac (or whever you have a `docker`
client):

    # Sets DOCKER_HOST and, for now, unsets DOCKER_TLS_VERIFY.
    # This example is the COAL GZ ssh info. Alternatively you could use
    # "root@172.26.1.4" for the sdc-docker setup on nightly-1.
    $ `./tools/docker-client-env root@10.99.99.7`

Now you should be able to run the docker client:

    $ docker info
    Containers: 0
    Images: 31
    Storage Driver: sdc
    Execution Driver: sdc-0.1
    Kernel Version: 7.x
    Operating System: Joyent Smart Data Center
    Debug mode (server): true
    Debug mode (client): false
    Fds: 42
    Goroutines: 42
    EventsListeners: 0
    Init Path: /usr/bin/docker


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


# Images for hacking

Until we fully support pulling images from a registry I've built 2 images that
I'm using for testing. To get these you can:

    for file in $(mls /Joyent_Dev/public/docker/ | grep "\-11e4-"); do
        mget -O /Joyent_Dev/public/docker/${file}
    done

Copy the resulting files to /var/tmp in your COAL and import them into IMGAPI:

    scp *-11e4-* coal:/var/tmp
    ssh coal
    cd /var/tmp
    for img in $(ls *.manifest); do
        sdc-imgadm import -m ${img} -f $(basename ${img} .manifest).zfs.gz
    done

Then (as of a recent sdc-docker) you should be able to do:

    $ docker create --name=ABC123 lx-busybox32 /bin/sh
    57651723e32949bc967f2640872bae9651385b4254e64a49a320dc82c3d46bbb
    $ ssh coal vmadm list uuid=~5765
    UUID                                  TYPE  RAM      STATE             ALIAS
    57651723-e329-49bc-967f-2640872bae96  LX    512      stopped           ABC123
