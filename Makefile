#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Vars, Tools, Files, Flags
#
JS_FILES	:= $(shell find lib -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/docker.xml.in
CLEAN_FILES += ./node_modules build/docker.js-*.sh

NODE_PREBUILT_VERSION=v0.10.32
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=zone
	NODE_PREBUILT_IMAGE=de411e86-548d-11e4-a4b7-3bb60478632a
endif


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	NPM := $(shell which npm)
	NPM_EXEC=$(NPM)
endif
include ./tools/mk/Makefile.smf.defs

VERSION=$(shell json -f $(TOP)/package.json version)
COMMIT=$(shell git describe --all --long  | awk -F'-g' '{print $$NF}')
RELEASE_NAME=docker.js-$(VERSION)-$(STAMP).sh

MANTA_URL=https://us-east.manta.joyent.com
MLN=MANTA_URL=$(MANTA_URL) ./build/node/bin/node ./node_modules/.bin/mln
MPUT=MANTA_URL=$(MANTA_URL) ./build/node/bin/node ./node_modules/.bin/mput

#
# Targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC)
	$(NPM) install

.PHONY: release
release: build/$(RELEASE_NAME)

build/$(RELEASE_NAME):
	./tools/mk-shar -o build/$(RELEASE_NAME) -s $(STAMP) -v $(VERSION) -c $(COMMIT)

.PHONY: publish
publish: build/$(RELEASE_NAME)
	$(MPUT) -f build/$(RELEASE_NAME) /Joyent_Dev/stor/tmp/$(RELEASE_NAME)
	$(MLN) /Joyent_Dev/stor/tmp/$(RELEASE_NAME) /Joyent_Dev/stor/tmp/docker.js.sh

include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
