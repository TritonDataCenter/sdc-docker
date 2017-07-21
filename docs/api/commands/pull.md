# pull

    Usage: docker pull [OPTIONS] NAME[:TAG] | [REGISTRY_HOST[:REGISTRY_PORT]/]NAME[:TAG]

    Pull an image or a repository from the registry

      -a, --all-tags=false             Download all tagged images in the repository
      --disable-content-trust=true     Skip image verification

Most of your images will be created on top of a base image from the
[Docker Hub](https://hub.docker.com) registry.

[Docker Hub](https://hub.docker.com) contains many pre-built images that you
can `pull` and try without needing to define and configure your own.

It is also possible to manually specify the path of a registry to pull from.
For example, if you have set up a local registry, you can specify its path to
pull from it. A repository path is similar to a URL, but does not contain
a protocol specifier (`https://`, for example).

To download a particular image, or set of images (i.e., a repository),
use `docker pull`:

    $ docker pull debian
    # will pull the debian:latest image and its intermediate layers
    $ docker pull debian:testing
    # will pull the image named debian:testing and any intermediate
    # layers it is based on.
    $ docker pull debian@sha256:cbbf2f9a99b47fc460d422812b6a5adff7dfee951d8fa2e4a98caa0382cfbdbf
    # will pull the image from the debian repository with the digest
    # sha256:cbbf2f9a99b47fc460d422812b6a5adff7dfee951d8fa2e4a98caa0382cfbdbf
    # and any intermediate layers it is based on.
    # (Typically the empty `scratch` image, a MAINTAINER layer,
    # and the un-tarred base).
    $ docker pull --all-tags centos
    # will pull all the images from the centos repository
    $ docker pull registry.hub.docker.com/debian
    # manually specifies the path to the default Docker registry. This could
    # be replaced with the path to a local registry to pull from another source.
    # sudo docker pull myhub.com:8080/test-image

## Divergence

`docker pull -a` and `--disable-content-trust=true` are currently unsupported.
Follow [DOCKER-531](http://smartos.org/bugview/DOCKER-531) for updates.

The first status line from a `docker pull` shows a UUID:

    $ docker pull busybox
    latest: Pulling from busybox (67c12cfb-f717-4bc6-b3a9-b558becf4bbb)
    ...

That UUID is an "request id" for the pull. It can be useful for auditing
and internal debugging of sdc-docker.


## Related

- [`docker images`](../commands/images.md)
- [`docker rmi`](../commands/rmi.md)
