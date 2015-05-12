# Resource selection

When using sdc-docker, you can specify a `-m` value for memory and sdc-docker
if there is no package available with this value, it will round up to the
nearest package. The package parameters can be found using the node-smartdc
tools and specifically the 'sdc-listpackages' tool.

The package will be used to determine such things as:

 * CPU shares
 * DRAM (memory)
 * Disk quota
 * I/O priority

appropriate for the package and system your container is provisioned to.