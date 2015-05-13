# restart

    Usage: docker restart [OPTIONS] CONTAINER [CONTAINER...]

    Restart a running container

      -t, --time=10      Seconds to wait for stop before killing the container

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc. implementations of this method. Please contact Joyent support or file a ticket if you discover any.

## Related

- [`sdc-rebootmachine`](https://apidocs.joyent.com/cloudapi/#RebootMachine) and `POST /my/machines/:id?action=reboot` in CloudAPI
