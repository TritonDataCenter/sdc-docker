# SmartOS containers

Unlike Docker Inc's docker, sdc-docker supports running containers that are
SmartOS-native. Currently this functionality is limited but it is a divergence
from docker. If you specify a UUID of an image that has been imported into
the local imgapi and has the os set to 'smartos', the container will be started
with a joyent-minimal brand instead of lx and will use that image.

