# create

Creates a new container.

    Usage: docker create [OPTIONS] IMAGE [COMMAND] [ARG...]

    Create a new container

      -a, --attach=[]                  Attach to STDIN, STDOUT or STDERR
      --add-host=[]                    Add a custom host-to-IP mapping (host:ip)
      --blkio-weight=0                 Block IO weight (relative weight)
      --blkio-weight-device            Block IO weight (relative device weight) (default [])
      -c, --cpu-shares=0               CPU shares (relative weight)
      --cap-add=[]                     Add Linux capabilities
      --cap-drop=[]                    Drop Linux capabilities
      --cgroup-parent=""               Optional parent cgroup for the container
      --cidfile=""                     Write the container ID to the file
      --cpuset-cpus=""                 CPUs in which to allow execution (0-3, 0,1)
      --cpuset-mems=""                 Memory nodes (MEMs) in which to allow execution (0-3, 0,1)
      --cpu-count                      CPU count (Windows only)
      --cpu-percent                    CPU percent (Windows only)
      --cpu-period=0                   Limit the CPU CFS (Completely Fair Scheduler) period
      --cpu-quota=0                    Limit the CPU CFS (Completely Fair Scheduler) quota
      --credentialspec                 Credential spec for managed service account (Windows only)
      --device=[]                      Add a host device to the container
      --device-cgroup-rule=[]          Add a rule to the cgroup allowed devices list (default [])
      --device-read-bps=[]             Limit read rate (bytes per second) from a device
      --device-read-iops=[]            Limit read rate (IO per second) from a device
      --device-write-bps=[]            Limit write rate (bytes per second) to a device
      --device-write-iops=[]           Limit write rate (IO per second) to a device
      --disable-content-trust=true     Skip image verification
      --dns=[]                         Set custom DNS servers
      --dns-opt=[]                     Set DNS options
      --dns-search=[]                  Set custom DNS search domains
      -e, --env=[]                     Set environment variables
      --entrypoint=""                  Overwrite the default ENTRYPOINT of the image
      --env-file=[]                    Read in a file of environment variables
      --expose=[]                      Expose a port or a range of ports
      --group-add                      Add additional groups to join (default [])
      --health-cmd                     Command to run to check health
      --health-interval                Time between running the check
      --health-retries                 Consecutive failures needed to report unhealthy
      --health-timeout                 Maximum time to allow one check to run
      -h, --hostname=""                Container host name
      --help=false                     Print usage
      -i, --interactive=false          Keep STDIN open even if not attached
      --io-maxbandwidth                Maximum IO bandwidth limit for the system drive (Windows only)
      --io-maxiops                     Maximum IOps limit for the system drive (Windows only)
      --ip                             Container IPv4 address (e.g. 172.30.100.104)
      --ip6                            Container IPv6 address (e.g. 2001:db8::33)
      --ipc=""                         IPC namespace to use
      --isolation                      Container isolation level
      --kernel-memory                  Kernel memory limit
      --link=[]                        Add link to another container
      --link-local-ip                  Container IPv4/IPv6 link-local addresses (default [])
      --log-driver=""                  Logging driver for container
      --log-opt=[]                     Log driver specific options
      -l, --label=[]                   Set metadata on the container (e.g., --label=com.example.key=value)
      --label-file=[]                  Read in a file of labels (EOL delimited)
      -m, --memory=""                  Memory limit
      --mac-address=""                 Container MAC address (e.g. 92:d0:c6:0a:29:33)
      --memory-reservation             Memory soft limit
      --memory-swap=""                 Total memory (memory + swap), '-1' to disable swap
      --memory-swappiness=""           Tune container memory swappiness (0 to 100)
      --name=""                        Assign a name to the container
      --network=default                Connect a container to a network
      --network-alias=[]               Add network-scoped alias for the container
      --no-healthcheck                 Disable any container-specified HEALTHCHECK
      --oom-kill-disable=false         Whether to disable OOM Killer for the container or not
      --oom-score-adj                  Tune host's OOM preferences (-1000 to 1000)
      -P, --publish-all=false          Publish all exposed ports to random ports
      -p, --publish=[]                 Publish a container's port(s) to the host
      --pid=""                         PID namespace to use
      --pids-limit                     Tune container pids limit (set -1 for unlimited)
      --privileged=false               Give extended privileges to this container
      --read-only=false                Mount the container's root filesystem as read only
      --restart="no"                   Restart policy (no, on-failure[:max-retry], always)
      --runtime                        Runtime to use for this container
      --security-opt=[]                Security Options
      --shm-size                       Size of /dev/shm, default value is 64MB
      --stop-signal=SIGTERM            Signal to stop a container, SIGTERM by default
      --storage-opt                    Storage driver options for the container (default [])
      --sysctl                         Sysctl options (default map[])
      -t, --tty=false                  Allocate a pseudo-TTY
      --tmpfs=[]                       Mount a tmpfs directory
      -u, --user=""                    Username or UID (format: <name|uid>[:<group|gid>])
      --ulimit=[]                      Ulimit options
      --userns                         User namespace to use
      --uts=""                         UTS namespace to use
      -v, --volume=[]                  Bind mount a volume
      --volume-driver                  Optional volume driver for the container
      --volumes-from=[]                Mount volumes from the specified container(s)
      -w, --workdir=""                 Working directory inside the container


