# ps

    CLI Usage: docker ps [OPTIONS]

    List containers

      -a, --all=false       Show all containers (default shows just running)
      --before=""           Show only container created before Id or Name
      -f, --filter=[]       Filter output based on conditions provided
      --format=[]           Pretty-print containers using a Go template
      -l, --latest=false    Show the latest created container, include non-running
      -n=-1                 Show n last created containers, include non-running
      --no-trunc=false      Don't truncate output
      -q, --quiet=false     Only display numeric IDs
      -s, --size=false      Display total file sizes
      --since=""            Show created since Id or Name, include non-running

`docker ps` will show only running containers by default. To see all containers
use `docker ps -a`.

`docker ps` will group exposed ports into a single range if possible. E.g., a
container that exposes TCP ports `100, 101, 102` will display `100-102/tcp` in
the `PORTS` column.

## Filtering

The filtering flag (`-f` or `--filter)` format is a `key=value` pair. If there
is more than one filter, then pass multiple flags (e.g. `--filter "foo=bar"
--filter "bif=baz"`)

Current filters:
 * id (container's id)
 * name (container's name)
 * exited (int - the code of exited containers. Only useful with '--all')
 * status (restarting|running|paused|exited)

## Examples

### No output truncation

Running `docker ps --no-trunc` showing 2 linked containers.

    $ docker ps
    CONTAINER ID        IMAGE                        COMMAND                CREATED              STATUS              PORTS               NAMES
    4c01db0b339c        ubuntu:12.04                 bash                   17 seconds ago       Up 16 seconds       3300-3310/tcp       webapp
    d7886598dbe2        crosbymichael/redis:latest   /redis-server --dir    33 minutes ago       Up 33 minutes       6379/tcp            redis,webapp/db

### Containers that exited without errors

This shows all the containers that have exited with status of '0'

    $ docker ps -a --filter 'exited=0'
    CONTAINER ID        IMAGE             COMMAND                CREATED             STATUS                   PORTS                      NAMES
    ea09c3c82f6e        registry:latest   /srv/run.sh            2 weeks ago         Exited (0) 2 weeks ago   127.0.0.1:5000->5000/tcp   desperate_leakey
    106ea823fe4e        fedora:latest     /bin/sh -c 'bash -l'   2 weeks ago         Exited (0) 2 weeks ago                              determined_albattani
    48ee228c9464        fedora:20         bash                   2 weeks ago         Exited (0) 2 weeks ago                              tender_torvalds

### All containers created before $UUID with total file size

`GET /containers/json?all=1&before=8dfafdbc3a40&size=1 HTTP/1.1`

## Divergence

This command does not support the *Size* field. All sizes will be returned as 0.
See [DOCKER-285](http://smartos.org/bugview/DOCKER-285) to follow this issue.

Please contact Joyent support or file a ticket if you discover any additional
divergence.

## Related

- [`docker inspect`](../commands/inspect.md) as in
  `docker inspect $(docker ps -l -q)`
- [`docker rm`](../commands/rm.md) as in `docker rm $(docker ps -a -q)`
- [`sdc-listmachines`](https://apidocs.joyent.com/cloudapi/#ListMachines)
  and `GET /my/machines` in CloudAPI
- [`vmadm list`](https://smartos.org/man/1m/vmadm) in SDC private API
