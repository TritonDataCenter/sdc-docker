## kill

    Usage: docker kill [OPTIONS] CONTAINER [CONTAINER...]

    Kill a running container using SIGKILL or a specified signal

      -s, --signal="KILL"    Signal to send to the container

The main process inside the container will be sent `SIGKILL`, or any
signal specified with option `--signal`.
