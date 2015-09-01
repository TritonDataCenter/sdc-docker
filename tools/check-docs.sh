#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2015, Joyent, Inc.
#

#
# Some sanity style checks of docs/...
#
# Usage:
#   make check
#
# Checks:
#
# 1. Ensure files end with a newline, else the import into
#    apidocs.joyent.com.git gets grumpy.
#
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail

TOP=$(cd $(dirname $0)/../; pwd)


#---- mainline

hits=0
for file in $(find $TOP/docs -name "*.md"); do
    lastchar=$(tail -c1 $file | od -a | head -1 | awk '{print $2}')
    if [[ $lastchar != 'nl' ]]; then
        echo "$file: does not end with a newline" >&2
        hits=$(( $hits + 1 ))
    fi
done

exit $hits
