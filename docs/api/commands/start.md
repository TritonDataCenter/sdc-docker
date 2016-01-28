# start

    Usage: docker start [OPTIONS] CONTAINER [CONTAINER...]

    Start one or more stopped containers

      -a, --attach=false         Attach STDOUT/STDERR and forward signals
      --detach-keys              Override the key sequence for detaching a container
      -i, --interactive=false    Attach container's STDIN

## Divergence

* `--detach-keys` is unsupported.

## Related

- [`sdc-startmachine`](https://apidocs.joyent.com/cloudapi/#StartMachine) and `POST /my/machines/:id?action=start` in CloudAPI
