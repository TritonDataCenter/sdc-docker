# search

Search [Docker Hub](https://hub.docker.com) for images

    Usage: docker search [OPTIONS] TERM

    Search the Docker Hub for images

      --automated=false    Only show automated builds
      --no-trunc=false     Don't truncate output
      -s, --stars=0        Only displays with at least x stars

See [*Find Public Images on Docker Hub*](
/userguide/dockerrepos/#searching-for-images) for
more details on finding shared images from the command line.

> **Note:**
> Search queries will only return up to 25 results

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc.
implementations of this method. Please contact Joyent support or file a ticket
if you discover any.

## Related

- [`docker pull`](../commands/pull.md)
