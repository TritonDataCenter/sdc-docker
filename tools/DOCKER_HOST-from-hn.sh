#!/bin/sh
#
# Dump 'export DOCKER_HOST=...' as appropriate for the sdc-docker running
# on the given headnode.
#
# Example:
#       $ ./tools/DOCKER_HOST-from-hn.sh root@10.99.99.7
#       export DOCKER_HOST=tcp:...
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail

HN=$1
if [[ -z "$HN" ]]; then
    echo 'DOCKER_HOST-from-hn.sh: error: no HN argument given' >&2
    echo '' >&2
    echo 'usage:' >&2
    echo '    ./tools/DOCKER_HOST-from-hn.sh HN' >&2
    echo '    source `./tools/DOCKER_HOST-from-hn.sh HN`' >&2
    exit 1
fi

echo export DOCKER_HOST=tcp://$(ssh $HN 'vmadm lookup alias=docker0 | xargs -n1 vmadm get | json nics.0.ip' 2>/dev/null):2375
