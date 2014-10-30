# sdc-docker

A Docker Engine for SmartDataCenter, where the whole DC is
exposed as a single docker host. The Docker remote API is
served from a 'docker' core SDC zone (built from this repo).


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

Then you should be able to run this on your Mac to get `coaldocker` for
talking to the Docker engine in your COAL, where `docker` here is
the boot2docker client:

    alias coaldocker="DOCKER_TLS_VERIFY= docker -H tcp://$(ssh coal 'vmadm lookup alias=docker0 | xargs -n1 vmadm get | json nics.0.ip'):2375"
    coaldocker version


# Development

FWIW, here is how Trent is doing it.

1. Add a 'coal' entry to your '~/.ssh/config':

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

    for file in $(mls /Joyent_Dev/stor/stuff/docker/ | grep "\-11e4-"); do
        mget -O ${file}
    done

Copy the resulting files to /var/tmp in your COAL and then run:


    cd /var/tmp
    for img in $(ls *.manifest); do
        sdc-imgadm import -m ${img} -f $(basename ${img} .manifest).zfs.gz
    done

to get these images imported into your local imgapi.
