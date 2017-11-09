/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Test docker images that use v1, v2 or both v1/v2 docker image buckets.
 */

var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var drc = require('docker-registry-client');
var imgmanifest = require('imgmanifest');
var libuuid = require('libuuid');
var test = require('tape');
var vasync = require('vasync');

var createTarStream = require('../lib/common').createTarStream;
var h = require('./helpers');
var imageV1Model = require('../../lib/models/image');
var imageV2Model = require('../../lib/models/image-v2');
var imageTagV1Model = require('../../lib/models/image-tag');
var log = require('../lib/log');


// --- Globals

var ALICE;
var DOCKER_ALICE;
var DOCKER_ALICE_HTTP;
var gInitSuccessful = false;
var gV1Image;
var gV1ImageName = 'joyentunsupported/busybox_with_label_test_v1';
var gV2Image;
var gV2ImageName = 'joyentunsupported/busybox_with_label_test';
var imgapiClient;
var morayClient;
var STATE = {
    log: log
};


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);
            ALICE = accounts.alice;
            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient({user: ALICE}, function (err, client) {
            t.ifErr(err, 'docker client init');
            DOCKER_ALICE = client;
            t.end();
        });
    });

    tt.test('docker client http init', function (t) {
        h.createDockerRemoteClient({user: ALICE, clientType: 'http'},
            function (err, client) {
                t.ifErr(err, 'docker client init for alice/http');
                DOCKER_ALICE_HTTP = client;
                t.end();
            }
        );
    });

    tt.test('imgapi client init', function (t) {
        h.createImgapiClient(function (err, client) {
            t.ifErr(err, 'imgapi client init');
            imgapiClient = client;
            t.end();
        });
    });

    tt.test('moray client init', function (t) {
        h.createMorayClient(function (err, client) {
            t.ifErr(err, 'moray client init');
            morayClient = client;
            t.end();
        });
    });
});


/**
 * Create v1 and v2 docker images.
 *
 * To test a v2 image, we simply docker pull it.
 * To test a v1 image, we need to jump through some hoops:
 *  - manually create the IMGAPI image/file
 *  - manually create the v1 image model (docker_images bucket)
 */
