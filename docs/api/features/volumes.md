# Volumes

With sdc-docker, there are some limitations on volumes that are slightly
different from Docker Inc's docker:

 * there is a limit of 8 'data' volumes per container
 * 'host' volumes (/hostpath:/containerpath) are not supported
 * you cannot delete a container which has a volume that another container is
   sharing (via --volumes-from), you must first delete all containers using that
   volume.
 * there is a limit of 1 --volumes-from argument per container
 * When you use --volumes-from you are necessarily coprovisioned with the
   container you are sharing the volumes from. If the physical host on which
   the source container exists does not have capacity for the new container,
   provisioning a new container using --volumes-from will fail.
 * When you use --volumes-from, volumes that don't belong to the container
   specified (including those that this container is sharing from others) are
   ignored. Only volumes belonging to the specified container will be
   considered.
