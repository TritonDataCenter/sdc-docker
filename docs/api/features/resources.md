# Resource allocation

When you create a container with sdc-docker, your container will have an
associated "package". The package will be used to determine such things as:

 * CPU shares
 * DRAM (memory)
 * Disk quota
 * I/O priority

appropriate for the system your container is provisioned to. The package
parameters can be found using the `triton package list` command using
the [node-triton tool](https://github.com/joyent/node-triton).

When creating a container with `docker create` or `docker run` you can specify
the package using the special label `com.joyent.package`. This label can be used
with `docker create` or `docker run` to choose a specific package. The value
should be either a package name like `g4-standard-1G`, a UUID or the first 8
characters of a UUID (short-UUID).  For example:

```
docker run -it --label com.joyent.package=g4-standard-1G alpine /bin/sh
```

will create a container using the g4-standard-1G package. If you specify the
com.joyent.package label, any -m argument will be ignored.

If you don't have a specific package that you want to use but do have a minimum
memory requirement, you can specify a `-m` value for memory and sdc-docker
will select the container package that best matches the resources requested.
If there is no package available with the value specified, it will round up to
the nearest package.

Regardless of how your docker container was provisioned, you can use the package
as a filter for `docker ps`. To filter you can use the format:

```
docker ps --filter "label=com.joyent.package=g4-standard-1G"
```

which would show you only those docker containers that are using the
`g4-standard-1G` package.

For both lookups with `docker ps --filter` and container creation with `docker
create` and `docker run`, you can specify any of package name, package UUID or
the first 8 characters of the package UUID. The order of precedence is:

 1. package UUID

     If the argument is a UUID, we'll only match UUID

 2. package name

     If the argument is /^[0-9a-f]{8}$/ and matches both a uuid and a name,
     the package with the name that matches is used. If the argument does not
     match the short-UUID pattern, and is not a UUID, it's only looked up
     against package names.

 3. short-UUID

     If the argument is /^[0-9a-f]{8}$/ and does not match a name, it will
     be looked up against the first 8 characters of the available package UUIDs.

if none of these match you will get an error.

In order to see the packages for your existing containers you can also do
something like:

```
docker ps -a --format '{{.ID}} {{.Label "com.joyent.package"}}'
```

which will output the id and package name for each container. If there are
problems looking up the name of the package because you no longer have access to
the package or the package is no longer active, you may see '<unknown>' as the
package name.
