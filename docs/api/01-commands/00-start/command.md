Title: start
----
text:

    Usage: docker start [OPTIONS] CONTAINER [CONTAINER...]

    Start one or more stopped containers

      -a, --attach=false         Attach STDOUT/STDERR and forward signals
      -i, --interactive=false    Attach container's STDIN

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc. implementations of this method. Please contact Joyent support or file a ticket if you discover any.

## Related

- [`sdc-startmachine`](https://apidocs.joyent.com/cloudapi/#StartMachine) and `POST /my/machines/:id?action=start` in CloudAPI
