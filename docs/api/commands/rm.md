# rm

    Usage: docker rm [OPTIONS] CONTAINER [CONTAINER...]

    Remove one or more containers

      -f, --force=false      Force the removal of a running container (uses SIGKILL)
      -l, --link=false       Remove the specified link
      -v, --volumes=false    Remove the volumes associated with the container

## Examples

    $ docker rm /redis
    /redis

This will remove the container referenced under the link
`/redis`.

    $ docker rm --link /webapp/redis
    /webapp/redis

This will remove the underlying link between `/webapp` and the `/redis`
containers removing all network communication.

    $ docker rm --force redis
    redis

The main process inside the container referenced under the link `/redis` will receive
`SIGKILL`, then the container will be removed.

    $ docker rm $(docker ps -a -q)

This command will delete all stopped containers. The command `docker ps
-a -q` will return all existing container IDs and pass them to the `rm`
command which will delete them. Any running containers will not be
deleted.

## Instance Protection

It's possible to create containers that cannot be removed by adding a label
during container creation: triton.instance.undeletable=true. To remove such a
container, the tag must first be removed.

An example of creating such a container with the instance-protection label:

    $ docker run -d --label triton.instance.undeletable=true nginx

To remove such labels, see [Instance Protection](https://apidocs.joyent.com/cloudapi/#instance-protection).
It cannot be done through docker directly.

## Divergence

The SDC Docker implementation does not support the following arguments:

* `--link` does nothing
* `--volumes` does nothing

Please contact Joyent support or file a ticket if you discover any additional divergence.

## Related

- [`sdc-deletemachine`](https://apidocs.joyent.com/cloudapi/#DeleteMachine) and `DELETE /my/machines/:id` in CloudAPI
