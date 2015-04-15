# Divergence from Docker Inc's docker

This document exists to provide a comprehensive list of known differences
you may experience when interacting with sdc-docker instead of Docker Inc's
docker.

## Client Versions

At this point only docker clients 1.4.1+ can be expected to work against
sdc-docker.

## Differences in Container Behavior

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

### Restart Policies

The way containers are restarted with sdc-docker:

 * if you specify --restart=no (the default):
     * if the node your container is on is rebooted, your container will be off
     * if your container process exits (regardless of exit status) your
       container will remain off unless you start it.
 * if you specify --restart=always:
     * if the node your container is on is rebooted, and your container was
       running at the time of the reboot, your container will be started when
       the node boots.
     * if your container process exits (regardless of exit status), the
       container will be restarted and the RestartCount will be incremented
       (see below on delays between restarts).
 * if you specify --restart=on-failure[:maxretries]:
     * if the node your container is on is rebooted, your container will only
       be started when the node boots if the init process of your container
       exited non-zero as part of the CN reboot.
     * if your container process exits with a non-zero exit status, the
       container will be restarted and the RestartCount will be incremented.
       If you specified a maxretries and this is reached, the container will
       be stopped and not restarted again automatically.
     * if your container process exits with a zero status, the container will
       not be restarted again automatically.

When restarting your container automatically (the cases mentioned above) there
is a delay between restarts in order to prevent things from going haywire.
sdc-docker uses the same delay frequency as Docker Inc's docker. This means that
after exiting but before starting again we delay ((2 ^ RestartCount) * 100) ms.
So on the first restart (with RestartCount = 0) we will delay 100ms, then 200,
then 400, etc. The amount of delay is not guaranteed. In the case of a CN reboot
or in other operational situations a retry may occur sooner.

The main way that this is different from Docker Inc's docker is that with Docker
Inc's docker, if you restart the docker daemon all containers will be stopped
and those with --restart=always will be started again. With sdc-docker
restarting the management systems will not touch your container but restarting
the compute node the container lives on will.

If you want your container to always be running you most likely want to specify
--restart=always to avoid your containers being stopped when a CN reboots.

### Volumes

With sdc-docker, host volumes work differently than on Docker Inc's docker.

 * there is a limit of 8 'data' volumes per container
 * there is a limit of 1 'host' volume per container
 * there is a limit of 1 --volumes-from argument per container
 * 'host' volumes must be http[s] URLs, not paths in the docker host
 * the 'host' volume URL's must each refer to a single file
 * all 'host' volumes are read-only
 * the container path of a 'host' volume must not contain any symlinks
 * you cannot delete a container which has a volume that another container is
   sharing (via --volumes-from), you must first delete all containers using that
   volume.
 * 'host' volumes are not shared through --volumes-from
 * When you use --volumes-from you are necessarily coprovisioned with the
   container you are sharing the volumes from. If the physical host on which
   the source container exists does not have capacity for the new container,
   provisioning a new container using --volumes-from will fail.
 * When you use --volumes-from, volumes that don't belong to the container
   specified (including those that this container is sharing from others) are
   ignored. Only volumes belonging to the specified container will be
   considered.

In general, `-v <URL>:/container/path` is intended to be used for things like
configuration files in order to seed data into containers. Any use-case where
data is intended to be read-write or when more than one file is required it is
preferable to create a container with a volume and --volumes-from that container
if you need the data stored independently of the container.

### Support for SmartOS containers

Unlike Docker Inc's docker, sdc-docker supports running containers that are
SmartOS-native. Currently this functionality is limited but it is a divergence
from docker. If you specify a UUID of an image that has been imported into
the local imgapi and has the os set to 'smartos', the container will be started
with a joyent-minimal brand instead of lx and will use that image.

### SDC packages

When using sdc-docker, you can specify a -m value for memory and sdc-docker
if there is no package available with this value, it will round up to the
nearest package. The package parameters can be found using the node-smartdc
tools and specifically the 'sdc-listpackages' tool.

The package will be used to determine such things as:

 * CPU shares
 * DRAM (memory)
 * disk quota
 * I/O priority

appropriate for the package and system your container is provisioned to.

### Performance of container management functions

