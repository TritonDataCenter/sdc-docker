# version

    Usage: docker version

    Show the Docker version information.

      -f, --format=""    Format the output using the given go template

Show the Docker version, API version, Git commit, Go version and OS/architecture
of both Docker client and daemon. Example use:

    $ docker version
    Client:
     Version:      1.8.0
     API version:  1.20
     Go version:   go1.4.2
     Git commit:   f5bae0a
     Built:        Tue Jun 23 17:56:00 UTC 2015
     OS/Arch:      linux/amd64

    Server:
     Version:      1.8.0
     API version:  1.20
     Go version:   go1.4.2
     Git commit:   f5bae0a
     Built:        Tue Jun 23 17:56:00 UTC 2015
     OS/Arch:      linux/amd64    Client version: 1.5.0

## Divergence

Known differences:

- Server version reflects the sdc-docker version, which will vary from the Docker Inc. daemon version.
- Go version on the server is actually a node.js version.

Please contact Joyent support or file a ticket if you discover any additional differences.

## Related

- Insert a list of related Docker and CloudAPI methods here
