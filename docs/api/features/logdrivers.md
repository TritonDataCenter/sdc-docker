# Log Drivers

With sdc-docker there is now (limited) support for the --log-driver and
--log-opts functions. Important differences include:

 * sdc-docker does not support the 'journald' driver at all
 * the '--log-opt syslog-address' can only be used with the tcp/udp format. The
   unix://path format is unsupported as that expects to write to arbitrary host
   locations.
 * the 'syslog-address' option is *required* when using the syslog log-driver
 * the 'fluentd-address' option is *required* when using the fluentd log-driver
 * when using any log drivers other than 'json-file' and 'none', additional
   processes will be running in your container to handle the logging. All hosts
   specified will be resolved from the container. This allows logging for
   example on a vxlan network which may not be exposed elsewhere.

The most important difference however is that the platform that you are using
on your CNs needs to support a given log driver before you'll be able to use it.
If you specify a log driver that is not supported by a CN that you're
provisioning to, one of the following will happen:

 * the driver will be ignored completely (on older platforms)
 * the VM will fail to boot after being created
 * the driver's options will be ignored (eg. max-file, max-size on json-file)

In order to reject these sooner so that this does not happen, we have added the
enabledLogDrivers config option which can be set through the SAPI metadata for
the docker service. In order to enable the json-file and none drivers for
example, you can run:

```
sdc-sapi /services/$(sdc-sapi /services?name=docker | json -Ha uuid) -X PUT -d '{ "metadata": { "ENABLED_LOG_DRIVERS": "json-file,none" } }'
```

from the headnode GZ once you've ensured that the platforms on all your CNs
support these drivers. Also note that all platforms that support LX docker
VMs will work with the json-file driver.