Actions performed against sdc-docker are slower, and sometimes _much_ slower
than those same actions performed against a local docker. This is something we
are working on, and intend to keep improving over time.

### Networking

If fabric networking is enabled for sdc-docker, each docker container is
provisioned with a private nic on the user's default fabric. This allows
only other docker containers provisioned on that fabric to connect connect to
each other. The container is able to reach the external internet via [Network
Address Translation](http://en.wikipedia.org/wiki/Network_address_translation).
Each default fabric network is private to a user - one user's containers cannot
connect to another's fabric IP addresses, and vice-versa.

All docker containers owned by a user have firewalls enabled by default, and
their default policy is to block all incoming traffic and allow all outbound
traffic. All docker VMs have a
[Cloud Firewall](https://www.joyent.com/developers/firewall/) rule
automatically created that allows them to communicate with each other on all
ports.

If you specify the -p or -P options to `docker run` or `docker create`, the
container will receive an external IP address that is reachable over the public
internet, and [Cloud Firewall](https://www.joyent.com/developers/firewall/)
rules are automatically created that allow incoming traffic to the appropriate
ports from any IP address. For `-P`, this means all ports that the VM's image
exposes. For `-p`, this means all ports specified as arguments, up to a limit
of 8 TCP ports and 8 UDP ports. Remapping ports with `-p` (eg, `-p 80:8080`) is
not supported at this time.

If fabric networking is not enabled, all docker containers are provisioned with
a nic on the 'external' network by default.

Currently, the `--link` option to `docker create` and `docker run` is
unimplemented (see [DOCKER-75](http://smartos.org/bugview/DOCKER-75) for
updates) - however, containers are still able to connect to each other on the
networks mentioned above.

## Current Differences as Experienced by cmdline Clients

Currently error messages returned by 'docker' when talking to sdc-docker will
not match exactly with the messages you could get from a Docker Inc docker
daemon. [DOCKER-79](http://smartos.org/bugview/DOCKER-79) was created to try to address this.

### `docker attach`

No intentional divergence. Any divergence can be considered a bug.

### `docker build`

This command is currently unimplemented ([DOCKER-74](http://smartos.org/bugview/DOCKER-74))

### `docker commit`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker cp`

No known divergence. Any divergence can be considered a bug.

### `docker create`

This command mostly works however not all features are currently fully
implemented. Differences include:

 * --add-host which is unsupported (host-to-IP mapping)
 * --cap-add and --cap-drop which are unsupported (Linux capabilities)
 * --cpu-shares which is unsupported: see 'SDC packages' section above
 * --cpuset which is unsupported (controls which CPUs to run on)
 * --device which is unsupported (mounts host device into container)
 * --dns and --dns-search which are unimplemented (control DNS in the container)
     * [DOCKER-338](http://smartos.org/bugview/DOCKER-338)
 * --expose which is unimplemented (exposes a port)
     * [DOCKER-76](http://smartos.org/bugview/DOCKER-76)
 * --ipc which is unsupported
 * --link which is unimplemented (links to another container)
     * [DOCKER-75](http://smartos.org/bugview/DOCKER-75)
 * --lxc-conf which is unsupported (LXC specific)
 * --net which is currently unsupported (controls how networking is attached)
 * --publish-all and --publish: see 'Networking' section above
 * --privileged which is unsupported (extended privileges for containers)
 * --read-only which is unimplemented ([DOCKER-158](http://smartos.org/bugview/DOCKER-158))
 * --security-opt which is unsupported (Security Options)
 * --volume: see 'Volumes' section above
 * --volumes-from: see 'Volumes' section above

### `docker diff`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker events`

This command is currently unimplemented ([DOCKER-78](http://smartos.org/bugview/DOCKER-78))

### `docker exec`

No known divergence.

### `docker export`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker history`

No known divergence.

### `docker images`

No known divergence.

### `docker import`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker info`

 * Storage Driver will always be 'sdc'
 * Execution Driver is will be 'sdc-<VERSION>'
 * Operating System will always be 'SmartDataCenter'
 * SDCAccount will show you the name of the SDC account you're authenticated as
 * Name will show you the datacenter name

### `docker inspect`

For the most part the `docker inspect` output should match what you'd see on
Docker Inc's docker but some fields eg. AppArmorProfile, CapAdd, CapDrop,
Cpuset, IpcMode, LxcConf, SecurityOpt don't make sense in sdc-docker and are
never populated.

(See also note about exit status differences in 'Differences in Container
Behavior' section)

### `docker kill`

With sdc-docker `docker kill` only supports a subset of signals. These currently
include:

  SIGABRT
  SIGALRM
  SIGBUS
  SIGCHLD
  SIGCONT
  SIGFPE
  SIGHUP
  SIGILL
  SIGINT
  SIGIO
  SIGIOT
  SIGKILL
  SIGLOST
  SIGPIPE
  SIGPOLL
  SIGPROF
  SIGPWR
  SIGQUIT
  SIGSEGV
  SIGSTOP
  SIGSYS
  SIGTERM
  SIGTRAP
  SIGTSTP
  SIGTTIN
  SIGTTOU
  SIGURG
  SIGUSR1
  SIGUSR2
  SIGVTALRM
  SIGWINCH
  SIGXCPU
  SIGXFSZ

### `docker load`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker login`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker logout`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker logs`

No known divergence.

### `docker port`

This command is currently unimplemented ([DOCKER-76](http://smartos.org/bugview/DOCKER-76))

### `docker pause`

This command is currently unimplemented ([OS-3455](http://smartos.org/bugview/OS-3455))

### `docker ps`

Implemented, but does not support the *Size* field - all sizes will be returned
as 0 ([DOCKER-285](http://smartos.org/bugview/DOCKER-285))

### `docker pull`

No known divergence.

### `docker push`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker restart`

No known divergence.

### `docker rename`

No known divergence.

### `docker rm`

This works the same as upstream except:

 * --link does nothing
 * --volumes does nothing

### `docker rmi`

This works but does not support:

 * --force ([DOCKER-182](http://smartos.org/bugview/DOCKER-182))
 * --no-prune

### `docker run`

This command mostly works however not all features are currently fully
implemented. Differences include:

 * --add-host which is unsupported (host-to-IP mapping)
 * --cpu-shares which is unsupported: see 'SDC packages' section above
 * --cap-add and --cap-drop which are unsupported (Linux capabilities)
 * --cpuset which is unsupported (controls which CPUs to run on)
 * --device which is unsupported (mounts host device into container)
 * --dns and --dns-search which are unimplemented (control DNS in the container)
 * --expose which is unimplemented (exposes a port)
     * [DOCKER-76](http://smartos.org/bugview/DOCKER-76)
 * --ipc which is unsupported
 * --link which is unimplemented (links to another container)
     * [DOCKER-75](http://smartos.org/bugview/DOCKER-75)
 * --lxc-conf which is unsupported (LXC specific)
 * --net which is currently unsupported (controls how networking is attached)
 * --publish-all and --publish: see 'Networking' section above
 * --privileged which is unsupported (extended privileges for containers)
 * --read-only which is unimplemented ([DOCKER-158](http://smartos.org/bugview/DOCKER-158))
 * --security-opt which is unsupported (Security Options)
 * --volume: see 'Volumes' section above
 * --volumes-from: see 'Volumes' section above

### `docker save`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker search`

No known divergence.

### `docker stats`

This command is currently unimplemented ([DOCKER-156](http://smartos.org/bugview/DOCKER-156))

### `docker start`

No known divergence.

### `docker stop`

No known divergence.

### `docker tag`

This command is currently unimplemented ([DOCKER-73](http://smartos.org/bugview/DOCKER-73))

### `docker top`

With sdc-docker, `docker top` does not currently support the `ps_args` option
and always returns results in the same format. This format is hardcoded pending
upstream integration of some solution to the issues described in:

 https://github.com/docker/docker/pull/9232

### `docker unpause`

This command is currently unimplemented ([OS-3456](http://smartos.org/bugview/OS-3456))

### `docker version`

 * Server version will be sdc-docker version not docker
 * Go version on the server is actually a node.js version

### `docker wait`

No known divergence in command behavior.

(See also note about exit status differences in 'Differences in Container
Behavior' section)
