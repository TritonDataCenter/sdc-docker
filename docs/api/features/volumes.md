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

## Experimental support for NFS shared volumes

The NFS shared volumes feature is described in detail by its corresponding [RFD
document](https://github.com/joyent/rfd/blob/master/rfd/0026/README.md).

To enable support for NFS shared volumes in Triton, run the following command
line from the head node:

```
sdcadm post-setup volapi
sdcadm experimental docker-nfs-volumes
sdcadm experimental docker-nfs-volumes-automount
```

This command will create a new core zone that runs the VOLAPI service, which
implements the Volumes API. It will also enable the
`experimental_docker_nfs_shared_volumes` and
`experimental_docker_automount_nfs_shared_volumes` metadata properties in SAPI.

At this point, all `docker volume` commands are supported but only for the
`'tritonnfs'` volume driver, which provides support for NFS shared volumes. Note
that the `'tritonnfs'` volume driver is considered to be the default and thus
does not need to be specified in the `docker volume create` command for it to
work.

The `experimental_docker_nfs_shared_volumes` SAPI flag can be set to `false` in
SAPI to disable support for NFS shared volumes by running the following command
line:

```
sdcadm experimental docker-nfs-volumes -d
```

After disabling this setting, running `docker volume` commands will result in an
error message.
