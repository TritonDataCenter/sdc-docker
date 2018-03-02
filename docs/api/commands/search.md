# search

Search [Docker Hub](https://hub.docker.com) for images

    Usage: docker search [OPTIONS] TERM

    Search the Docker Hub for images

      -f, --filter         Filter output based on conditions provided (default [])
      --limit              Max number of search results (default 25)
      --no-trunc=false     Don't truncate output
      -s, --stars=0        Only displays with at least x stars

See [*Find Public Images on Docker Hub*](
/userguide/dockerrepos/#searching-for-images) for
more details on finding shared images from the command line.

> **Note:**
> Search queries will only return up to 25 results

## Divergence

- `-f`, `--filter` and `--limit` options are unsupported.

## Related

- [`docker pull`](../commands/pull.md)
