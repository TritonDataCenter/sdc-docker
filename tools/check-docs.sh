#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2017, Joyent, Inc.
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

TOP=$(cd "$(dirname "$0")/../"; pwd)


#---- mainline

hits=0

# Check each of the files in docs/. (We use -print0 in case files
# have spaces in their name.)
while read -d $'\0' -r file; do
    # Map the newline character into a space, and spaces into
    # an underscore, since bash likes to trim trailing newlines
    # from command outputs.
    if [[ `tail -1c "$file" | tr ' \n' '_ '` != ' ' ]]; then
        echo "$file: does not end with a newline" >&2
        hits=1
    fi
done < <(find "$TOP/docs" -name "*.md" -print0)

exit $hits
