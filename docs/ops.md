# SDC Docker Operations

This document includes details on operating an SDC Docker image.

SDC Docker is a Docker Engine for SmartDataCenter (SDC) where the entire DC is
exposed as a single Docker host. The SDC Docker engine runs as the 'docker' SMF
service in a 'docker' core SDC zone.


# Package Selection

If the docker client specifies either -m (memory) or -c (cpu_shares), we'll look
through the list of packages with packagePrefix* as their name, and find the
smallest package which has values larger than both provided. If no value is
provided for cpu_shares, this parameter is ignored. If no value is provided for
memory, the defaultMemory value is used as though the user had passed that.


# Service Configuration

The SDC Docker service can be configured with the following Service API
(SAPI) metadata values.

| Key                            | Type    | Default | Description                                                                  |
| ------------------------------ | ------- | ------- | ----------- |
| **USE_TLS**                    | Boolean | false   | Turn on TLS authentication. |
| **DEFAULT_MEMORY**       | Number | 1024 | The default ram/memory to use for docker containers. |
| **PACKAGE_PREFIX** | String | 'sdc_'    | The prefix for packages to use for docker container package selection. |

### Example

    docker_svc=$(sdc-sapi /services?name=docker | json -Ha uuid)
    sdc-sapi /services/$docker_svc -X PUT -d '{ "metadata": { "USE_TLS": true } }'


# Configuration

Reference docs on configuration vars to sdc-docker. Configuration is loaded
from "etc/config.json" in the sdc-docker installation. In SDC this is
typically written out by config-agent using the
"sapi_manifests/docker/template".

| var | type | default | description |
| --- | ---- | ------- | ----------- |
| datacenterName | String | coal | Data center name to use as the Docker engine name. |
| defaultMemory | Number | 1024 | The amount of memory to choose if no -m is provided. |
| packagePrefix | String | sdc_ | PAPI will be consulted with a request PREFIX* when looking for packages |
| externalNetwork | String | external | The network name (in NAPI) from which select an IP for docker container provisioning *in non-overlay networks mode*. |
| port | Number | 2375 | Port number on which the Docker engine listens. |
| logLevel | String/Number | debug | Level at which to log. One of the supported Bunyan log levels. |
| maxSockets | Number | 100 | Maximum number of sockets for external API calls |
| backend | String | sdc | One of 'sdc' (all of SDC is a docker host) or 'lxzone' (just the CN is the docker host, this requires running the docker service in the GZ, not currently supported). |
| moray.host | String | - | The Moray server hostname for this DC. |
| moray.port | Number | 2020 | Port number on which the Moray server listens. |
| moray.logLevel | String/Number | info | Level at which the Moray client should log. One of the supported Bunyan log levels. |
| registry.indexUrl | String | - | The Docker Registry Index URL |
| registry.registryUrl | String | - | The Docker Registry Hub URL |
| cnapi.url | String | - | The CNAPI URL for this DC. |
| imgapi.url | String | - | The IMGAPI URL for this DC. |
| napi.url | String | - | The NAPI URL for this DC. |
| papi.url | String | - | The PAPI URL for this DC. |
| vmapi.url | String | - | The VMAPI URL for this DC. |
| wfapi.url | String | - | The WFAPI URL for this DC. |
