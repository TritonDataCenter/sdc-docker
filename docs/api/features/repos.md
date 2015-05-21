Private repositories

Docker images may be maintained in Docker Hub's public or private repos, or in private Docker repos hosted in your own application environment. Private repos are accessible from sdc-docker once you have authenticated to them. Images are uniquely identified by the repo and user namespace - [REPO_HOST/]IMAGE_NAME[:TAG]. You may connect to multiple repos at the same time and pull images from them without having to switch from one to another.

## Using images with private repo hosted on Docker Hub

The repo is implicity referenced when no repo end-point is specified. For example:

$ docker login
Username: jill_user
Password: 
Email: jill_user@example.com
WARNING: login credentials saved in /Users/jill_user/.dockercfg.
Login Succeeded

$ docker pull jill_user/busybox
Pulling repository docker.io/jill_user/busybox
:

$ docker run -it jill_user/busybox bash

$ docker logout
Remove login credentials for https://index.docker.io/v1/

The lookup of the image specified goes across Docker Hub's public repo and the private repo you are currently logged in to.


## Using images with private repo hosted outside of Docker Hub

All private repos should have a fully qualified domain name and an authority-signed certificate. The end-point should be referenced in the image name when using docker pull/run/create operations.

$ docker login myrepo.example.com
Username: jill_user
Password: 
Email: jill_user@example.com

$ docker pull jill-repo.example.com/busybox

$ docker run -it jill-repo.example.com/busybox bash

$ docker logout jill-repo.example.com
 

