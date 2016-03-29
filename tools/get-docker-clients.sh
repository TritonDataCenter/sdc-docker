#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016, Joyent, Inc.
#

#
# Get 'docker' client binaries (from {get,test}.docker.com) to the current dir.
# By default it will get all the Docker client versions that sdc-docker.git
# cares about. If given versions it will just download those.
#
# Usage:
#       cd ~/opt/dockers
#       ~/sdc-docker/tools/get-docker-clients.sh
#
#       # Get just a particular version:
#       cd ~/opt/dockers
#       ~/sdc-docker/tools/get-docker-clients.sh 1.11.0-rc2
#


if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail
set -o nounset


# ---- globals

# Note: Should keep this in sync with "DOCKER_AVAILABLE_CLI_VERIONS"
# https://github.com/joyent/sdc-docker/blob/master/test/runtest.common#L54
DEFAULT_VERS="1.11.0-rc2 1.10.3 1.9.1 1.8.3 1.7.1 1.6.2"

WRKDIR=/var/tmp/tmp.get-docker-clients
DSTDIR=$(pwd)
OS=$(uname)


# ---- support functions

function fatal
{
    echo "" >&2
    echo "* * *" >&2
    printf "$NAME: fatal error: $*\n" >&2
    exit 1
}


function get_docker_client
{
    local ver
    ver="$1"

    if [[ ! -f $DSTDIR/docker-$ver ]]; then
        if [[ "${ver%-*}" == "$ver" ]]; then
            URL=https://get.docker.com  # not a pre-release
        else
            URL=https://test.docker.com
        fi
        if [[ ${ver:0:4} == "1.6." ]]; then
            echo "# Getting docker-$ver (from $URL/builds/$OS/x86_64/docker-$ver)"
            curl -sS -o $DSTDIR/docker-$ver $URL/builds/$OS/x86_64/docker-$ver
        else
            echo "# Getting docker-$ver (from $URL/builds/$OS/x86_64/docker-$ver.tgz)"
            rm -rf $WRKDIR
            mkdir -p $WRKDIR
            cd $WRKDIR
            curl -OsS $URL/builds/$OS/x86_64/docker-$ver.tgz
            tar xf docker-$ver.tgz
            cp usr/local/bin/docker $DSTDIR/docker-$ver
            rm -rf $WRKDIR
        fi
        chmod 755 $DSTDIR/docker-$ver
        $DSTDIR/docker-$ver --version
    else
        echo "# Already have docker-$ver"
        $DSTDIR/docker-$ver --version
    fi
}



# ---- mainline

versions="$@"
if [[ -z "$versions" ]]; then
    versions="$DEFAULT_VERS"
fi

for ver in $versions; do
    get_docker_client "$ver"
done
