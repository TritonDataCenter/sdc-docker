#Demoing an new application and setting up a node.js development container 
##Docker Use case Dev2 
###Persona : Donna (Senior Developer/Application architect)

Day #1

##General scenario 
Donna has a new idea for an application that she wants to share with a remote co-worker so that they can collaborate on the project. She needs a small environment where they can do rapid prototyping and make sure everything works in an standalone environment. 

The project is going to be done in Node.js and they are using github as their source repository. 

She builds a Docker container with node.js and git that pulls the latest code out of the github repository, runs npm install and starts the node.js application. She builds it in a way where that process is invoked every time the container is restarted. That way she doesn’t have to wait for a container to be rebuilt every time there is a new commit. This is a handy trick when doing early prototyping and just wanted to be able to iterate really fast without having to wait for Docker images to be built and moved around.  

The code for the container can be found https://github.com/eviking/mydockerapp and the container itself can be found https://registry.hub.docker.com/u/eviking/mydockerapp/

##Steps
###S1 pulling down the image
Donna goes to hub.docker and locates the following official images for the components in the stack. She is going to use all the latest images.

```
$ docker pull eviking/mydockerapp
```


###S2 Starting the application
Starting the application container
```
$ docker run --name myApp -d eviking/mydockerapp
```
A quick test to ensure the container is up and running correctly 
```
$ docker logs  myApp
```
The result she expected looks like this. 
```
Cloning into 'mydockerapp'...
npm WARN package.json my-litle-webserver@0.0.1 No repository field.
npm http GET https://registry.npmjs.org/express
npm http 200 https://registry.npmjs.org/finalhandler/-/finalhandler-0.3.3.tgz
<!-- No errors in the npm install >
npm http GET https://registry.npmjs.org/mime-db/-/mime-db-1.7.0.tgz
npm http 200 https://registry.npmjs.org/mime-db/-/mime-db-1.7.0.tgz
express@4.11.2 node_modules/express
├── merge-descriptors@0.0.2
├── utils-merge@1.0.0
├── methods@1.1.1
├── fresh@0.2.4
├── cookie@0.1.2
├── escape-html@1.0.1
├── range-parser@1.0.2
├── cookie-signature@1.0.5
├── finalhandler@0.3.3
├── vary@1.0.0
├── media-typer@0.3.0
├── parseurl@1.3.0
├── serve-static@1.8.1
├── content-disposition@0.5.0
├── path-to-regexp@0.1.3
├── depd@1.0.0
├── qs@2.3.3
├── on-finished@2.2.0 (ee-first@1.1.0)
├── debug@2.1.1 (ms@0.6.2)
├── etag@1.5.1 (crc@3.2.1)
├── proxy-addr@1.0.6 (forwarded@0.1.0, ipaddr.js@0.1.8)
├── send@0.11.1 (ms@0.7.0, destroy@1.0.3, mime@1.2.11)
├── type-is@1.5.7 (mime-types@2.0.9)
└── accepts@1.2.4 (negotiator@0.5.1, mime-types@2.0.9)
```
```
$ curl `docker inspect  --format '{{ .NetworkSettings.IPAddress }}' myApp`:8089
```
The result she expected looks like this where 32da762ec20d is the docker container ID and hostname
```
{ "requestCounter":1, "hostname":32da762ec20d ,"dockerContainerName":32da762ec20d}
```
As an extra validation Donna runs the following command to see what environment variable has been set inside the container
```
$ docker exec myApp env
```
The result she expected looks like this:
```
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOSTNAME=<Docker container ID>
HOME=/root
```
