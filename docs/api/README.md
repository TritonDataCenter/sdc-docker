# Docker Remote API implementation for Triton

Introductory text. This document assumes some familiarity with Docker....

## Connecting to the API

Docker client applications, including the Docker CLI can connect to the SDC Docker remote API endpoint to launch and control Docker containers across an entire Triton data center.

Connecting to the API requires an account on the Triton data center, SSH key, and the CloudAPI URL for that data center, as well as the Docker CLI or some other Docker client. Joyent provides a helper script to configure a Docker client, including the Docker CLI.

### Docker version

SDC Docker supports clients using Docker Remote API XXX and greater. For the Docker CLI, this includes Docker 1.4.1 and newer.

You can see the version of your currently installed Docker CLI:

```bash
$ docker --version
Docker version 1.4.1, build 5bc2ff8
```

Please [install or upgrade](https://docs.docker.com/installation/#installation) the Docker CLI if you do not have it or have an older version.

### API endpoint

Each data center is a single Docker API endpoint. [CloudAPI](https://apidocs.joyent.com/cloudapi/) is used as a helper to configure the client to connect to the Docker Remote API. Determining the correct CloudAPI URL depends on which data center you're connecting to.

Joyent operates a number of data centers around the world, each has its own CloudAPI endpoint. Please consult the Joyent Elastic Container Service documentation for the correct URL for that service. 

Private cloud implementations will offer different CloudAPI URLs, please consult the private cloud operator for the correct URL.

### User accounts, authentication, and security

User accounts in Triton require one or more SSH keys. The keys are used to identify and secure SSH access to containers and other resources in Triton.

SDC Docker uses Docker's TLS authentication scheme both to identify the requesting user and secure the API endpoint. The SDC Docker helper script will generates a TLS certificate using your SSH key and write it to a directory in your user account.

### The helper script

The 'sdc-docker-setup.sh' script will help pull everything together and configure Docker clients.

Download the script:

```bash
curl -O https://raw.githubusercontent.com/joyent/sdc-docker/master/tools/sdc-docker-setup.sh
```

Now execute the script, substituting the correct values:

```bash
sh sdc-docker-setup.sh <CLOUDAPI_URL> <ACCOUNT_USERNAME> ~/.ssh/<PRIVATE_KEY_FILE>
```

For example, if you created an account on Joyent's Triton service with the username "jill" and a key file "~/.ssh/sdc-docker.id_rsa", and you're connecting to the US East 3B data center:

```bash
sh sdc-docker-setup.sh https://us-east-3b.api.joyent.com jill ~/.ssh/sdc-docker.id_rsa
```

That should output something like the following:

```bash
Setting up Docker client for SDC using:
	CloudAPI:        https://us-east-3b.api.joyent.com
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
Docker service endpoint is: tcp://165.225.168.25:2376

* * *
Success. Set your environment as follows: 

	export DOCKER_CERT_PATH=/Users/localuser/.sdc/docker/jill
	export DOCKER_HOST=tcp://165.225.168.25:2376
	alias docker="docker --tls"
```

Then you should be able to run 'docker info' and see your account
name 'SDCAccount: jill' in the output.

Run those `export` and `alias` commands in your shell and you should now
be able to run `docker`:

```bash
$ docker info
Containers: 0
Images: 0
Storage Driver: sdc
 SDCAccount: jill
Execution Driver: sdc-0.1.0
Operating System: SmartDataCenter
Name: us-east-3b
```
## Troubleshooting API connection problems

See our [guide to common API connection problems](./troubleshooting.md).

## Features

SDC Docker offers a number of features unique to Triton's container-native infrastructure, including:

1. [Placement: automatic placement of containers across the entire data center](features/placement.md).
1. [Networking: one or more real IP addresses for each container](features/networking.md).
1. [Resource allocation: specify RAM, CPU, and storage for each container](features/resources.md).
1. [Volumes: container-native volume management](features/volumes.md).

## Docker CLI commands and Docker Remote API methods

[insert list of methods here]

## Divergence

The SDC Docker implementation does have some differences from Docker Inc.'s implementation. See [the full list](divergence.md).