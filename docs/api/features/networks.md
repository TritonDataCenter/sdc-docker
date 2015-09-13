# Networking

If fabric networking is enabled for sdc-docker, each docker container is
provisioned with a private nic on the user's default fabric. This allows
only other docker containers provisioned on that fabric to connect to each
other. The container is able to reach the external internet via [Network
Address Translation](http://en.wikipedia.org/wiki/Network_address_translation).
Each default fabric network is private to a user - one user's containers cannot
connect to another's fabric IP addresses, and vice-versa.

To isolate the traffic between different applications or groups of applications,
users may use the CloudAPI to create additional networks on their fabric.
Any of these user-defined networks can be designated as the 'default' network
to be used for provisioning Docker containers. When you change the 'default'
network, it affects only the newly provisioned containers.

All docker containers owned by a user have firewalls enabled by default, and
their default policy is to block all incoming traffic and allow all outbound
traffic. All docker VMs have a
[Cloud Firewall](https://www.joyent.com/developers/firewall/) rule
automatically created that allows them to communicate with each other on all
ports.

If you specify the -p or -P options to `docker run` or `docker create`, the
container will receive an external IP address that is reachable over the public
internet, and [Cloud Firewall](https://www.joyent.com/developers/firewall/)
rules are automatically created that allow incoming traffic to the appropriate
ports from any IP address. For `-P`, this means all ports that the VM's image
exposes. For `-p`, this means all ports specified as arguments, up to a limit
of 128 TCP ports and 128 UDP ports. Remapping ports with `-p` (eg, `-p 80:8080`)
is not supported at this time. Follow [DOCKER-341](http://smartos.org/bugview/DOCKER-341)
for updates.

If fabric networking is not enabled, all docker containers are provisioned with
a nic on the 'external' network by default.


## Related

- [`sdc-fabric vlan`](https://apidocs.joyent.com/cloudapi/#CreateFabricVLAN) and `POST /my/fabrics/default/vlans` in CloudAPI
- [`sdc-fabric network`](https://apidocs.joyent.com/cloudapi/#CreateFabricNetwork) and `POST /my/fabrics/default/vlans/:id/networks` in CloudAPI
- [`sdc-fabric network set-default`](https://apidocs.joyent.com/cloudapi/#UpdateConfig) and `PUT /my/config` in CloudAPI
