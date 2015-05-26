# logout

    Usage: docker logout [SERVER]

    Log out from a Docker registry, if no server is
    specified "https://index.docker.io/v1/" is the default.

## Examples

    $ docker logout

If you want to logout from a self-hosted registry you can specify this by adding
the server name.

    $ docker logout myrepo.example.com

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc.
implementations of this method. Please contact Joyent support or file a ticket
if you discover any.

## Related

- [`docker login`](../commands/login.md)