test('init docker images', function (tt) {
    var app = {
        moray: morayClient
    };

    tt.test('pull v2 busybox_with_label_test image', function (t) {
        h.ensureImage({
            name: gV2ImageName,
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling image');
            t.end();
        });
    });

    tt.test('inspect v2 image', function (t) {
        var url = '/images/' + encodeURIComponent(gV2ImageName) + '/json';
        DOCKER_ALICE.get(url, function (err, req, res, img) {
            t.error(err, 'get v2 image');
            gV2Image = img;
            t.end();
        });
    });

    tt.test('create v1 test image', function (t) {
        var imageUuid = libuuid.create();
        var dockerId = (imageUuid + imageUuid).replace(/-/g, '');

        // This is actual busybox config pulled from a working v1 manatee.
        var v1ModelParams = {
            author: '',
            architecture: '',
            comment: '',
            created: 1497559350659,
            config: {
                Hostname: 'c673fc810c50',
                Domainname: '',
                User: '',
                AttachStdin: false,
                AttachStdout: false,
                AttachStderr: false,
                Tty: false,
                OpenStdin: false,
                StdinOnce: false,
                Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:'
                    + '/usr/bin:/sbin:/bin'],
                Cmd: ['sh'],
                ArgsEscaped: true,
                Image: '',
                Volumes: null,
                WorkingDir: '',
                Entrypoint: null,
                OnBuild: null,
                Labels: {}
            },
            container_config: {
                Hostname: 'c673fc810c50',
                Domainname: '',
                User: '',
                AttachStdin: false,
                AttachStdout: false,
                AttachStderr: false,
                Tty: false,
                OpenStdin: false,
                StdinOnce: false,
                Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:'
                    + '/usr/bin:/sbin:/bin'],
                Cmd: ['/bin/sh', '-c', '#(nop) ', 'CMD [\'sh\']'],
                ArgsEscaped: true,
                Image: '',
                Volumes: null,
                WorkingDir: '',
                Entrypoint: null,
                OnBuild: null,
                Labels: {}
            },
            docker_id: dockerId,
            head: true,
            image_uuid: imageUuid,
            index_name: 'docker.io',
            os: 'linux',
            owner_uuid: ALICE.account.uuid,
            private: false,
            heads: [dockerId],
            size: 0,
            virtual_size: 0
        };

        vasync.pipeline({arg: {}, funcs: [
            sdcDockerGetV2ImageModel,
            determineLayerImageUuid,
            imgapiGetExistingImage,
            imgapiGetExistingImageFileStream,
            imgapiCreateImage,
            imgapiImportImageFile,
            imgapiActivateImage,
            sdcDockerCreateV1Model,
            sdcDockerCreateV1ModelTag
        ]}, function (err) {
            t.error(err, 'should be no error creating v1 IMGAPI image');
            if (!err) {
                gInitSuccessful = true;
            }
            t.end();
        });

        function sdcDockerGetV2ImageModel(ctx, next) {
            var params = {
                config_digest: gV2Image.Id,
                owner_uuid: ALICE.account.uuid
            };
            imageV2Model.get(app, log, params, function (err, img) {
                ctx.v2ModelInst = img;
                next(err);
            });
        }

        function determineLayerImageUuid(ctx, next) {
            // Work out which layer of the v2 image has the file content. We
            // look for the layer which has a size greater than 32, as 32 size
            // means an empty layer.
            assert.object(ctx.v2ModelInst);
            assert.string(ctx.v2ModelInst.manifest_str);

            var manifest = JSON.parse(ctx.v2ModelInst.manifest_str);
            var layerIdx;
            var contentLayers = manifest.layers.filter(function (layer, idx) {
                if (layer.size > 32) {
                    layerIdx = idx;
                    return true;
                }
                return false;
            });
            if (contentLayers.length !== 1) {
                next(new Error('Expected 1 layer with size > 32, got '
                    + contentLayers.length));
                return;
            }
            var digestChain = manifest.layers.slice(0, layerIdx+1).map(
                function (layer) {
                    return layer.digest;
                }
            );
            ctx.layerImageUuid = imgmanifest.imgUuidFromDockerDigests(
                digestChain);

            next();
        }

        function imgapiGetExistingImage(ctx, next) {
            log.debug('getting image from IMGAPI');
            imgapiClient.getImage(ctx.layerImageUuid, function (err, img) {
                ctx.imgapiImage = img;
                next(err);
            });
        }

        function imgapiGetExistingImageFileStream(ctx, next) {
            log.debug('getting image file stream from IMGAPI');
            imgapiClient.getImageFileStream(ctx.layerImageUuid,
                function (err, stream) {
                    // Stream has to be paused, for addImageFile call.
                    if (stream) {
                        stream.pause();
                        ctx.layerStream = stream;
                    }
                    next(err);
                }
            );
        }

        function imgapiCreateImage(ctx, next) {
            var rat = drc.parseRepoAndTag(gV1ImageName);
            log.debug('creating image in IMGAPI');

            var imgapiManifest = imgmanifest.imgManifestFromDockerInfo({
                imgJson: v1ModelParams,
                layerDigests: ['sha256:' + dockerId], // Just a placeholder.
                owner: ALICE.account.uuid,
                public: false,
                repo: rat
            });
            imgapiManifest.uuid = imageUuid; // Keep image_uuid the same.
            log.debug({imgapiManifest: imgapiManifest}, 'createImage manifest');
            imgapiClient.adminImportImage(imgapiManifest, next);
        }

        function imgapiImportImageFile(ctx, next) {
            assert.object(ctx.imgapiImage);
            assert.arrayOfObject(ctx.imgapiImage.files);
            assert.object(ctx.layerStream);

            var file = ctx.imgapiImage.files[0];
            var opts = {
                compression: file.compression,
                file: ctx.layerStream,
                sha1: file.sha1,
                size: file.size,
                storage: 'local',
                uuid: imageUuid
            };
            log.debug('importing image file into IMGAPI');
            imgapiClient.addImageFile(opts, next);
        }

        function imgapiActivateImage(ctx, next) {
            log.debug('imgapi.activateImage');
            imgapiClient.activateImage(imageUuid, next);
        }

        function sdcDockerCreateV1Model(ctx, next) {
            log.debug('sdcdocker.createV1Model');
            v1ModelParams.image_uuid = imageUuid;
            imageV1Model.create(app, log, v1ModelParams, function (err, img) {
                gV1Image = img;
                next(err);
            });
        }

        function sdcDockerCreateV1ModelTag(ctx, next) {
            log.debug('sdcdocker.createV1ModelTag');
            var params = {
                docker_id: gV1Image.docker_id,
                index_name: 'docker.io',
                owner_uuid: ALICE.account.uuid,
                repo: gV1ImageName,
                tag: 'latest'
            };
            imageTagV1Model.create(app, log, params, function (err) {
                next(err);
            });
        }
    });
});


