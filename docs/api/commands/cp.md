# cp

Copy files or folders from a container's filesystem to the directory on the
host.  Use '-' to write the data as a tar file to `STDOUT`. `CONTAINER:PATH` is
relative to the root of the container's filesystem.

    Usage: docker cp CONTAINER:PATH HOSTDIR|-

    Copy files/folders from the PATH to the HOSTDIR.

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc. implementations of this method. Please contact Joyent support or file a ticket if you discover any.

## Related

- Insert a list of related Docker and CloudAPI methods here