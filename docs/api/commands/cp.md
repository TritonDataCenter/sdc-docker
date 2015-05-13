# cp

Copy files or folders from a container's filesystem to the directory on the
host (i.e. where the Docker API client is located).  Use '-' to write the data as a tar file to `STDOUT`. `CONTAINER:PATH` is
relative to the root of the container's filesystem.

    Usage: docker cp CONTAINER:PATH HOSTDIR|-

    Copy files/folders from the PATH to the HOSTDIR.

## Divergence

With sdc-docker, `docker cp` does not work against stopped containers. ([DOCKER-374](http://smartos.org/bugview/DOCKER-374))

## Related

- Insert a list of related Docker and CloudAPI methods here
