# Divergence from Docker Inc's docker

This document exists to provide a comprehensive list of known differences
you may experience when interacting with sdc-docker instead of Docker Inc's
docker.

## Differences in Container Behavior

### Extra Processes

#### zsched

In all containers you will see a `zsched` process in addition to your other
processes. It owns the kernel threads that do work on behalf of your zone.
The PID of this process should always show up as 0.

#### ipmgmtd

If you don't have `docker:noipmgmtd` set in your internal_metadata, you will
have an additional process `ipmgmtd`. This is the SmartOS daemon that manages
network interfaces and TCP/IP tunables.

### Exit Statuses

When a container exits the exit status as returned by sdc-docker will currently
be different from that which would be returned by Docker Inc's docker. This is
due to differences in the way we handle processes within zones. This is
currently considered to be a deficiency and should be improved by DOCKER-41.

## Current Differences as Experienced by cmdline Clients

Currently error messages returned by 'docker' when talking to sdc-docker will
not match exactly with the messages you could get from a Docker Inc docker
daemon. DOCKER-79 was created to try to address this.

### `docker attach`

No intentional divergence. Any divergence can be considered a bug.

### `docker build`

This command is currently unimplemented (DOCKER-74)

### `docker commit`

This command is currently unimplemented (DOCKER-73)

### `docker cp`

No known divergence. Any divergence can be considered a bug.

### `docker create`

This command mostly works however not all features are currently fully
implemented. Differences include:

 * --add-host which is unsupported (host-to-IP mapping)
 * --cap-add and --cap-drop which are unsupported (Linux capabilities)
 * --cpuset which is unsupported (controls which CPUs to run on)
 * --device which is unsupported (mounts host device into container)
 * --dns and --dns-search which are unimplemented (control DNS in the container)
 * --expose which is unimplemented (exposes a port)
     * DOCKER-76
 * --link which is unimplemented (links to another container)
     * DOCKER-75
 * --lxc-conf which is unsupported (LXC specific)
 * --net which is currently unsupported (controls how networking is attached)
 * --publish-all and --publish which are unsupported (expose ports to host)
 * --privileged which is unsupported (extended privileges for containers)
 * --restart which is unimplimented (restart policies)
     * OS-3546
 * --security-opt which is unsupported (Security Options)
 * `--volumes /volname` has a limit of 8 volumes per VM
 * `--volumes /hostpath:/volname` is not yet fully supported
 * --volumes-from is not implemented
     * DOCKER-69

### `docker diff`

This command is currently unimplemented (DOCKER-73)

### `docker events`

This command is currently unimplemented (DOCKER-78)

### `docker exec`

No known divergence.

### `docker export`

This command is currently unimplemented (DOCKER-73)

### `docker history`

No known divergence.

### `docker images`

 * -a is not currently implemented

### `docker import`

This command is currently unimplemented (DOCKER-73)

### `docker info`

 * Storage Driver will always be 'sdc'
 * Execution Driver is will be 'sdc-<VERSION>'
 * Kernel Version is the SDC version
 * Operating System will always be 'Joyent Smart Data Center'
 * Server will always be listed as in 'Debug mode'
 * Fds has a bogus value
 * Goroutines has a bogus value
 * 'Init Path' has a bogus value

### `docker inspect`

(See also note about exit status differences in 'Differences in Container
Behavior' section)

Many values in the output here are still bogus.

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

This command is currently unimplemented (DOCKER-73)

### `docker login`

This command is currently unimplemented (DOCKER-73)

### `docker logout`

This command is currently unimplemented (DOCKER-73)

### `docker logs`

No known divergence.

### `docker port`

This command is currently unimplemented (DOCKER-76)

### `docker pause`

This command is currently unimplemented (OS-3455)

### `docker ps`

No known divergence.

### `docker pull`

No known divergence.

### `docker push`

This command is currently unimplemented (DOCKER-73)

### `docker restart`

No known divergence.

### `docker rm`

This works the same as upstream except:

 * --link does nothing
 * --volumes does nothing

### `docker rmi`

This works but does not support:

 * --force
 * --no-prune

### `docker run`

This command mostly works however not all features are currently fully
implemented. Differences include:

 * --add-host which is unsupported (host-to-IP mapping)
 * --cap-add and --cap-drop which are unsupported (Linux capabilities)
 * --cpuset which is unsupported (controls which CPUs to run on)
 * --device which is unsupported (mounts host device into container)
 * --dns and --dns-search which are unimplemented (control DNS in the container)
 * --expose which is unimplemented (exposes a port)
     * DOCKER-76
 * --link which is unimplemented (links to another container)
     * DOCKER-75
 * --lxc-conf which is unsupported (LXC specific)
 * --net which is currently unsupported (controls how networking is attached)
 * --publish-all and --publish which are unsupported (expose ports to host)
 * --privileged which is unsupported (extended privileges for containers)
 * --restart which is unimplimented (restart policies)
     * OS-3546
 * --security-opt which is unsupported (Security Options)
 * --sig-proxy which is unimplemented
     * DOCKER-82
 * `--volumes /volname` has a limit of 8 volumes per VM
 * `--volumes /hostpath:/volname` is not yet fully supported
 * --volumes-from is not implemented
     * DOCKER-69

### `docker save`

This command is currently unimplemented (DOCKER-73)

### `docker search`

No known divergence.

### `docker start`

Should mostly match upstream except:

 * -a is unsupported

### `docker stop`

No known divergence.

### `docker tag`

This command is currently unimplemented (DOCKER-73)

### `docker top`

With sdc-docker, `docker top` does not currently support the `ps_args` option
and always returns results in the same format. This format is hardcoded pending
upstream integration of some solution to the issues described in:

 https://github.com/docker/docker/pull/9232

### `docker unpause`

This command is currently unimplemented (OS-3456)

### `docker version`

 * Server version will be sdc-docker version not docker
 * Go version on the server is actually a node.js version

### `docker wait`

No known divergence in command behavior.

(See also note about exit status differences in 'Differences in Container
Behavior' section)
