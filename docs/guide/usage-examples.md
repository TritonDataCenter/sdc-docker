# Docker usage examples

## Delete *all* your docker VMs (helpful when testing)

```
docker rm -f `docker ps -aq`
```

## Create a busybox container and play around in it (deleted on exit)

```
docker run --rm -it busybox
```

## Create an ubuntu container and play around in it (deleted on exit)

```
docker run --rm -it ubuntu
```

## Create an nginx container get the IP make a request then get the logs

```
docker run -d nginx
docker inspect --format '{{ .NetworkSettings.IPAddress }}' <containerId>
curl http://<IP>
docker logs <containerId>
```

## Run a shell in a container (use 'sh' instead of bash if the image doesn't have bash)

```
docker exec -it <containerId> bash
```

## Run a shell in a SmartOS container (non-LX):

 * on headnode:
     * ```sdc-imgadm import 00aec452-6e81-11e4-8474-ebfec9a1a911 -S https://images.joyent.com```
 * on client:
     * ```docker run -it 00aec452-6e81-11e4-8474-ebfec9a1a911 /usr/bin/bash```

## Run a shell in a container (destroying when done) with a /data volume

```
docker run -it --rm -v /data ubuntu bash
```
