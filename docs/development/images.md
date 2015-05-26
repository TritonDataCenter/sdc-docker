---
title: SDC Docker Images plan
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

# SDC Docker Images plan

Here-in an overview of how we propose to handle Docker images in
SmartDataCenter (and less so in vanilla SmartOS). One way to look at it is how
to handle use cases for the following `docker` commands:

    # The higher prio set required to support using *existing*
    # docker images on SDC.
    docker images
    docker history
    docker pull
    docker rmi

    # Second pass requirements for getting full docker support.
    docker export/import
    docker save/load
    docker push
    docker build
    docker commit
    docker tag

# tl;dr

For now we're just considering "Docker on SDC" and **not** "Docker on vanilla
SmartOS". The sdc-docker service will maintain user tag-to-imageId mappings and
the user's view of the set of pulled images. Docker image tags are translated
to ids before passing on to IMGAPI (IOW, IMGAPI stays ignorant of Docker image
tags). IMGAPI has an image for each Docker image layer: `type=docker`; metadata
stored on the manifest `tags.docker`; parentage
indicated by the manifest `origin`; file data is the layer in Docker's native
(AUFS) format. IMGAPI learns how to pull from a Docker registry. `imgadm
import` learns how to import `type=docker` format file data to its native ZFS
filesystems. We'll figure out `docker push|build|commit` later.

Docker images will NOT be exposed to a user's ListImages on cloudapi. Really
they are only useful with the Docker image tag info, which is maintained
by sdc-docker. If we intend to change this design point, then beware that
sdc-docker will be removing unused/abandoned docker images in the background
(e.g. when last user does a 'docker rmi ID' for a given image ID).


# Docker images on vanilla SmartOS

