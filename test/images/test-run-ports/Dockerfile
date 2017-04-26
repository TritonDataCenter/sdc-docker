#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2017 Joyent, Inc.
#

# We use "nginx" so we can ports actually in use. We use the "-alpine" version
# because it is much smaller.
FROM nginx:1.13.0-alpine
LABEL description="a test image for https://github.com/joyent/sdc-docker/blob/master/test/integration/cli-run-ports.test.js"
EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
