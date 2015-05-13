# Restart policies

The way containers are restarted with sdc-docker:

 * if you specify --restart=no (the default):
     * if the node your container is on is rebooted, your container will be off
     * if your container process exits (regardless of exit status) your
       container will remain off unless you start it.
 * if you specify --restart=always:
     * if the node your container is on is rebooted, and your container was
       running at the time of the reboot, your container will be started when
       the node boots.
     * if your container process exits (regardless of exit status), the
       container will be restarted and the RestartCount will be incremented
       (see below on delays between restarts).
 * if you specify --restart=on-failure[:maxretries]:
     * if the node your container is on is rebooted, your container will only
       be started when the node boots if the init process of your container
       exited non-zero as part of the CN reboot.
     * if your container process exits with a non-zero exit status, the
       container will be restarted and the RestartCount will be incremented.
       If you specified a maxretries and this is reached, the container will
       be stopped and not restarted again automatically.
     * if your container process exits with a zero status, the container will
       not be restarted again automatically.

When restarting your container automatically (the cases mentioned above) there
is a delay between restarts in order to prevent things from going haywire.
sdc-docker uses the same delay frequency as Docker Inc's docker. This means that
after exiting but before starting again we delay ((2 ^ RestartCount) * 100) ms.
So on the first restart (with RestartCount = 0) we will delay 100ms, then 200,
then 400, etc. The amount of delay is not guaranteed. In the case of a CN reboot
or in other operational situations a retry may occur sooner.

The main way that this is different from Docker Inc's docker is that with Docker
Inc's docker, if you restart the docker daemon all containers will be stopped
and those with --restart=always will be started again. With sdc-docker
restarting the management systems will not touch your container but restarting
the compute node the container lives on will.

If you want your container to always be running you most likely want to specify
--restart=always to avoid your containers being stopped when a CN reboots.
