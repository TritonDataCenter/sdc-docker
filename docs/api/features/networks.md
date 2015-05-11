# Networking

If fabric networking is enabled for sdc-docker, each docker container is
provisioned with a private nic on the user's default fabric. This allows
only other docker containers provisioned on that fabric to connect connect to
each other. The container is able to reach the external internet via [Network
Address Translation](http://en.wikipedia.org/wiki/Network_address_translation).
Each default fabric network is private to a user - one user's containers cannot
connect to another's fabric IP addresses, and vice-versa.

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
of 8 TCP ports and 8 UDP ports. Remapping ports with `-p` (eg, `-p 80:8080`) is
not supported at this time.

If fabric networking is not enabled, all docker containers are provisioned with
a nic on the 'external' network by default.