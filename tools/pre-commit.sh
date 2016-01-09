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
# A suggested git pre-commit hook for developers. Install it via:
#
#   make git-hooks
#

set -o errexit
set -o pipefail

make check
make test
