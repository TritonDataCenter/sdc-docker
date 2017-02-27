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
# As well, if there is a matching "docker debug" build, it will install that
# as well (use 'EXCLUDE_DOCKER_DEBUG' env variable to disable debug build
# installation). Docker debug builds are maintained by Todd when he gets around
# to it, and are uploaded to us-east Manta at:
#       /Joyent_Dev/public/docker/docker_debug/
#
# Usage:
#       cd ~/opt/dockers
#       ~/sdc-docker/tools/get-docker-clients.sh
#
#       # Get just a particular version:
#       cd ~/opt/dockers
#       ~/sdc-docker/tools/get-docker-clients.sh 1.11.0
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
DEFAULT_VERS="1.12.2 1.11.1 1.10.3 1.9.1 1.8.3"

WRKDIR=/var/tmp/tmp.get-docker-clients
DSTDIR=$(pwd)
OS=$(uname)
ARCH=x86_64


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
            echo "# Getting docker-$ver (from $URL/builds/$OS/$ARCH/docker-$ver)"
            curl -sS -o $DSTDIR/docker-$ver $URL/builds/$OS/$ARCH/docker-$ver
        else
            echo "# Getting docker-$ver (from $URL/builds/$OS/$ARCH/docker-$ver.tgz)"
            rm -rf $WRKDIR
            mkdir -p $WRKDIR
            cd $WRKDIR
            curl -OsS $URL/builds/$OS/$ARCH/docker-$ver.tgz
            tar xf docker-$ver.tgz
            # Different tarballs use different locations...
            if [[ -f docker/docker ]]; then
                cp docker/docker $DSTDIR/docker-$ver
            else
                cp usr/local/bin/docker $DSTDIR/docker-$ver
            fi
            rm -rf $WRKDIR
        fi
        chmod 755 $DSTDIR/docker-$ver
        $DSTDIR/docker-$ver --version
    else
        echo "# Already have docker-$ver"
        $DSTDIR/docker-$ver --version
    fi
}


function get_docker_debug_client
{
    local ver
    ver="$1"

    local name=docker-$ver-debug
    local mdir=/Joyent_Dev/public/docker/docker_debug
    local mpath=$mdir/docker-$ver-$OS-$ARCH-debug
    local murl=https://us-east.manta.joyent.com$mpath

    if [[ -f $DSTDIR/$name ]]; then
        echo "# Already have $name"
        $DSTDIR/$name --version
    elif [[ "$((curl -s -X HEAD -i $murl || true) | head -1 | awk '{print $2}')" == "404" ]]; then
        # Be silent about this for now.
        #echo "# No debug build for this version: $mpath"
        true
    else
        echo "# Getting $name (from Manta $mpath)"
        curl -sS -o $DSTDIR/$name $murl
        chmod 755 $DSTDIR/$name
        $DSTDIR/docker-$ver --version
    fi
}



# ---- mainline

versions="$@"
if [[ -z "$versions" ]]; then
    versions="$DEFAULT_VERS"
fi

# Exclude debug versions when this env variable is set.
EXCLUDE_DOCKER_DEBUG=${EXCLUDE_DOCKER_DEBUG:-}

for ver in $versions; do
    get_docker_client "$ver"
    if [[ -z "$EXCLUDE_DOCKER_DEBUG" ]]; then
        get_docker_debug_client "$ver"
    fi
done
