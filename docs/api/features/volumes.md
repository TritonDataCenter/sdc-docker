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

[DOCKER-793](https://smartos.org/bugview/DOCKER-793) implements the first pass
for supporting NFS shared volumes. The NFS shared volumes feature is described
in details by its corresponding [RFD
document](https://github.com/joyent/rfd/blob/master/rfd/0026/README.md).

To enable support for NFS shared volumes in Triton, run the following command
line from the headnode:

```
sdcadm experimental volapi
```

This command will create a new core zone that runs the VOLAPI service, which
implements the Volumes API. It will also enable the
`experimental_nfs_shared_volumes` metadata property in SAPI.

At this point, all `docker volume` commands are supported but only for the
`'tritonnfs'` volume driver, which provies support for NFS shared volumes. Note
that the `'tritonnfs'` volume driver needs to be specified in the `docker volume
create` command for it to work.

The `experimental_nfs_shared_volumes` SAPi setting can be set to `false` in SAPI
to disable support for NFS shared volumes by running the following command line:

```
sapiadm update $(sdc-sapi /services?name=docker | json -Ha uuid) metadata.experimental_nfs_shared_volumes=false
```

After disabling this setting, running `docker volume` commands will result in an
error message.
