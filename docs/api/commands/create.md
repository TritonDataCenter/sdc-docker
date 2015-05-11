# create

Creates a new container.

    Usage: docker create [OPTIONS] IMAGE [COMMAND] [ARG...]

    Create a new container

      -a, --attach=[]            Attach to STDIN, STDOUT or STDERR
      --add-host=[]              Add a custom host-to-IP mapping (host:ip)
      -c, --cpu-shares=0         CPU shares (relative weight)
      --cap-add=[]               Add Linux capabilities
      --cap-drop=[]              Drop Linux capabilities
      --cgroup-parent=""         Optional parent cgroup for the container
      --cidfile=""               Write the container ID to the file
      --cpuset-cpus=""           CPUs in which to allow execution (0-3, 0,1)
      --cpuset-mems=""           Memory nodes (MEMs) in which to allow execution (0-3, 0,1)
      --cpu-quota=0              Limit the CPU CFS (Completely Fair Scheduler) quota
      --device=[]                Add a host device to the container
      --dns=[]                   Set custom DNS servers
      --dns-search=[]            Set custom DNS search domains
      -e, --env=[]               Set environment variables
      --entrypoint=""            Overwrite the default ENTRYPOINT of the image
      --env-file=[]              Read in a file of environment variables
      --expose=[]                Expose a port or a range of ports
      -h, --hostname=""          Container host name
      -i, --interactive=false    Keep STDIN open even if not attached
      --ipc=""                   IPC namespace to use
      -l, --label=[]             Set metadata on the container (e.g., --label=com.example.key=value)
      --label-file=[]            Read in a line delimited file of labels
      --link=[]                  Add link to another container
      --log-driver=""            Logging driver for container
      --lxc-conf=[]              Add custom lxc options
      -m, --memory=""            Memory limit
      --mac-address=""           Container MAC address (e.g. 92:d0:c6:0a:29:33)
      --name=""                  Assign a name to the container
      --net="bridge"             Set the Network mode for the container
      -P, --publish-all=false    Publish all exposed ports to random ports
      -p, --publish=[]           Publish a container's port(s) to the host
      --privileged=false         Give extended privileges to this container
      --read-only=false          Mount the container's root filesystem as read only
      --restart="no"             Restart policy (no, on-failure[:max-retry], always)
      --security-opt=[]          Security options
      -t, --tty=false            Allocate a pseudo-TTY
      -u, --user=""              Username or UID
      -v, --volume=[]            Bind mount a volume
      --volumes-from=[]          Mount volumes from the specified container(s)
      -w, --workdir=""           Working directory inside the container

The `docker create` command creates a writeable container layer over
the specified image and prepares it for running the specified command.
The container ID is then printed to `STDOUT`.
This is similar to `docker run -d` except the container is never started.
You can then use the `docker start <container_id>` command to start the
container at any point.

This is useful when you want to set up a container configuration ahead
of time so that it is ready to start when you need it.

Please see the [run command](#run) section and the [Docker run reference](
/reference/run/) for more details.

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

Triton's secure,, multi-tenant, container-native environment imposes some differences from Docker Inc's implementation. Notably, arguments to control LXC or change container privilege are unsupported. Other arguments, such as those to manage CPU allocation,  or networking, are more effective because of features unique to Triton.

* `--add-host` (host-to-IP mapping) is ignored. See [networking](../features/networks.md). 
* `--cgroup-parent` is ignored. See [security](../features/security.md).
* `--cpu-shares` and `-c` are ignored, though CPU resources can be specified in conjunction with RAM. See [resource allocation](../features/resources.md). Joyent is working with the Docker community to improve how CPU resources are specified in the API.
* `--cap-add` and `--cap-drop` (Linux capabilities) are ignored. See [security](../features/security.md).
* `--cpuset` (controls which CPUs to run on) are ignored. See [resource allocation](../features/resources.md).
* `--device` (mounts host device into container) is ignored.
* `--ipc` is ignored.
* `--label` and `--label-file` are currently unsupported, but follow [DOCKER-359](http://smartos.org/bugview/DOCKER-359) for progress.
* `--log-driver` which is unsupported
* `--lxc-conf` (LXC specific) is unsupported. See [security](../features/security.md).
* `--mac-address` which is unsupported. See [networking](../features/networks.md).
* `--net` (controls how networking is attached) is currently unsupported. See [networking](../features/networks.md). Joyent is working with the Docker community to improve how network configuration is specified in the Docker API.
* `--pid=host` ss unsupported.
* `-P`, `--publish-all`, `-p`, and `--publish` behave slightly differently thanks to each container having a complete IP stack with one or more virtual NICs. See [networking](../features/networks.md).
* `--privileged` (extended privileges for containers) is ignored. See [security](../features/security.md).
* `--read-only` is currently unimplemented, follow [DOCKER-158](http://smartos.org/bugview/DOCKER-158) for updates.
* `--security-opt` which is unsupported (Security Options)
* `-v`, `--volume` and `--volumes-from` behave slightly differently in a Triton's container-native environment. See [volumes](../features/volumes.md).  

Please contact Joyent support or file a ticket if you discover any additional divergence.

## Related

- Insert a list of related Docker and CloudAPI methods here