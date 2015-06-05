title: Volumes
----
text:

With sdc-docker, host volumes work differently than on Docker Inc's docker.

 * there is a limit of 8 'data' volumes per container
 * there is a limit of 1 'host' volume per container
 * there is a limit of 1 --volumes-from argument per container
 * 'host' volumes must be http[s] URLs, not paths in the docker host
 * the 'host' volume URL's must each refer to a single file
 * all 'host' volumes are read-only
 * the container path of a 'host' volume must not contain any symlinks
 * you cannot delete a container which has a volume that another container is
   sharing (via --volumes-from), you must first delete all containers using that
   volume.
 * 'host' volumes are not shared through --volumes-from
 * 'host' volume (URL) downloads have a limit of 60 seconds. If this timeout is
   reached, your container will not boot.
 * 'host' volume (URL) downloads have a limit of 10MiB of data. If this limit is
   reached, your container will not boot.
 * 'host' volume (URL) downloads have a limit of 2 HTTP redirects. If this limit
   is reached, your container will not boot.
 * If the remote host is unavailable when you're booting your container and you
   have used a 'host' volume (URL), your container will not boot.
 * When you use --volumes-from you are necessarily coprovisioned with the
   container you are sharing the volumes from. If the physical host on which
   the source container exists does not have capacity for the new container,
   provisioning a new container using --volumes-from will fail.
 * When you use --volumes-from, volumes that don't belong to the container
   specified (including those that this container is sharing from others) are
   ignored. Only volumes belonging to the specified container will be
   considered.

In general, `-v <URL>:/container/path` is intended to be used for things like
configuration files in order to seed data into containers. Any use-case where
data is intended to be read-write or when more than one file is required it is
preferable to create a container with a volume and --volumes-from that container
if you need the data stored independently of the container.