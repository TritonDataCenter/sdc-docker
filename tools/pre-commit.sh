#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2017 Joyent, Inc.
#

#
# A suggested git pre-commit hook for developers. Install it via:
#
#   make git-hooks
#

set -o errexit
set -o pipefail

function ensure_copyright_year() {
    currYear=$(date -u "+%Y")
    filesToBeCommited=$(git diff --staged --name-only HEAD)
    nErrs=0
    for f in $filesToBeCommited; do
        year=$((grep Copyright $f || true) \
             | (grep Joyent || true) \
             | sed -E 's/^(.*)([0-9]{4})(.*)$/\2/')
        if [[ -n "$year" && "$year" != "$currYear" ]]; then
            echo "$f: error: Copyright year is $year instead of $currYear"
            nErrs=$(( $nErrs + 1 ))
        fi
    done
    if [[ $nErrs -gt 0 ]]; then
        exit 1
    fi
}


#---- mainline

# Redirect output to stderr.
exec 1>&2

ensure_copyright_year
make check
make test
