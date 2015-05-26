# login

    Usage: docker login [OPTIONS] [SERVER]

    Register or log in to a Docker registry server, if no server is
    specified "https://index.docker.io/v1/" is the default.

      -e, --email=""       Email
      -p, --password=""    Password
      -u, --username=""    Username


## Examples

    $ docker login

If you want to login to a self-hosted registry you can specify this by adding
the server name.

    $ docker login myrepo.example.com

## Divergence

The SDC Docker implementation does not support third-party registries at this
time. Follow [DOCKER-380](https://smartos.org/bugview/DOCKER-380) for progress
updates. As well, currently only Docker Registry v1 is supported. Follow
[DOCKER-112](https://smartos.org/bugview/DOCKER-112) for progress updates.

Self-hosted private repos that use self-signed certificates are not supported.
Follow [DOCKER-382](https://smartos.org/bugview/DOCKER-382) for progress
updates. See also [Private repositories](../features/repos.md).

Please contact Joyent support or file a ticket if you discover any additional
divergence.

## Related

- [`docker logout`](../commands/logout.md)
- [`docker pull`](../commands/pull.md)
