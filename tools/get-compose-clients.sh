#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2018, Joyent, Inc.
#

# Get 'docker' client binaries (from
# https://github.com/docker/compose/releases/download/{{compose_version}}/) By
# default it will get all the docker-compose client versions that sdc-docker.git
# cares about. If given versions it will just download those.
#
# Usage:
#       cd ~/opt/dockers
#       ~/sdc-docker/tools/get-compose-clients.sh
#
#       # Get just a particular version:
#       cd ~/opt/dockers
#       ~/sdc-docker/tools/get-compose-clients.sh 1.11.0
#


if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail
set -o nounset


# ---- globals

# Note: Should keep this in sync with "COMPOSE_AVAILABLE_CLI_VERIONS"
DEFAULT_VERS="1.9.0"

WRKDIR=/var/tmp/tmp.get-docker-clients
DSTDIR=$(pwd)
OS=$(uname)
ARCH=x86_64
COMPOSE_RELEASES_BASE_URL=https://github.com/docker/compose/releases/download

# ---- support functions

function fatal
{
    echo "" >&2
    echo "* * *" >&2
    printf "$NAME: fatal error: $*\n" >&2
    exit 1
}


function get_compose_client
{
    local ver
    ver="$1"

    if [[ ! -f $DSTDIR/docker-compose-$ver ]]; then
        echo "# Getting docker-compose-$ver"
        curl -OsS $COMPOSE_RELEASES_BASE_URL/$ver/docker-compose-$OS-$ARCH
        mv docker-compose-$OS-$ARCH $DSTDIR/docker-compose-$ver
        chmod 755 $DSTDIR/docker-compose-$ver
        $DSTDIR/docker-compose-$ver --version
    else
        echo "# Already have docker-compose-$ver"
        $DSTDIR/docker-compose-$ver --version
    fi
}

# ---- mainline

versions="$@"
if [[ -z "$versions" ]]; then
    versions="$DEFAULT_VERS"
fi

for ver in $versions; do
    get_compose_client "$ver"
done