First let's briefly discuss how Docker image handling on vanilla SmartOS could
work, because: (a) it is a closer comparison to the typical Docker-Host ===
single machine, (b) some of the work here will be required for "Docker on SDC",
and (c) let's get it out of the way. Practically, usage of Docker on vanilla
SmartOS would require a port of the [docker
engine](https://github.com/docker/docker) to SmartOS, or a clone written in,
say, node.js. Neither is our immediate focus.

Docker images would be handled by `imgadm`. Imgadm would learn how to injest
the docker image format (a list of AUFS layers and JSON metadata) for `imgadm
import` and `imgadm install`. Each AUFS layer becomes an incremental ZFS
filesystem based on its parent layer, docker image metadata is stored on the
image manifest `tags.docker`, and repository tag->image mappings are stored by
imgadm somehow. Ancestry is handled via the `origin` image manifest field.

    docker images       # imgadm list ...
    docker history      # add to `imgadm list` to limit to `origin` chain
    docker pull         # `imgadm import` uses node-docker-registry-client
                        # to pull from a Docker source
    docker rmi          # `imgadm delete`

    # Second pass requirements for getting full docker support.
    docker export/import    # `imgadm create`, not sure about import
    docker load         # `imgadm install`
    docker save         # new `imgadm export`
    docker push         # `imgadm publish` learns to talk Docker
    docker build        # composed of other parts here
    docker commit       # `imgadm create`
    docker tag          # imgadm would need to grow something here

The rest of this document is about supporting Docker images on *SDC*.


# Docker images on SDC

"Docker in SDC" at the time of writing means a SDC core "docker" service
that implements the Docker Remote API such that the entire DC looks like
a single Docker host for each user. That has some implications:

- The mapping of Docker image repo tags to image id has to be maintained *per
  user.*
- The set of pulled Docker images (including the intermediate layers)
  has to be maintained *per user.*

There are three main relevant systems for handling docker images in SDC:

1. the [docker SAPI service](https://github.com/joyent/sdc-docker), aka sdc-docker
2. [IMGAPI](https://github.com/joyent/sdc-imgapi), and
3. [`imgadm`](https://github.com/joyent/smartos-live/tree/master/src/img) on each node.

See the [tl;dr](#tl-dr) section above for the basic plan.


# Use Cases

(TODO: Should move or link these to a set of use cases for the Docker in SDC as
a whole.)

## Use Case 1: `docker run mongo`

- user: `docker run mongo`
- sdc-docker: auths to "bob"
- sdc-docker: lookup bob's image tags in moray, if no 'moray:latest' then we
  need to pull. See Use Case 2.
- sdc-docker: get docker ID for the image and calls VMAPI CreateVm
- vmapi: starts provision workflow
- cn-agent/provisioner: does `imgadm import $uuid` to import the docker layer(s)
- imgadm: does the image import
- ... everything else the usual provisioning flow

## Use Case 2: `docker pull mongo`

- user: `docker pull mongo`; or sdc-docker: calls pull as a side-effect of
  `docker run ...`
- sdc-docker: auths to "bob"
- sdc-docker: hits Docker index and registry as appropriate to gather the
  *repository tags* and layer info
- sdc-docker: calls IMGAPI
  [AdminImportRemoteImage](https://mo.joyent.com/docs/imgapi/master/#AdminImportRemoteImage),
  or perhaps new AdminImportRemoteDockerImage endpoint
- imgapi: creates a WF job to handle the import
- sdc-docker: on import success, commit docker image tags and set of pulled
  layers for "bob"

Dev Note: Having "on import success" handling at the end of a WF Job indicates
that perhaps there should be aseparate workflow here. I.e. a
"import-docker-image" workflow defined by sdc-docker.

## Use Case 3: `docker rmi mongo`

- user: `docker rmi mongo`
- sdc-docker: auth to "bob"
- sdc-docker: Remove from bob's (a) docker image tags and (b) set of pulled
  docker images data in moray. This uses the same semantics as `docker rmi`
  w.r.t.  dependent layers and running containers: i.e. we'll need to hit VMAPI
  to get running containers for the user.

Dev Note: This results in a list of docker image IDs that were removed from
Bob's view of the world. The trick now is that *at some point* we need to
actually remove images from the DC's IMGAPI, or we grow to insanity. We *could*
do an effective ref count on users having references to docker image ids, and
DeleteImage when that count goes to zero, but that *could* lead to
inefficiencies in this case:

- Alice does 'docker run mongo', plays a bit.
- Alice does 'docker rmi mongo' because she's done with that.
- Bob does 'docker run mongo'. Here we have to re-download the mongo layers.

Three potential plans:

A. Never delete images. Or leave it as a manual job for the operator, along
   with tooling to be able to list unused and unreferenced docker images,
   `sdc-dockeradm images --unused` or whatever.
B. Delete docker images at `docker rmi ...`-time. Optionally mitigate the
   inefficiency case above by having a separate cache of downloaded
   docker image file data.
C. When the ref count on a docker image goes to zero, set a "can delete
   this image after" timestamp on the image (say, for a week later). A
   background reaper task can delete those images. The timestamp is
   removed if the image is used again by another user in that time.
   There is already precendent for this in IMGAPI with the "expires_at"
   timestamp set on "placeholder" images created at the start of
   custom image creation. On image creation failure those placeholder
   image records are removed after a time.

I like (C).


## Use Case 4: `docker images`

- user: `docker images ...`
- sdc-docker: auth as "bob"
- sdc-docker: lookup set of images to return in per-user image data: tagged
  images or all pulled images if `docker images -a`
- sdc-docker: Gather docker data from IMGAPI.

Dev Note: Likely want a bulk endpoint on IMGAPI to be able to get information
for a number of images in one request -- instead of hitting IMGAPI 100 times to
list 100 docker images. Get IMGAPI caching correct to make that fast.


## Use Case 5: `docker history`

- user: `docker history $IMAGE`
- sdc-docker: auth as "bob"
- sdc-docker: Translate from tag to image ID if necessary.
- sdc-docker: Lookup image on IMGAPI and walk the "origin" chain.

Dev Note: For speed we might want a single call to IMGAPI to put this all
together. That could save a lot of HTTP back and forth to IMGAPI. Say:
ListImageAncestry which takes an image UUID.

    GET /images/$uuid/ancestry

    [
        {... image $uuid ...},
        {... first parent image ...},
        {... second parent image ...},
        ...
    ]


## Use Case 6: `docker pull https://my-private-repo.example.com/bob/mongo`

TODO

## Use Case 7: `docker inspect ...`

TODO


# Milestones

TODO: Integrate these with the full sdc-docker project plan. A potential
ordering:

- `docker pull|images|history|inspect`
    - really need the IMGAPI local cache (see img-mgmt plan)
- `docker rmi`
    -
- `docker pull` support for repositories other than the default
- speed: start tracking time to do all these endpoints
- plan out `docker commit|build|push` et al
- plan out billing story
- plan out support for easy private docker image repos


# Design Notes

## sdc-docker storage of per-user Docker image data

(Somewhat out of date. See the sdc-docker.git:lib/models files now.)

Sdc-docker needs to store (a) the docker image tags per user, and (b) the set
of pulled docker images per user. These will be in moray. Buckets:

1. `docker_image_tags`: Per-user mapping of docker image tag to docker id (or
   IMGAPI image uuid?).
   Columns:  `key` (unused), `owner_uuid`, `tag`, `image_id`.

2. `docker_image_ids`: Per-user set of pulled docker image ids.
   Columns:  `key` (unused), `owner_uuid`, `image_id`.


## Why store docker native format in IMGAPI?

One question is whether to have IMGAPI store native docker layer file data,
or have it store the data transformed into zone datasets.

Native docker format:
- Pro: We always have the original data in-case we need to fix a problem with
  "aufs to zfs-dataset" translation.
- Pro: IMGAPI implementations are easier: don't require ability to use `zfs`.
  I'm not sure if that'll be relevant for, say, having native docker images
  in IMGAPIs like images.joyent.com that don't live in an SDC.
- Pro: My *guess* is that storing Docker native format will help with
  "docker push".
- Pro: Docker native format closer to the metal (where metal == imgadm here),
  should help with possible future support for "Docker on vanilla SmartOS".

Zone datasets:
- Pro: Would only need to do the "aufs to zfs-dataset" translation once,
  instead of independently on each node.
- Con: Handling conversion failures would be a pain at this level. Basically
  Image import would fail during the IMGAPI AddImageFile call. Does that mean
  we throw away the downloaded file data? Yuck.
- Pro: Updating the *docker service* for processing bugs is easier than
  having to update `imgadm` in a platform for processing bugs (modulo
  having some mini-platform upgrade story).



# Open Questions

- How do we make the image installation part of "docker run" fast in SDC?
  One of the surprises a user will have with the "DC as one Docker Host" will
  be that it takes time to get the image from IMGAPI to the DN used for a
  docker container. At some point we'll likely want to optimize here. Ideas:

  - Pre-warm a set of CNs with popular Docker image layers.
  - Limit a customer to a subset of provisionable CNs so that eventually
    *their* images are on all the CNs on which their containers run.
  - Given a subset of CNs for a user, consider optimistically installing
    their pulled images to those CNs.

- My gut tells me we will need some "mini-platform upgrade" plan. Even if we
  have the planned "beta/bleeding-edge" JPC DC for the Docker service where we
  can reboot CNs, say, weekly... a week is a long time to wait for a fix.
  Theoretically, lots of issues can be fixed with hot-patches to the non-binary
  compoents of the platform like vmadm, imgadm and fwadm.

- Bill (even if small) for installed images? If we *don't* then there is
  little incentive for users to ever `docker rmi ...` their images... which
  means our IMGAPI gets filled with lots of cruft. IOW, I think we have to
  bill for it.

- Private docker repository support. See Use Case 6 above for at least supporting
  *pulling* from a private repo.
