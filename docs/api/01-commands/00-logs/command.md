Title: logs
----
text:

    Usage: docker logs [OPTIONS] CONTAINER

    Fetch the logs of a container

      -f, --follow=false        Follow log output
      -t, --timestamps=false    Show timestamps
      --tail="all"              Number of lines to show from the end of the logs

NOTE: this command is available only for containers with `json-file` logging
driver.

The `docker logs` command batch-retrieves logs present at the time of execution.

The `docker logs --follow` command will continue streaming the new output from
the container's `STDOUT` and `STDERR`.

Passing a negative number or a non-integer to `--tail` is invalid and the
value is set to `all` in that case. This behavior may change in the future.

The `docker logs --timestamp` commands will add an RFC3339Nano
timestamp, for example `2014-09-16T06:17:46.000000000Z`, to each
log entry. To ensure that the timestamps for are aligned the
nano-second part of the timestamp will be padded with zero when necessary.

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc. implementations of this method. Please contact Joyent support or file a ticket if you discover any.

## Related

- Insert a list of related Docker and CloudAPI methods here