#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# This is the script included in docker.js shars to handle
# the docker.js install/upgrade on a headnode GZ.
#
# Usage:
#   install-docker.js.sh    # in the extracted shar dir
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


DESTDIR=/opt/smartdc/docker.js
NEWDIR=$DESTDIR.new
OLDDIR=$DESTDIR.old


#---- support stuff

function fatal
{
    echo "$0: fatal error: $*" >&2
    exit 1
}

function restore_old_on_error
{
    [[ $1 -ne 0 ]] || exit 0

    if [[ -d $OLDDIR ]]; then
        echo "$0: restoring $DESTDIR from $OLDDIR"
        rm -rf $DESTDIR
        mv $OLDDIR $DESTDIR
    fi

    fatal "$0: error exit status $1" >&2
}


#---- mainline

# Sanity checks.
[[ "$(zonename)" == "global" ]] || fatal "not running in global zone"
[[ "$(sysinfo | json "Boot Parameters.headnode")" == "true" ]] \
    || fatal "not running on the headnode"
[[ -f "./etc/build.json" ]] || fatal "missing './etc/build.json'"

[[ -d $OLDDIR ]] && rm -rf $OLDDIR
[[ -d $NEWDIR ]] && rm -rf $NEWDIR

trap 'restore_old_on_error $?' EXIT

cp -PR ./ $NEWDIR
rm $NEWDIR/install-docker.js.sh
rm -rf $NEWDIR/.temp_bin

# Move the old out of the way, swap in the new.
if [[ -d $DESTDIR ]]; then
    mv $DESTDIR $OLDDIR
fi
mv $NEWDIR $DESTDIR

# Import the docker engine service and gracefully start it.
echo "Importing and starting docker service"
cp $DESTDIR/smf/manifests/docker.xml /var/svc/manifest/site/docker.xml
svccfg import /var/svc/manifest/site/docker.xml
if [[ "$(svcs -Ho state docker)" == "maintenance" ]]; then
    svcadm clear docker
fi

[[ -d $OLDDIR ]] && rm -rf $OLDDIR

echo "Successfully upgraded to docker.js $(cat $DESTDIR/etc/build.json)"
exit 0
