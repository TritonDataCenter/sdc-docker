# Private repositories

SDC-Docker supports the use of Docker images maintained in Docker Hub's public or private repos, or in self-hosted Docker repos hosted in your own application environment.  Images are uniquely identified by the repo namespace, i.e. [REPOHOST_OR_NAMESPACE/]IMAGE_NAME[:TAG]. You may connect to multiple repos at the same time and pull images from them without having to switch from one to another.

## Using images with private repo hosted on Docker Hub

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

In `docker pull` and `docker run`, the image search goes across Docker Hub's public repo and the private repos you have logged in. As with Docker Inc. docker, `docker search` operation is confined to only the public repo.

## Using images with private repo hosted outside of Docker Hub

All self-hosted private repos should have a fully qualified domain name and an authority-signed certificate. The end-point should be referenced in the image name when using docker pull/run/create operations.

    $ docker login myrepo.example.com
    Username: myrepo
    Password: 
    Email: user@example.com

    $ docker pull myrepo.example.com/busybox

    $ docker run -it myrepo.example.com/busybox bash

    $ docker logout myrepo.example.com
 

