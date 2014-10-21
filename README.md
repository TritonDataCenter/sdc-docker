# docker.js

TODO: Implement Docker in node.js




# Development

FWIW, here is how Trent is doing it. (This presumes you have a 'coal'
entry in your '~/.ssh/config'.)

- Get a clone on your Mac:

        git clone git@git.joyent.com:docker.js.git
        cd docker.js

- Get a first install to /opt/smartdc/docker.js:

        mget -O /Joyent_Dev/stor/tmp/docker.js.sh
        scp docker.js.sh coal:/var/tmp
        ssh coal sh /var/tmp/docker.js.sh

- Make your changes:

        vi

- Sync your local changes to the install on COAL:

        ./tools/rsync-to coal

- Test away. I tend to have a shell open tailing the docker
  svc log:

        ssh coal
        tail -f `svcs -L docker` | bunyan

- ... repeat ...

- Check before commit:

        make check

