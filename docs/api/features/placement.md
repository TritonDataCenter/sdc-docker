# Placement

When using Docker with a Triton data center (a.k.a. SDC) as your Docker Host,
your Docker containers can be placed on any physical server in the data center.
This is one of the basic benefits of Triton's Docker solution: with just the
vanilla `docker` client you can get the benefit of spreading your containers
across multiple servers, setting the groundwork for high availability (HA)
services and avoiding single points of failure (SPOF).

This document explains how Triton places new containers on servers and what
facilities are exposed for controlling placement.


## Default placement

By default, Triton makes a reasonable attempt to spread all containers (and
non-Docker containers and VMs) owned by a single account across separate
physical servers.

Within a Docker container the physical server on which a container is running
is exposed via the [`sdc:server_uuid` metadata
key](http://eng.joyent.com/mdata/datadict.html):

    $ docker run -ti --rm alpine /bin/sh
    / # hostname
    cc72c36cb591
    / # /native/usr/sbin/mdata-get sdc:server_uuid
    44454c4c-5400-1034-8052-b5c04f383432

By running another container we can see this default spread behavior (the
`server_uuid` differs):

    $ docker run -ti --rm alpine /bin/sh
    / # hostname
    98d5a22a0c5e
    / # /native/usr/sbin/mdata-get sdc:server_uuid
    44454c4c-4400-1054-8052-b5c04f383432

Outside the containers, the physical server on which a container is running
is exposed via the `compute_node` field using the [Triton
CLI](https://github.com/joyent/node-triton):

    $ triton insts -o shortid,name,age,compute_node
    SHORTID   NAME             AGE  COMPUTE_NODE
    cc72c36c  serene_bose      6m   44454c4c-5400-1034-8052-b5c04f383432
    98d5a22a  goofy_engelbart  2m   44454c4c-4400-1054-8052-b5c04f383432

Note that [there are many factors in placement
decisions](https://github.com/joyent/sdc-designation/blob/master/docs/index.md),
including DC operator-controlled spread policies, so results may vary.


## Swarm affinity

[Docker Swarm](https://docs.docker.com/swarm/overview/) is a system to allow you
to talk to a pool of Docker hosts (a.k.a. nodes) as a single virtual Docker
host. `docker run` against a Swarm master will choose a node on which to run
your container. Sometimes it matters which node is selected -- my
webhead should run near the redis it uses for caching, this database instance
should *not* be on the same node as other database instances in the HA cluster.
Swarm defines "filters" for node selection, and in particular ["affinity
filters"](https://docs.docker.com/swarm/scheduler/filter/#use-an-affinity-filter)
where node selection is described in terms of existing containers. For example:

    docker run --name db1 -e 'affinity:container!=db0' -d mysql
    #                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    # Run a mysql instance that is NOT on the same node as container 'db0'.

For the same reasons, node selection can matter on Triton. Triton's Docker
implements the same affinity filters as documented for Docker Swarm, with the
difference that you don't need to setup a Swarm cluster.


### Affinity filter syntax

An affinity filter is an argument to `docker run` or `docker create` using
either (a) environment variables:

    docker run -e 'affinity:<filter>' ...

or (b) labels. (Note: At the time of writing the label syntax was in Docker
Swarm [code](https://github.com/docker/swarm/blob/d9beef7/cluster/config.go#L83-L86),
but not [documented](https://docs.docker.com/swarm/scheduler/filter/).)

    docker run --label 'com.docker.swarm.affinities=["<filter>",...]' ...


A `<filter>` is one of the following. (Note: Swarm defines "image filters"
which don't apply for Triton because any image in the datacenter is available
for any node.)

- A container filter: `container<op><value>`
- A label filter: `<label><op><value>`

`<op>` is one of:

- `==`: The new container must be on the same node as the container(s)
  identified by `<value>`.
- `!=`: The new container must be on a different node as the container(s)
  identified by `<value>`.
- `==~`: The new container should be on the same node as the container(s)
  identified by `<value>`. I.e. this is a best effort or "soft" rule.
- `!=~`: The new container should be on a different node as the container(s)
  identified by `<value>`. I.e. this is a best effort or "soft" rule.

*Divergence:* There is a limitation that a mix of hard and soft (`~`) filters
is not supported. If both kinds are given, the soft affinities will be ignored.

`<value>` is an exact string, simple `*`-glob, or regular expression to
match against container names or IDs, or against the given label name.
(See also the [Docker Swarm filter expression
documentation](https://docs.docker.com/swarm/scheduler/filter/#how-to-write-filter-expressions)).

Some examples:

    # Run on the same node as silent_bob:
    docker run -e 'affinity:container==silent_bob' ...

    # Same, using the label syntax:
    docker run --label 'com.docker.swarm.affinities=["container==silent_bob"]' ...

    # Run on a different node as all containers labelled with 'role=database':
    docker run -e 'affinity:role!=database' ...

    # Run on a different node to all containers with names starting with "foo":
    docker run -e 'affinity:container!=foo*' ...

    # Same, using a regular expression:
    docker run -e 'affinity:container!=/^foo/' ...

Note: At the time of writing the label syntax is in Docker Swarm
[code](https://github.com/docker/swarm/blob/d9beef7/cluster/config.go#L83-L86),
but not [documented](https://docs.docker.com/swarm/scheduler/filter/).


### Affinity in the Triton CLI

For users of both Docker and non-Docker containers (and VMs) on Triton, the
`triton` CLI for creating and running containers supports a similar affinity
syntax:

    # Run on the same node as silent_bob:
    triton create -a 'container==silent_bob' ...

    # Run on a different node to 'db0':
    triton create -a 'container!=db0' ...


## Placement failure

The use of affinity rules can mean the placement is impossible. For example:

- a rule requiring that a new container land on the same server as container0
  and container1 when those two are already on separate servers; or
- a rule requiring that a new container land on a particular server, but that
  server does not have enough resources for the new container.

A current limitation is that the error returned with `docker run` for the
above cases is not differentiated from the general error of the data center
being out of resources:

```
$ docker --tls run --name db1 -e 'affinity:container!=db0' alpine hostname
docker: Error response from daemon: (DockerNoComputeResourcesError) No compute resources available. (cb792af0-08b4-11e6-9922-231469062e7b).
See 'docker run --help'.
```

[This issue](https://smartos.org/bugview/DOCKER-815) is being used to track
this limitation.
