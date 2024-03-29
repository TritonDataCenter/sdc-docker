<!-- markdownlint-disable code-block-style -->

# Docker Remote API implementation for Triton

This document explains how to set up your Docker client tools to manage the
lifecycle of Docker images and containers in Triton's SDC Docker solution.
Some familiarity with Docker is assumed. If you are new to Docker, you
may want to read the [Docker User Guide](https://docs.docker.com/engine/userguide/)
to understand some of the basic concepts before you start using Triton.

SDC, short for SmartDataCenter, works as one big Docker host backed by
the physical infrastructure of the entire data center. Because of this, you
do not have to manage your own hosts. Your Docker client applications only
have to interact with a single API endpoint for a given SDC implementation.

## Connecting to the API

Docker client applications, including the Docker CLI and Docker Compose, can connect to the SDC Docker remote API endpoint to launch and control Docker containers across an entire Triton data center.

Connecting to the API requires an account on the Triton data center, SSH key, and the CloudAPI URL for that data center, as well as the Docker CLI or some other Docker client. If you have your `triton` cli client configured, run:

    eval "$(triton env -d)"

### Docker version

SDC Docker supports clients using Docker Remote API v1.20 to 1.24. For the Docker CLI, this includes Docker v1.8 to 1.12.

You can see the version of your currently installed Docker CLI:

```bash
$ docker --version
Docker version 1.8.1, build d12ea79
```

Please [install or upgrade](https://docs.docker.com/installation/#installation) the Docker CLI if you do not have it or have an older version.

### API endpoint

Each data center is a single Docker API endpoint. [CloudAPI](https://apidocs.tritondatacenter.com/cloudapi/) is used as a helper to configure the client to connect to the Docker Remote API. Determining the correct CloudAPI URL depends on which data center you're connecting to.

See your cloud provider's documentation or operator(s) for the CloudAPI endpoint.

### User accounts, authentication, and security

User accounts in Triton require one or more SSH keys. The keys are used to identify and secure SSH access to containers and other resources in Triton.

SDC Docker uses Docker's TLS authentication scheme both to identify the requesting user and secure the API endpoint. The SDC Docker helper script will generates a TLS certificate using your SSH key and write it to a directory in your user account.

### The helper script

The 'sdc-docker-setup.sh' script will help pull everything together and configure Docker clients.

Download the script:

```bash
curl -O https://raw.githubusercontent.com/TritonDataCenter/sdc-docker/master/tools/sdc-docker-setup.sh
```

Now execute the script, substituting the correct values:

```bash
bash sdc-docker-setup.sh <CLOUDAPI_URL> <ACCOUNT_USERNAME> ~/.ssh/<PRIVATE_KEY_FILE>
```

Possible values for `<CLOUDAPI_URL>` include MNX's data centers
which are hosting Triton or another CloudAPI, e.g. one running in a [Cloud on a
Laptop (CoaL)](https://github.com/TritonDataCenter/triton#cloud-on-a-laptop-coal) development
VMware VM.

| CLOUDAPI_URL | Description |
| ------------ | ----------- |
| `https://us-central-1.api.mnx.io` | MNX us-central-1 data center. |
| coal | Special name to indicate the CloudAPI in a development CoaL VMware VM |

For example, if you created an account on
[MNX's hosted Triton service](https://my.mnx.io), with the
username "jill", SSH key file `~/.ssh/sdc-docker.id_rsa`, and connecting to the
US-Central-1 data center:

```bash
bash sdc-docker-setup.sh https://us-central-1.api.mnx.io jill ~/.ssh/sdc-docker.id_rsa
```

That should output something like the following:

```bash
Setting up Docker client for SDC using:
        CloudAPI:        https://us-central-1.api.mnx.io
        Account:         jill
        Key:             /Users/localuser/.ssh/sdc-docker.id_rsa

If you have a pass phrase on your key, the openssl command will
prompt you for your pass phrase now and again later.

Verifying CloudAPI access.
CloudAPI access verified.

Generating client certificate from SSH private key.
writing RSA key
Wrote certificate files to /Users/localuser/.sdc/docker/jill

Get Docker host endpoint from cloudapi.
Docker service endpoint is: tcp://us-central-1.docker.mnx.io:2376

* * *
Success. Set your environment as follows:

        export DOCKER_CERT_PATH=/Users/localuser/.sdc/docker/jill
        export DOCKER_HOST=tcp://us-central-1.docker.mnx.io:2376
        export DOCKER_CLIENT_TIMEOUT=300
        export COMPOSE_HTTP_TIMEOUT=300
        export DOCKER_TLS_VERIFY=1
```

Then you should be able to run 'docker info' and see your account
name 'SDCAccount: jill' in the output.

Run those `export` commands in your shell and you should now be able to
run `docker`:

```bash
$ docker info
Containers: 0
Images: 0
Storage Driver: sdc
 SDCAccount: jill
Execution Driver: sdc-0.3.0
Logging Driver: json-file
Kernel Version: 3.12.0-1-amd64
Operating System: SmartDataCenter
CPUs: 0
Total Memory: 0 B
Name: us-central-1
ID: 65698e31-2754-4e86-9d05-bfc881037812
```

## Troubleshooting API connection problems

See our [guide to common API connection problems](./troubleshooting.md).

## Features

SDC Docker offers a number of features unique to Triton's container-native infrastructure, including:

1. [Placement: automatic placement of containers across the entire data center](features/placement.md).
1. [Networking: one or more real IP addresses for each container](features/networks.md).
1. [Resource allocation: specify RAM, CPU, and storage for each container](features/resources.md).
1. [Volumes: container-native volume management](features/volumes.md).
1. [Private repositories: image repository management](features/repos.md)

## Docker CLI commands and Docker Remote API methods

`docker attach`, `docker build`, `docker commit`, `docker cp`, `docker create`,
`docker exec`, `docker history`, `docker images`, `docker info`, `docker inspect`,
`docker kill`, `docker login`, `docker logout`, `docker logs`, `docker port`,
`docker ps`, `docker pull`, `docker push`, `docker rename`, `docker restart`,
`docker rm`, `docker rmi`, `docker run`, `docker search`, `docker start`,
`docker stop`, `docker tag`, `docker top`, `docker version`, `docker volume`,
`docker wait`

## Divergence

The SDC Docker implementation does have some differences from Docker Inc.'s implementation. See [the full list](divergence.md).
