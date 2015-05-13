# Resource Allocation

When using sdc-docker, you can specify a `-m` value for memory and sdc-docker
will select the container package that best matches the resources requested.
If there is no package available with the value specified, it will round up to
the nearest package. The package parameters can be found using the node-smartdc
tools and specifically the 'sdc-listpackages' tool.

The package will be used to determine such things as:

 * CPU shares
 * DRAM (memory)
 * Disk quota
 * I/O priority

appropriate for the system your container is provisioned to.
