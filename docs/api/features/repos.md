# Private registries

SDC-Docker supports the use of Docker images maintained in the following registries:

- Docker Hub's public registry
- Docker Hub's private registry
- Self-hosted Docker registry, including Docker Trusted Registry
- quay.io Docker registry
- jFrog Artifactory Docker registry

Note that Triton sdc-docker only supports v2 registries.

You can connect to multiple registries at the same time and pull images from them
without having to switch from one to another.

## Logging into private registries

Before searching for or pulling images from the private registries, authenticate to
the registry using the `docker login` command:

    $ docker login [$registryEndpoint]
    Username: myrepo
    Password:
    Email: user@example.com

When no endpoint is specified, "https://index.docker.io/v1/" is the assumed target.

Docker client saves your login information in a local configuration file so that
you can keep using the registry without re-authenticating every time.

For docker client v1.7 or earlier, the registry configurations are located in $HOME/.dockercfg.
For docker client v1.8 or later, the registry configurations are located in $HOME/.docker/config.json.

When you no longer need a certain registry, you may want to log out from it to erase
the registry configuration to prevent unauthorized use. 

    $ docker logout [$registryEndpoint]
    Remove login credentials for https://index.docker.io/v1/

Note that some third-party registries may not have full support for `docker login`
which generates the docker configuration on your client machine. In those cases,
you will have to add the configuration on your own, modeling after the json format and
hashing scheme for credentials created by `docker login` for docker.io, e.g.

    {
        "https://myrepo.artifactoryonline.com/v1/": {
                "auth": "YFNrZm9u99k6cm9qbzA3",
                "email": "user@example.com"
        },
        "https://index.docker.io/v1/": {
                "auth": "YFNrZm9u99k6cm9qbzA3",
                "email": "user@example.com"
        }
    }

## Using images in private registries

An image is uniquely identified by the registry endpoint, repo/image name and tag.
When the registry name is omitted, the image lookup is made in the Docker Hub
public and private registries.

    $ docker pull myrepo/busybox
    Pulling repository docker.io/myrepo/busybox
    ...

    $ docker run -d quay.io/coreos/etcd
    Unable to find image 'quay.io/coreos/etcd:latest' locally
    latest: Pulling from quay.io/coreos/etcd
    ...

## Using images in self-hosted registries

All self-hosted private repos should have a fully qualified domain name and an
authority-signed certificate for production use. If you need to work with a
test registry that has only a self-signed certificate during the development
cycle, you can do so by enabling the insecure registry setting on your SDC:

    sapiadm update $(sdc-sapi /applications?name=sdc | json -Ha uuid) 
        metadata.docker_registry_insecure=true
