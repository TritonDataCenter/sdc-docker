#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2017 Joyent, Inc.
#

NAME=joyentunsupported/test-nginx
VERSION=1.0.0

all:
	docker build -t $(NAME):$(VERSION) -t $(NAME):latest .

publish: all
	docker push $(NAME):$(VERSION)
	docker push $(NAME):latest
