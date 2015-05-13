# stop

    Usage: docker stop [OPTIONS] CONTAINER [CONTAINER...]

    Stop a running container by sending SIGTERM and then SIGKILL after a
	grace period

      -t, --time=10      Seconds to wait for stop before killing it

The main process inside the container will receive `SIGTERM`, and after a
grace period, `SIGKILL`.

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc. implementations of this method. Please contact Joyent support or file a ticket if you discover any.

## Related

- [`sdc-stopmachine`](https://apidocs.joyent.com/cloudapi/#StopMachine) and `POST /my/machines/:id?action=stop` in CloudAPI
