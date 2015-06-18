# SDC Docker client troubleshooting guide

## "Couldn't read ca cert ... ca.pem: no such file or directory"

Your environment is setup to speak to a Docker on SDC

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

## Are you trying to connect to a TLS-enabled daemon without TLS?

You get a "TLS-enabled daemon without TLS" error:

    $ docker info
    FATA[0000] Get http:///var/run/docker.sock/v1.17/info: dial unix /var/run/docker.sock: no such file or directory. Are you trying to connect to a TLS-enabled daemon without TLS


One possibility is that after running sdc-docker-setup.sh, did you run
the `export` and `alias` commands in your shell.

Confirm that the env settings are missing:

    $ echo $DOCKER_CERT_PATH

    $ echo $DOCKER_HOST

    $ alias docker
    -bash: alias: docker: not found

Run the exports and alias for your SDC and account, example:

    $ export DOCKER_CERT_PATH=/Users/localuser/.sdc/docker/jill
    $ export DOCKER_HOST=tcp://165.225.168.25:2376
    $ alias docker="docker --tls"

Result:

    $ docker info
    Containers: 0
    Images: 0
    Storage Driver: sdc
     SDCAccount: jill
    Execution Driver: sdc-0.1.0
    Operating System: SmartDataCenter
    Name: us-east-1
