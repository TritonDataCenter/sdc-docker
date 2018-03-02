# inspect

    Usage: docker inspect [OPTIONS] CONTAINER|IMAGE [CONTAINER|IMAGE...]

    Return low-level information on a container or image

      -f, --format=""            Format the output using the given go template
      -s, --size                 Display total file sizes if the type is container
      --type=container|image     Return JSON for specified type, permissible
                                 values are "image" or "container"

By default, this will render all results in a JSON array. If a format is
specified, the given template will be executed for each result.

Go's [text/template](http://golang.org/pkg/text/template/) package
describes all the details of the format.

## Examples

**Get an instance's IP address:**

For the most part, you can pick out any field from the JSON in a fairly
straightforward manner.

    $ docker inspect --format='{{.NetworkSettings.IPAddress}}' $INSTANCE_ID

**Get an instance's MAC Address:**

For the most part, you can pick out any field from the JSON in a fairly
straightforward manner.

    $ docker inspect --format='{{.NetworkSettings.MacAddress}}' $INSTANCE_ID

**Get an instance's log path:**

    $ docker inspect --format='{{.LogPath}}' $INSTANCE_ID

**List All Port Bindings:**

One can loop over arrays and maps in the results to produce simple text
output:

    $ docker inspect --format='{{range $p, $conf := .NetworkSettings.Ports}} {{$p}} -> {{(index $conf 0).HostPort}} {{end}}' $INSTANCE_ID

**Find a Specific Port Mapping:**

The `.Field` syntax doesn't work when the field name begins with a
number, but the template language's `index` function does. The
`.NetworkSettings.Ports` section contains a map of the internal port
mappings to a list of external address/port objects, so to grab just the
numeric public port, you use `index` to find the specific port map, and
then `index` 0 contains the first object inside of that. Then we ask for
the `HostPort` field to get the public address.

    $ docker inspect --format='{{(index (index .NetworkSettings.Ports "8787/tcp") 0).HostPort}}' $INSTANCE_ID

**Get config:**

The `.Field` syntax doesn't work when the field contains JSON data, but
the template language's custom `json` function does. The `.config`
section contains complex JSON object, so to grab it as JSON, you use
`json` to convert the configuration object into JSON.

    $ docker inspect --format='{{json .config}}' $INSTANCE_ID

## Divergence

Some fields, including the following, are irrelevent to containers on Triton and are never populated.

- AppArmorProfile
- Config: Cpuset, CpuPeriod, CpusetCpus, CpusetMems, CpuQuota, BlkioWeight, ConsoleSize, GroupAdd, LogConfig,
  MemorySwappiness, OomKillDisable, Privileged, PortBindings, Ulimits, VolumeDriver
- GraphicDriver: All
- HostConfig: CapAdd, CapDrop, IpcMode, LxcConf, PublishService, SecurityOpt
- Mounts: All
- NetworkSettings: EndpointID, GlobalIPv6Address, GlobalIPv6PrefixLen, HairpinMode, IPv6Gateway,
  LinkLocalIPv6Address, LinkLocalIPv6PrefixLen, NetworkID, PortMapping, SandboxKey
  SecondaryIPAddresses, SecondaryIPv6Addresses
- State: Dead, OOMKilled

Also note that the Config.Labels will include the special 'com.joyent.package'
value which will be set to the current name of the package associated with this
VM.

Read more about container [security on Triton](features/security.md) and see [notes about exit status](../divergence.md).

The `-s` and `--size` options are currently unsupported.

Please contact Joyent support or file a ticket if you discover any additional divergence.

## Related

- [`docker port`](../commands/port.md) as in `docker port $(docker ps -l -q)`
- [`sdc-getmachine`](https://apidocs.joyent.com/cloudapi/#GetMachine) and `GET /my/machines/:id` in CloudAPI