// Ensure no use of v1 images for docker tag.
test('test for error on docker v1 image tag', function (tt) {
    if (gInitSuccessful === false) {
        tt.skip('image init failed');
        tt.end();
        return;
    }

    tt.test('tag v1 image', function (t) {
        var url = util.format('/images/%s/tag?repo=tagfail&tag=latest',
            gV1ImageName);

        DOCKER_ALICE.post(url, function onpost(err) {
            t.ok(err, 'should get an error when tagging a v1 image');
            if (err) {
                t.ok(String(err).indexOf('image which cannot be tagged') >= 0,
                    'check error has correct message');
            }
            t.end();
        });
    });
});

// Ensure no use of v1 images for docker build.
test('test for error on docker v1 image build', function (tt) {
    if (gInitSuccessful === false) {
        tt.skip('image init failed');
        tt.end();
        return;
    }

    tt.test('build from v1 image', function (t) {
        vasync.pipeline({arg: {}, funcs: [

            function createTar(ctx, next) {
                var fileAndContents = {
                    Dockerfile: util.format('FROM %s\n'
                                    + 'LABEL sdcdockertest=true\n',
                                    gV1ImageName)
                };
                ctx.tarStream = createTarStream(fileAndContents);
                next();
            },

            function buildContainer(ctx, next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    params: {
                        'forcerm': 'true'  // Remove container after it's built.
                    },
                    test: t,
                    tarball: ctx.tarStream
                }, onbuild);

                function onbuild(err, result) {
                    t.ifErr(err, 'ensure build request worked');
                    ctx.buildResult = result;
                    next(err);
                }
            },

            function checkResults(ctx, next) {
                var result = ctx.buildResult;
                if (!result || !result.body) {
                    next(new Error('build generated no output!?'));
                    return;
                }

                var output = result.body;
                var wantedErrorMsg = 'deprecated image which cannot be used '
                    + 'by docker build - please repull or rebuild the image';
                var hasV1ImageError = output.indexOf(wantedErrorMsg) >= 0;
                t.ok(hasV1ImageError, 'build has v1 image error message');
                if (!hasV1ImageError) {
                    t.ok(hasV1ImageError, util.format(
                        'build received v1 image error: output=%j', output));
                }

                next();
            }

        ]}, function allDone(err) {
            t.ifErr(err);
            t.end();
        });
    });
});


// Ensure we can successful create and run a container that uses a v1 image.
test('test docker v1/v2 images', function (tt) {
    if (gInitSuccessful === false) {
        tt.skip('image init failed');
        tt.end();
        return;
    }

    var containerId;

    tt.test('create and run v1 image', function (t) {
        assert.object(STATE.vmapi, 'STATE.vmapi');
        log.debug('runV1Image');
        h.createDockerContainer({
            dockerClient: DOCKER_ALICE,
            extra: {
                Cmd: [ 'sh', '-c', 'sleep 86400' ]
            },
            imageName: gV1ImageName,
            start: true,
            test: t,
            vmapiClient: STATE.vmapi
        }, oncreate);

        function oncreate(err, result) {
            t.ifErr(err, 'Check for create/run container error');
            t.ok(result.id, 'container should have an id');
            t.equal(result.vm.state, 'running', 'Check container running');

            if (!result.id) {
                t.end();
                return;
            }

            containerId = result.id;
            // Try and commit the container with the v1 image - it should fail.
            var commitUrl = util.format(
                '/commit?container=%s&repo=myv1image&tag=latest',
                containerId);

            DOCKER_ALICE.post(commitUrl, oncommit);
        }

        function oncommit(err) {
            t.ok(err, 'Got a docker commit error for v1 image');
            if (err) {
                var wantedErrorMsg = 'This container uses a deprecated '
                    + 'image which cannot be committed - please repull '
                    + 'or rebuild the image';
                var hasError = String(err).indexOf(wantedErrorMsg) >= 0;
                t.ok(hasError, 'commit has v1 image error message');
                if (!hasError) {
                    t.ok(hasError, util.format(
                        'commit error: %s', err));
                }
            }

            DOCKER_ALICE.del('/containers/' + containerId + '?force=1',
                ondelete);
        }

        function ondelete(err) {
            t.ifErr(err, 'delete v1 based container');
            t.end();
        }
    });
});


