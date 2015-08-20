# stats

Usage: docker stats CONTAINER [CONTAINER...]

Display a live stream of one or more containers' resource usage statistics

  --help=false       Print usage
  --no-stream=false  Disable streaming stats and only pull the first result

Example:

    $ docker stats redis1 redis2
    CONTAINER           CPU %               MEM USAGE / LIMIT     MEM %               NET I/O             BLOCK I/O
    redis1              0.07%               796 KB / 64 MB        1.21%               788 B / 648 B       3.568 MB / 512 KB
    redis2              0.07%               2.746 MB / 64 MB      4.29%               1.266 KB / 648 B    12.4 MB / 0 B


## Divergence

Whilst the major stats (CPU, network, memory) are covered, not all of the
underlying docker stats (cgroups) data points are available, see:

- [docker-stats.js](https://github.com/joyent/sdc-cn-agent/blob/master/bin/docker-stats.js)

## Related

- Insert a list of related Docker and CloudAPI methods here