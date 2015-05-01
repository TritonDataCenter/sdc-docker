# version

    Usage: docker version

    Show the Docker version information.

Show the Docker version, API version, Git commit, Go version and OS/architecture
of both Docker client and daemon. Example use:

    $ docker version
    Client version: 1.5.0
    Client API version: 1.17
    Go version (client): go1.4.1
    Git commit (client): a8a31ef
    OS/Arch (client): darwin/amd64
    Server version: 1.5.0
    Server API version: 1.17
    Go version (server): go1.4.1
    Git commit (server): a8a31ef
    OS/Arch (server): linux/amd64

## Divergence

Known differences:

- Server version reflects the sdc-docker version, which will vary from the Docker Inc. daemon version.
- Go version on the server is actually a node.js version.

Please contact Joyent support or file a ticket if you discover any additional differences.

## Related

- Insert a list of related Docker and CloudAPI methods here