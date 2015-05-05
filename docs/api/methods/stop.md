## stop

    Usage: docker stop [OPTIONS] CONTAINER [CONTAINER...]

    Stop a running container by sending SIGTERM and then SIGKILL after a
	grace period

      -t, --time=10      Seconds to wait for stop before killing it

The main process inside the container will receive `SIGTERM`, and after a
grace period, `SIGKILL`.
