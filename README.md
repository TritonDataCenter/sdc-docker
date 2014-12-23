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

The following shows the state of the various docker commands when talking to
sdc-docker instead of a regular docker host.

## Working and partially-working commands

 * docker create --name=foo64 lx-busybox:0.002 /bin/sh
   * supports -m, -c
   * does not support any other options (especially interactive modes)
 * docker exec
   * supports -i, -t, -d
 * docker history
 * docker images
   * does not filter, fakes 'latest'
 * docker info
 * docker inspect
   * supports inspecting a container
   * supports inspecting an image
 * docker kill
   * only signals supported by node
 * docker pull
   * does not support -a yet
 * docker ps
   * does not filter
 * docker restart
   * supports -t
 * docker rm
   * *ALWAYS* behaves as though -f were passed
   * does not support other options
 * docker rmi
   * does not support -f and --no-prune
 * docker run -d --name=foo lx-busybox:0.002 /bin/sh
   * supports -m, -c
   * does not support any other options (especially interactive modes)
 * docker search
 * docker stop
   * supports -t
 * docker start <id|short-id|name>
   * does not support -a or -i
 * docker version
 * docker wait

## Non-working commands

 * currently none that are implemented but non-working

## Non implemented commands

 * docker attach (DOCKER-4)
   * not implemented
 * docker build
   * not implemented
 * docker commit
   * not implemented
 * docker cp
   * not implemented
 * docker diff
   * not implemented
 * docker events
   * not implemented
 * docker export
   * not implemented
 * docker import
   * not implemented
 * docker load
   * not implemented
 * docker login
   * not implemented
 * docker logout
   * not implemented
 * docker logs
   * not implemented
 * docker port
   * not implemented
 * docker pause (blocked on OS-3455)
   * not implemented
 * docker push
   * not implemented
 * docker save
   * not implemented
 * docker tag
   * not implemented
 * docker top
   * not implemented
 * docker unpause (blocked on OS-3456)
   * not implemented


# Installation

Installing sdc-docker means getting a running 'docker' core zone. This
has been coded into sdcadm as of version 1.3.9:

    [root@headnode (coal) ~]# sdcadm --version
    sdcadm 1.3.9 (master-20141027T114237Z-ge4f2eed)

If you don't yet have a sufficient version, then update:

    sdcadm self-update

Then you can update your 'docker' instance (creating an SAPI service and
first instance if necessary) via:

    sdcadm experimental update-docker

Then set `DOCKER_HOST` (and unset `DOCKER_TLS_VERIFY` for now) on your Mac
(or whever you have a `docker` client):

    $ export DOCKER_TLS_VERIFY=
    $ export DOCKER_HOST=tcp://$(ssh root@10.99.99.7 'vmadm lookup alias=docker0 | xargs -n1 vmadm get | json nics.0.ip'):2375
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


# Development

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

Before commiting be sure to:

    make check


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