// Ensure v1 and v2 images play nicely together.
test('test docker v1/v2 images', function (tt) {
    if (gInitSuccessful === false) {
        tt.skip('image init failed');
        tt.end();
        return;
    }

    tt.test('list v1/v2 images', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            t.ok(images, 'images array');
            t.ok(images.length >= 2, 'images length >= 2');

            // Check that both the v1 and v2 images are listed.
            var v1ImageExists = images.filter(function (img) {
                return img.Id === gV1Image.docker_id;
            }).length > 0;
            t.ok(v1ImageExists, 'Expect list images to include v1 image');

            var v2ImageExists = images.filter(function (img) {
                return img.Id === gV2Image.Id;
            }).length > 0;
            t.ok(v2ImageExists, 'Expect list images to include v2 image');

            t.end();
        });
    });

    // Test when the v1 and v2 image have the same name.
    tt.test('tag v2 image with v1 name', function (t) {
        var url = util.format('/images/%s/tag?repo=%s&tag=latest',
            gV2ImageName, gV1ImageName);
        DOCKER_ALICE.post(url, onpost);
        function onpost(err) {
            t.error(err, 'should be no error tagging v2 image');
            t.end();
        }
    });

    tt.test('delete v2 image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(gV2ImageName), ondel);
        function ondel(err) {
            t.error(err, 'should be no error deleting v2 image');
            t.end();
        }
    });

    // Inspect the v1 image name (should give us the newly tagged v2 image).
    tt.test('inspect v2 tagged image', function (t) {
        var url = '/images/' + encodeURIComponent(gV1ImageName) + '/json';
        DOCKER_ALICE.get(url, function (err, req, res, img) {
            t.error(err, 'get v2 tagged image');
            t.equal(img.Id, gV2Image.Id, 'inspect should give the v2 id');
            t.end();
        });
    });

    // Delete the v2 tagged image.
    tt.test('delete v2 tagged image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(gV1ImageName), ondel);
        function ondel(err) {
            t.error(err, 'should be no error deleting v2 tagged image');
            t.end();
        }
    });

    tt.test('ensure v2 image is gone', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            t.ok(images, 'images array');
            t.ok(images.length >= 1, 'images length >= 1');

            // Check that both the v1 image exists and v2 image is gone.
            var v1ImageExists = images.filter(function (img) {
                return img.Id === gV1Image.docker_id;
            }).length > 0;
            t.ok(v1ImageExists, 'Expect list images to include v1 image');

            var v2ImageExists = images.filter(function (img) {
                return img.Id === gV2Image.Id;
            }).length > 0;
            t.notOk(v2ImageExists, 'Expect list images to exclude v2 image');

            t.end();
        });
    });

    tt.test('delete v1 image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(gV1ImageName), ondel);
        function ondel(err) {
            t.error(err, 'should be no error deleting v1 image');
            t.end();
        }
    });

    tt.test('ensure v1 and v2 images are gone', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            t.ok(images, 'images array');

            // Check that both the v1 and v2 images are gone.
            var v1ImageExists = images.filter(function (img) {
                return img.Id === gV1Image.docker_id;
            }).length > 0;
            t.notOk(v1ImageExists, 'Expect list images to exclude v1 image');

            var v2ImageExists = images.filter(function (img) {
                return img.Id === gV2Image.Id;
            }).length > 0;
            t.notOk(v2ImageExists, 'Expect list images to exclude v2 image');

            t.end();
        });
    });
});


test('teardown', function (tt) {
    imgapiClient.close();
    morayClient.close();
    tt.end();
});
