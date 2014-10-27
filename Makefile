#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

NAME:=docker
JS_FILES	:= $(shell find lib -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/docker.xml.in
CLEAN_FILES += ./node_modules

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

RELEASE_TARBALL:=$(NAME)-pkg-$(STAMP).tar.bz2
RELSTAGEDIR:=/tmp/$(STAMP)


#
# Targets
#
.PHONY: all
all: $(SMF_MANIFESTS) build/build.json | $(NPM_EXEC) sdc-scripts
	$(NPM) install

build/build.json:
	mkdir -p build
	echo "{\"version\": \"$(VERSION)\", \"commit\": \"$(COMMIT)\", \"stamp\": \"$(STAMP)\"}" | json >$@

sdc-scripts: deps/sdc-scripts/.git

#XXX sapi_manifests
#XXX etc/defaults.json ?

.PHONY: release
release: all
	@echo "Building $(RELEASE_TARBALL)"
	# boot
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(TOP)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(TOP)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	# docker
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/{etc,build}
	cp -r \
		$(TOP)/package.json \
		$(TOP)/lib \
		$(TOP)/node_modules \
		$(TOP)/smf \
		$(TOP)/test \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	cp build/build.json $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/etc/
	cp -r \
		$(TOP)/build/node \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	# Trim node
	rm -rf \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node/bin/npm \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node/lib/node_modules \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node/include \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node/share
	# Trim node_modules (this is death of a 1000 cuts, try for some
	# easy wins).
	# XXX these inherited from imgapi, review them
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name test | xargs -n1 rm -rf
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name tests | xargs -n1 rm -rf
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name examples | xargs -n1 rm -rf
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name "draft-*" | xargs -n1 rm -rf  # draft xml stuff in json-schema
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name libusdt | xargs -n1 rm -rf  # dtrace-provider
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name obj.target | xargs -n1 rm -rf  # dtrace-provider
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name deps | grep 'extsprintf/deps$$' | xargs -n1 rm -rf  # old extsprintf shipped dev bits
	# Tar
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) root)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)


include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
