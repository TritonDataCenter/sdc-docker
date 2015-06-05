title: Private repositories
----
text:

SDC-Docker supports the use of Docker images maintained in Docker Hub's public
or private repos, or in self-hosted Docker repos in your own application
environment. Images are uniquely identified by the repo endpoint and namespace,
i.e. [REPOHOST_OR_NAMESPACE/]IMAGE_NAME[:TAG]. You may connect to multiple repos
at the same time and pull images from them without having to switch from one to
another.

## Using images in Docker Hub private repo

If no server is specified, "https://index.docker.io/v1/" is the default. For example:

    $ docker login
    Username: myrepo
    Password:
    Email: user@example.com

    $ docker pull myrepo/busybox
    Pulling repository docker.io/myrepo/busybox
    ...

    $ docker run -it myrepo/busybox bash

    $ docker logout
    Remove login credentials for https://index.docker.io/v1/

`docker pull` and `docker run` operations go across Docker Hub's public repo and
the private repos you have logged in. `docker search` operation is confined to
only the public repo, as with Docker Inc. docker.

## Using images in self-hosted private repo

All self-hosted private repos should have a fully qualified domain name and an
authority-signed certificate. The end-point should be referenced in the image
name when using docker pull/run/create operations.

    $ docker login myrepo.example.com

    $ docker pull myrepo.example.com/busybox

    $ docker run -it myrepo.example.com/busybox bash

    $ docker logout myrepo.example.com
