# Divergence

Joyent's implementation of the Docker Remote API has some added features as well as omissions where the API conflicted with the needs of deploying containers across Triton data centers.

## Features

- [CPU and memory resource allocation](features/resources.md)
- [Overlay networks](features/networks.md)
- [Volumes](features/volumes.md)
- [Private registries](features/repos.md)

## Container behavior and contents

### Extra Processes

#### zsched

In containers you may see a `zsched` process in addition to your other
processes. It owns the kernel threads that do work on behalf of your zone.
The PID of this process should always show up as 0, though some versions of
`ps` on Linux filter this out.

#### ipmgmtd

If you don't have `docker:noipmgmtd` set in your internal_metadata, you will
have an additional process `ipmgmtd`. This is the SmartOS daemon that manages
network interfaces and TCP/IP tunables. The default if you use sdc-docker is
that docker:noipmgmtd will be true when you're provisioning a regular LX docker
container, and false if you're provisioning a SmartOS container.

### Extra Files

#### /var/log/sdc-dockerinit.log

This is the log from the dockerinit process which sets up the container for
your initial process and then exec()s it. This log exists only for debugging
problems with the way the initial process has been setup.

### Extra Filesystems

#### /native/*

If you run `mount` or `df` you will see several filesystems mounted in from
/native. These are bits from the SmartOS host mounted in to support the LX
emulation.

#### objfs on /system/object

This is the SmartOS kernel object filesystem. The contents of the filesystem
are dynamic and reflect the current state of the system. See:

http://illumos.org/man/7fs/objfs

for more information.

#### ctfs on /system/contract

This is the SmartOS contract file system which is the interface to the SmartOS
contract subsystem.

See:

http://illumos.org/man/4/contract

for more information.

### Exit Statuses

When a container exits the exit status as returned by sdc-docker will currently
be different from that which would be returned by Docker Inc's docker. This is
due to differences in the way we handle processes within zones. This is
currently considered to be a deficiency and should be improved by [DOCKER-41](http://smartos.org/bugview/DOCKER-41).

## Performance of container management functions

Actions performed against sdc-docker are slower, and sometimes _much_ slower
than those same actions performed against a local docker. This is something we
are working on, and intend to keep improving over time.

## Docker Remote API methods and Docker CLI commands

In most cases Joyent has taken great efforts to be [bug for bug compatible](http://en.wikipedia.org/wiki/Bug_compatibility) with Docker Inc's API implementation (see restart policies). Please see documentation for [specific methods](./commands/) for any known divergence and file bugs as needed.

SDC Docker implements all the API methods necessary to deploy Docker containers in
the cloud, but is notably missing methods necessary to build containers. For that,
please continue using Docker on your laptop for now, though we definitely want to
support those features in the future.

Here's the list of API methods currently unimplemented as of this writing, but
expect it to get shorter by the day:

`docker build`, `docker commit`, `docker diff`, `docker events`, `docker export`,
`docker import`, `docker load`, `docker pause`, `docker push`, `docker save`,
`docker tag`, `docker unpause`

## Images and private registries

SDC Docker supports the integration with Docker Hub and third party registries through
Docker's Registry v1 and v2 API. The use of the short or long Image ID may not uniquely
identify an image if images of the same ID exist in more than one repo. To work around
this Registry API limitation in such rare case, use the repo, image and tag name in
the image management API methods (e.g. `docker pull`, `docker inspect`) instead of
the Image ID.
