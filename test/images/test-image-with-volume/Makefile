#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2017 Joyent, Inc.
#

NAME=joyentunsupported/test-image-with-volume
VERSION=1.0.1

all:
	docker build -t $(NAME):$(VERSION) .
	docker build -t $(NAME):latest .

publish: all
	docker push $(NAME):$(VERSION)
	docker push $(NAME):latest
