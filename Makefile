#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
#

NAME:=docker

DOC_FILES	 = index.md images.md
EXTRA_DOC_DEPS += deps/restdown-brand-remora/.git
RESTDOWN_FLAGS   = --brand-dir=deps/restdown-brand-remora

TAPE	:= ./node_modules/.bin/tape

JS_FILES	:= $(shell find lib plugins test -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/docker.xml.in
CLEAN_FILES += ./node_modules

NODE_PREBUILT_VERSION=v4.9.0
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=zone
	# Allow building on other than image sdc-minimal-multiarch-lts@15.4.1.
	NODE_PREBUILT_IMAGE=18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
else
	NPM := $(shell which npm)
	NPM_EXEC=$(NPM)
endif
include ./deps/eng/tools/mk/Makefile.smf.defs


VERSION=$(shell json -f $(TOP)/package.json version)
COMMIT=$(shell git describe --all --long  | awk -F'-g' '{print $$NF}')
BUILD_TIMESTAMP=$(shell date -u +'%Y-%m-%dT%H:%M:%SZ')

RELEASE_TARBALL:=$(NAME)-pkg-$(STAMP).tar.gz
RELSTAGEDIR:=/tmp/$(NAME)-$(STAMP)

COAL ?= 10.99.99.7

BASE_IMAGE_UUID = 04a48d7d-6bb5-4e83-8c3b-e60a99e0f48f
BUILDIMAGE_NAME = $(NAME)
BUILDIMAGE_DESC	= SDC Docker Engine
AGENTS		= amon config registrar

#
# Targets
#
.PHONY: all
all: $(SMF_MANIFESTS) build/build.json | $(TAPE) $(NPM_EXEC) sdc-scripts
	$(NPM) install

build/build.json:
	mkdir -p build
	echo "{\"version\": \"$(VERSION)\", \"commit\": \"$(COMMIT)\", \"date\": \"$(BUILD_TIMESTAMP)\", \"stamp\": \"$(STAMP)\"}" | json >$@

sdc-scripts: deps/sdc-scripts/.git

$(TAPE): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(TAPE) ./node_modules/tape

# Run *unit* tests.
.PHONY: test
test: $(TAPE)
	@(for F in test/unit/*.test.js; do \
		echo "# $$F" ;\
		$(NODE) $(TAPE) $$F ;\
		[[ $$? == "0" ]] || exit 1; \
	done)

# Integration tests:
#
# - Typically the full suite of integration tests is run from the headnode GZ:
#       /zones/$(vmadm lookup -1 alias=docker0)/root/opt/smartdc/docker/test/runtests
#
# - Integration tests that just call the docker client (i.e. that don't assume
#   running in the GZ) can be run from your Mac's dev build, e.g.:
# 	./test/runtest ./test/integration/info.test.js
#
.PHONY: test-integration-in-coal
test-integration-in-coal:
	@ssh root@$(COAL) 'DOCKER_CLI_VERSIONS="$(DOCKER_CLI_VERSIONS)" \
		COMPOSE_CLI_VERSIONS="$(COMPOSE_CLI_VERSIONS)" \
		LOG_LEVEL=$(LOG_LEVEL) \
		/zones/$$(vmadm lookup -1 alias=docker0)/root/opt/smartdc/docker/test/runtests $(TEST_ARGS)'


.PHONY: git-hooks
git-hooks:
	[[ -e .git/hooks/pre-commit ]] || ln -sf ../../tools/pre-commit.sh .git/hooks/pre-commit


.PHONY: check-docs
check-docs:
	@./tools/check-docs.sh

check:: check-docs


#
# Packaging targets
#

.PHONY: release
release: all
	@echo "Building $(RELEASE_TARBALL)"
	# boot
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(TOP)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(TOP)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	# docker
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	cp -r \
		$(TOP)/package.json \
		$(TOP)/bin \
		$(TOP)/etc \
		$(TOP)/lib \
		$(TOP)/plugins \
		$(TOP)/node_modules \
		$(TOP)/smf \
		$(TOP)/tls \
		$(TOP)/test \
		$(TOP)/sapi_manifests \
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
	find $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/node_modules -name deps | grep 'extsprintf/deps$$' | xargs -n1 rm -rf  # old extsprintf shipped dev bits
	# Tar
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(TOP)/$(RELEASE_TARBALL) root)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)


include ./deps/eng/tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
endif
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ
