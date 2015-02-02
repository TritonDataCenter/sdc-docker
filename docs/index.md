---
title: SDC Docker
markdown2extras: tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# SDC Docker

A Docker Engine for SmartDataCenter (SDC) where the entire DC is exposed as
a single Docker host. The SDC Docker engine runs as the 'docker' SMF service
in a 'docker' core SDC zone.

See the [README](https://github.com/joyent/sdc-docker/blob/master/README.md)
for development details.

See [the list of Docker issues in which we are involved or interested](./docker-issues.md).

# Design documents

- [Images](./images.html)


# Configuration

Reference docs on configuration vars to sdc-docker. Configuration is loaded
from "etc/config.json" in the sdc-docker installation. In SDC this is
typically written out by config-agent using the
"sapi_manifests/docker/template".

| var | type | default | description |
| --- | ---- | ------- | ----------- |
| datacenterName | String | coal | Data center name to use as the Docker engine name. |
| defaultPackage | String | sdc_512 | The default PAPI package to use when creating new containers. |
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
