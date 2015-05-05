## cp

Copy files or folders from a container's filesystem to the directory on the
host.  Use '-' to write the data as a tar file to `STDOUT`. `CONTAINER:PATH` is
relative to the root of the container's filesystem.

    Usage: docker cp CONTAINER:PATH HOSTDIR|-

    Copy files/folders from the PATH to the HOSTDIR.

