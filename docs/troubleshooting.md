# SDC Docker Troubleshooting Guide

## "Couldn't read ca cert ... ca.pem: no such file or directory"

Your environment is setup to speak to a SDC Docker

    $ echo $DOCKER_CERT_PATH
    /Users/trentm/.sdc/docker/admin
    $ echo $DOCKER_HOST
    tcp://10.88.88.5:2376
    $ alias docker
    alias docker='docker --tls'

but you get a "ca.pem" failure:

    $ docker info
    FATA[0000] Couldn't read ca cert /Users/trentm/.sdc/docker/admin/ca.pem: open /Users/trentm/.sdc/docker/admin/ca.pem: no such file or director

One possibility is that `DOCKER_TLS_VERIFY` is accidentally set:

    $ echo $DOCKER_TLS_VERIFY
    1

Unset it and try again:

    $ unset DOCKER_TLS_VERIFY
    $ docker info
    Containers: 0
    Images: 33
    Storage Driver: sdc
     SDCAccount: admin
    Execution Driver: sdc-0.1.0
    Operating System: SmartDataCenter
    Name: coal
