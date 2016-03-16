# tag

    Usage: docker tag [OPTIONS] IMAGE[:TAG] [REGISTRYHOST/][USERNAME/]NAME[:TAG]

    Tag an image into a repository

## Divergence

Tag works the same in Triton SDC Docker and Docker Inc, except for below caveat:

 * in Triton SDC Docker, an image cannot have tags that reference two different
   registries. Example:

    ```
        $ docker tag 123456789 docker.io/user/tagname
        $ docker tag 123456789 quay.io/user/tagname   (different registry - fails)
    ```

## Related

- [`docker build`](../commands/build.md)
- [`docker push`](../commands/push.md)
