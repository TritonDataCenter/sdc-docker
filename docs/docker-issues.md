# Docker Issue Links

Notes and links to docker issues and PRs on which Joyent engineers are involved
or which are particular relevant or interesting.


## Networking

libnetwork IRC discussions:
https://github.com/docker/docker/issues/8951#issuecomment-61872174

Networking survey: https://docs.google.com/a/docker.com/forms/d/1EK6j5pEE14dHrxB2DAkwjiMg0KzDpMN__o-QkIX9OcQ/viewform?c=0&w=1
https://docs.google.com/spreadsheets/d/1fNrTR25N6t9TEdEs5fHWGc3XQeydNCIvtwWBGMNwvvw/edit?pli=1#gid=1588369297


## Related to `docker top`

 * [Question about /container/id/top command #7205](https://github.com/docker/docker/issues/7205) (which lead to:)
 * [Proposal: Make API for `/containers/(id)/top` independent of implementation #9232](https://github.com/docker/docker/pull/9232)

## ZFS

 * [Implement Docker on ZFS](https://github.com/docker/docker/pull/7901). Has first functional version in branch.


## Related to `docker stats`

 * [Problems with implementation / doc mismatch on /stats](https://github.com/docker/docker/issues/10711).


## Problem with --restart

 * [Issue with --restart=no not being passed by client](https://github.com/docker/docker/issues/10874).
 * [The fix for #10874 made things worse](https://github.com/docker/docker/issues/12413).


## docker-machine

 * [Add option to skip SSH provisioning](https://github.com/docker/machine/issues/886)