The `docker create` command creates a writeable container layer over
the specified image and prepares it for running the specified command.
The container ID is then printed to `STDOUT`.
This is similar to `docker run -d` except the container is never started.
You can then use the `docker start <container_id>` command to start the
container at any point.

This is useful when you want to set up a container configuration ahead
of time so that it is ready to start when you need it.

Please see the [run command](./run.md) section and the [Docker run reference](
https://docs.docker.com/engine/reference/run/) for more details.

## Examples

    $ docker create -t -i fedora bash
    6d8af538ec541dd581ebc2a24153a28329acb5268abe5ef868c1f1a261221752
    $ docker start -a -i 6d8af538ec5
    bash-4.2#

As of v1.4.0 container volumes are initialized during the `docker create`
phase (i.e., `docker run` too). For example, this allows you to `create` the
`data` volume container, and then use it from another container:

    $ docker create -v /data --name data ubuntu
    240633dfbb98128fa77473d3d9018f6123b99c454b3251427ae190a7d951ad57
    $ docker run --rm --volumes-from data ubuntu ls -la /data
    total 8
    drwxr-xr-x  2 root root 4096 Dec  5 04:10 .
    drwxr-xr-x 48 root root 4096 Dec  5 04:11 ..

Similarly, `create` a host directory bind mounted volume container, which
can then be used from the subsequent container:

    $ docker create -v /home/docker:/docker --name docker ubuntu
    9aa88c08f319cd1e4515c3c46b0de7cc9aa75e878357b1e96f91e2c773029f03
    $ docker run --rm --volumes-from docker ubuntu ls -la /docker
    total 20
    drwxr-sr-x  5 1000 staff  180 Dec  5 04:00 .
    drwxr-xr-x 48 root root  4096 Dec  5 04:13 ..
    -rw-rw-r--  1 1000 staff 3833 Dec  5 04:01 .ash_history
    -rw-r--r--  1 1000 staff  446 Nov 28 11:51 .ashrc
    -rw-r--r--  1 1000 staff   25 Dec  5 04:00 .gitconfig
    drwxr-sr-x  3 1000 staff   60 Dec  1 03:28 .local
    -rw-r--r--  1 1000 staff  920 Nov 28 11:51 .profile
    drwx--S---  2 1000 staff  460 Dec  5 00:51 .ssh
    drwxr-xr-x 32 1000 staff 1140 Dec  5 04:01 docker

## Divergence

Triton's secure, multi-tenant, container-native environment imposes some
differences from Docker Inc's implementation. Notably, arguments to control
LXC or change container privilege are unsupported. Other arguments, such as
those to manage CPU allocation, or networking, are more effective because of
features unique to Triton. See the [Resources](../features/resources.md) and
[Networks](../features/networks.md) documentation for more information on how
to size containers and assign public or private IP addresses to them.

Windows-based images and the associated parameters are not supported on Triton.

* `--add-host` (host-to-IP mapping) option is supported on platform image
  version on or after 20160331.
* `--blkio-weight`, `blkio-weight-device` options are unsupported.
* `--cgroup-parent` is ignored. See [security](../features/security.md).
* `--cpu-percent`, `--cpu-shares` and `-c` are ignored, though CPU resources can
  be specified in conjunction with RAM. See [resource allocation](../features/resources.md).
* `--cap-add` and `--cap-drop` (Linux capabilities) are ignored. See [security](../features/security.md).
* `--cpuset-cpus` and `--cpuset-mems` (controls which CPUs and memory nodes to run on) are ignored. See [resource allocation](../features/resources.md).
* `--cpu-period` and `--cpu-quota` (limit the CPU CFS settings) are ignored. See [resource allocation](../features/resources.md).
* `--device` and `--device-cgroup-rule` (mounts host device into container) is ignored.
* `--device-read`, `--device-write` (device read/write rate limits) are unsupported.
* `--disable-content-trust` (skip image verification) is ignored, follow [DOCKER-531](http://smartos.org/bugview/DOCKER-531).
* `--dns-opt` (DNS options) are unimplemented at this time.
* `--group-add` is unsupported.
* `--health-cmd`, `--no-healthcheck` and other healthcheck options are unsupported.
* `--io-maxbandwidth` and `--io-maxiops` options are unsupported.
* `--ipc` is ignored.
* `--ip`, `--ip6`, `--link-local-ip` and `--network-alias` (controls for network
  config and ip address assignment) are currently unsupported.
* `--log-driver` and `--log-opt` work somewhat differently on sdc-docker. See [log drivers](../features/logdrivers.md).
* `--mac-address` which is unsupported. See [networking](../features/networks.md).
* `--kernel-memory` and `--memory-reservation` (memory limits) are unsupported. See [resource allocation](../features/resources.md) for more about memory allocation in Triton.
* `--memory-swap` and `--memory-swappiness` (disabling swap and tuning memory swappiness) are unsupported.
  assignment) are currently unsupported.
* `--oom-kill-disable` and `--oom-score-adj` (tunables for OOM behavior) are unsupported.
* `--pid` and `--pids-limit` are unsupported.
* `-P`, `--publish-all`, `-p`, and `--publish` behave slightly differently thanks to each container having a complete IP stack with one or more virtual NICs. See [networking](../features/networks.md).
* `--privileged` (extended privileges for containers) is ignored. See [security](../features/security.md).
* `--read-only` is currently unimplemented, follow [DOCKER-158](http://smartos.org/bugview/DOCKER-158) for updates.
* `--runtime` is not supported.
* `--security-opt` (security options) is unsupported.
* `--shm-size` (size of /dev/shm) is unsupported.
* `--storage-opt` (storage driver) is unsupported.
* `--sysctl` options are unsupported.
* `--tmpfs` (mounting of tmpfs directory) is currently unimplemented, follow [DOCKER-667](http://smartos.org/bugview/DOCKER-667) for updates.
* `--ulimit` (ulimit options) is unsupported.
* `--userns` (user namespace) is unsupported.
* `--uts` (UTS namespace to use) is unsupported.
* `-v`, `--volume` and `--volumes-from` behave slightly differently in a Triton's container-native environment. See [volumes](../features/volumes.md).
* `--volume-driver` currently supports `tritonnfs` volume driver only. See
  [volumes](../features/volumes.md) for more details about the Triton's
  NFS volume feature.

Docker Swarm's affinity filters for controlling on which server a container
is provisioned are supported. See the [placement feature
documentation](../features/placement.md) for details.

Please contact Joyent support or file a ticket if you discover any additional divergence.

## Related

- [`docker ps`](../commands/ps.md)
- [`sdc-createmachine`](https://apidocs.joyent.com/cloudapi/#CreateMachine) and `POST /my/machines` in CloudAPI
