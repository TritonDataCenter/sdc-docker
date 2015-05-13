# top

    Usage: docker top CONTAINER [ps OPTIONS]

    Display the running processes of a container

## Divergence

- With SDC Docker, `docker top` does not currently support the `ps_args` option and always returns results in the same format. This format is hardcoded pending upstream integration of some solution to the issues described in https://github.com/docker/docker/pull/9232.

Please contact Joyent support or file a ticket if you discover any other divergence.

## Related

- [`Analytics`](https://apidocs.joyent.com/cloudapi/#analytics) in CloudAPI
- [`prstats`](https://smartos.org/man/1M/prstat) SmartOS utility
