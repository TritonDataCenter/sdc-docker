# Resource allocation

When using sdc-docker, you can specify a `-m` value for memory and sdc-docker
will select the container package that best matches the resources requested.
If there is no package available with the value specified, it will round up to
the nearest package. The package parameters can be found using the node-smartdc
tools and specifically the 'sdc-listpackages' tool.

Alternatively, you can specify the package using the special label
`com.joyent.package`. This label can be used with `docker create` or `docker
run` to choose a specific package. The value should be either a package name
like `g4-standard-1G`, a UUID or the first 8 characters of a UUID (short-UUID).
For example:

```
docker run -it --label com.joyent.package=g4-standard-1G alpine /bin/sh
```

will create a container using the g4-standard-1G package. If you specify the
com.joyent.package label, any -m argument will be ignored. Note: this special
com.joyent.package label will not show up in your list of labels in `docker
inspect` as it is not actually attached to your container.

The package will be used to determine such things as:

 * CPU shares
 * DRAM (memory)
 * Disk quota
 * I/O priority

appropriate for the system your container is provisioned to.

Regardless of how your docker container was provisioned, you can use the package
as a filter for `docker ps`. To filter you can use the format:

```
docker ps --filter "label=com.joyent.package=g4-standard-1G"
```

which would show you only those docker containers that are using the
`g4-standard-1G` package. You can use either a package name, UUID or short-UUID.
