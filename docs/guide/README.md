---
title: SDC Docker Operators Guide
markdown2extras: tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
---

# SDC Docker Operations

Welcome to Docker on SmarDataCenter. The Docker Engine for SDC is currently in
alpha and under heavy development. The current focus is stabilization and
filling out support for *running* Docker containers.

SDC Docker is a Docker Engine for SmartDataCenter (SDC) where the entire DC is
exposed as a single Docker host. The SDC Docker engine runs as the 'docker' SMF
service in a 'docker' core SDC zone.

This document includes details on operating an SDC Docker image. If you are interested in developing
the Docker Engine for SDC, see the [sdc-docker README](https://github.com/joyent/sdc-docker/blob/master/README.md).

The Docker Engine for SmartDataCenter treats the entire data center as
a single Docker host. Each container is a SmartOS LX-branded zone. Benefits:

- [Zones](http://en.wikipedia.org/wiki/Solaris_Containers) have a
  proven security track record for isolation.
- LX-branded zones provide the abilty to run Linux binaries in SmartOS
  zones, meaning you can use Docker images without modification *and*
  without the overhead of hardware-based virtualization.
- [Overlay network](http://en.wikipedia.org/wiki/Overlay_network)
  support (VXLAN) means you have a private network between all your containers,
  across servers.

And the full stack is open source: [sdc-docker](https://github.com/joyent/sdc-docker),
[SmartDataCenter](https://github.com/joyent/sdc),
and [SmartOS](https://github.com/joyent/smartos-live).

**A note for users of Joyent's public cloud:** Joyent is hosting a beta of
their Docker service. Please sign up at https://www.joyent.com/lp/preview and
read on for the settings for the standard Docker client.


## Current Status

The Docker Engine for SDC is currently in alpha and under heavy development.
The current focus is on stabilization and filling out support for *building* and
*running* Docker containers.
Please [report issues](https://github.com/joyent/sdc-docker/issues),
give us feedback or discuss on [#joyent IRC on freenode.net](irc://freenode.net/#joyent).

### 3. sdc-docker-setup.sh

Now that you have access to a SmartDataCenter, we will set up authentication
to the Docker host. SDC Docker uses Docker's TLS authentication. This section
will show you how to create a TLS client certificate from the SSH key you
created in the previous section. Then we'll configure `docker` to send that
client certificate to identify requests as coming from you.

Follow the steps in [the API guide to get connected and start using SDC Docker](../api/README.md).


## Package Selection

If the docker client specifies either -m (memory) or -c (cpu\_shares), we'll look
through the list of packages with `packagePrefix*` as their name, and find the
smallest package which has values larger than both provided. If no value is
provided for `cpu_shares`, this parameter is ignored. If no value is provided for
memory, the defaultMemory value is used as though the user had passed that.


## Service Configuration

The SDC Docker service can be configured with the following Service API
(SAPI) metadata values.

| Key                            | Type    | Default | Description                                                                  |
| ------------------------------ | ------- | ------- | ----------- |
| **USE_TLS**                    | Boolean | false   | Turn on TLS authentication. |
| **DEFAULT_MEMORY**       | Number | 1024 | The default ram/memory to use for docker containers. |
| **PACKAGE_PREFIX** | String | 'sample-'    | The prefix for packages to use for docker container package selection. |

### Example

    docker_svc=$(sdc-sapi /services?name=docker | json -Ha uuid)
    sdc-sapi /services/$docker_svc -X PUT -d '{ "metadata": { "USE_TLS": true } }'


## Configuration

Reference docs on configuration vars to sdc-docker. Configuration is loaded
from "etc/config.json" in the sdc-docker installation. In SDC this is
typically written out by config-agent using the
"sapi_manifests/docker/template".

| var | type | default | description |
| --- | ---- | ------- | ----------- |
| datacenterName | String | coal | Data center name to use as the Docker engine name. |
| defaultMemory | Number | 1024 | The amount of memory to choose if no -m is provided. |
| packagePrefix | String | sample- | PAPI will be consulted with a request `PREFIX*` when looking for packages |
| externalNetwork | String | external | The network name (in NAPI) from which select an IP for docker container provisioning *in non-overlay networks mode*. |
| port | Number | 2375 | Port number on which the Docker engine listens. |
| logLevel | String/Number | debug | Level at which to log. One of the supported Bunyan log levels. |
| maxSockets | Number | 100 | Maximum number of sockets for external API calls |
| backend | String | sdc | One of 'sdc' (all of SDC is a docker host) or 'lxzone' (just the CN is the docker host, this requires running the docker service in the GZ, not currently supported). |
| moray.host | String | - | The Moray server hostname for this DC. |
| moray.port | Number | 2020 | Port number on which the Moray server listens. |
| moray.logLevel | String/Number | info | Level at which the Moray client should log. One of the supported Bunyan log levels. |
| cnapi.url | String | - | The CNAPI URL for this DC. |
| imgapi.url | String | - | The IMGAPI URL for this DC. |
| napi.url | String | - | The NAPI URL for this DC. |
| papi.url | String | - | The PAPI URL for this DC. |
| vmapi.url | String | - | The VMAPI URL for this DC. |
| wfapi.url | String | - | The WFAPI URL for this DC. |

## Client usage

The Docker Engine for SDC is all about using the `docker` CLI. So all that is
required is to set up an account with a SmartDataCenter cloud and to configure
your environment variables for the `docker` client.

### 2. Set Up an SDC Account

See the [User Management](https://docs.joyent.com/sdc7/user-management) operator guide documentation on how to create a user in SmartDataCenter.

The [SmartDataCenter CLI environment](https://apidocs.joyent.com/cloudapi/#getting-started) is not necessary for to use Docker on SDC,
but for beta testing it will be helpful. To test that your
SmartDataCenter client environment is configured, you can run `sdc-getaccount`:

    $ sdc-getaccount
    {
      "id": "....387c",
      "login": "jill",
      "email": "jill@example.com",
      "companyName": "Acme",
      "firstName": "Jill",
      ...
    }

If `sdc-getaccount` works, then complete the [steps to configure the Docker client in the API guide](../api/).


## TODO

- where to go if hit troubles
- usage examples
