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

See also [Private registries](../features/repos.md) for more information.

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc.
implementations of this method. Please contact Joyent support or file a ticket
if you discover any.

## Related

- [`docker logout`](../commands/logout.md)
- [`docker pull`](../commands/pull.md)
