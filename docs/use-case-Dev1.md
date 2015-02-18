Setting up new application environments

## Docker Use case Dev1 

Persona : **Donna (Senior Developer/Application architect)**

Day #1

## General scenario 

Donna has made the first pass at an application architecture for the company’s new green fields application. It will be a node.js application using mongoDB for it’s database and redis for caching. The application will be fronted by NginX. To be able to scale the application she is planning on putting HAproxy in front of both NginX and node.js. 

She has the desired configuration working without the HAproxy layers on her laptop, but starting tomorrow she needs to have a couple of centralized environments available.

 1 QA environment for integration testing.

* At a later phase the QA team is also going to use the environment for stress testing so it will need to include the HAproxy layers.
* When new code is committed to Github it will be deployed to the QA environment. 


 3 Environments for Product Management to provide internal demos. 

* The 3 environments need different seed data and application configuration depending on who the audience is for the demo.
* The environments do not have to scale, but for consistency the HAproxy layers are implemented, but only with a single node under each.
* Ideally PM will be able to maintain the environments without relying on engineering support. 

General goals for her QA and Demo environments:

1. Quick to setup.
2. Easy to deploy new code.
3. Easy to seed and reseed the database.
4. Easy to troubleshoot (The engineering team will have full access to the all environments).

## Steps

### S1 pulling down all the images

Donna goes to hub.docker and locates the following official images for the components in the stack. She is going to use all the latest images.

<table border bgcolor=eeeeee>
  <tr>
    <td>**Component**</td>
    <td>**image (pull command)**</td>
  </tr>
  <tr>
    <td>MongoDB</td>
    <td>
$ docker pull mongo
</td>
  </tr>
  <tr>
    <td>Redis</td>
    <td>
$ docker pull redis
</td>
  </tr>
</table>


### S2 Starting MongoDB

#### Starting the mongo container
<BR>
<table bgcolor=eeeeee>
  <tr>
    <td>$ docker run --name qa-db-1 -d -p 27017:27017 mongo</td>
  </tr>
</table>


##### A quick test to ensure the database is up and running correctly 
<BR>
<table  bgcolor=eeeeee>
  <tr>
    <td>$ docker exec qa-db-1 mongo  test --eval "printjson(db.serverStatus())"</td>
  </tr>
</table>

##### To ensure mongo can be accessed outside of the mongo container Donna "curls" to the port she expects mongo is listening to
<BR>
<table  bgcolor=eeeeee>
  <tr>
    <td>$ curl \`docker inspect  --format '{{ .NetworkSettings.IPAddress }}' qa-db-1\`:27017</td>
  </tr>
</table>

######The result she expected looks like this. 
<BR>
<table  bgcolor=ffffee>
  <tr>
    <td>It looks like you are trying to access MongoDB over HTTP on the native driver port.</td>
  </tr>
</table>


### S3 Starting Redis

####Starting the Redis container
<BR>
<table  bgcolor=eeeeee>
  <tr>
    <td>$ docker run --name qa-redis-1 -d redis</td>
  </tr>
</table>

######A quick test to ensure redis is up and running correctly 
<BR>
<table bgcolor=eeeeee>
  <tr>
    <td>$ docker exec qa-redis-1  /usr/local/bin/redis-cli info</td>
  </tr>
</table>

#####To ensure Redis can be accessed outside of the Redis container Donna "curls" to the port she expects Redis is listening to
<BR>
<table  bgcolor=eeeeee>
  <tr>
    <td>$ curl \`docker inspect  --format '{{ .NetworkSettings.IPAddress }}' 
 qa-redis-1\`:6379`</td>
  </tr>
</table>

######The expected result is not formatted well, but it is clear that the port is responding 
<BR>
<table bgcolor=ffffee>
  <tr>
    <td>-ERR wrong number of arguments for 'get' command<BR>
-ERR unknown command 'User-Agent:'<BR>
-ERR unknown command 'Host:'<BR>
-ERR unknown command 'Accept:'<BR>
^C</td>
  </tr>
</table>

##### Donna wants to use Redis as a caching services so she needs to make configuration changes 
<BR>
<table bgcolor=eeeeee border>
  <tr>
    <td>$ echo "maxmemory 2mb" > /home/donna/app/redis/redis.cfg<BR>
$ echo "maxmemory-policy allkeys-lru" >> /home/donna/app/redis/redis.cfg</td>
  </tr>
</table>

#####Donna removes the current Redis container 
<BR>
<table bgcolor=eeeeee border>
  <tr>
    <td>$ docker rm -f qa-redis-1</td>
  </tr>
</table>

#####She launches a new Redis container that uses the customized configuration file
<BR>
<table bgcolor=eeeeee border>
  <tr>
    <td>$ docker run --name qa-redis-1 
-v /home/donna/app/redis/redis.cfg:/usr/local/etc/redis/redis.conf 
-d redis redis-server /usr/local/etc/redis/redis.conf</td>
  </tr>
</table>

#####She then reconfirms that Redis is running and with the correct configuration
<BR>
<table bgcolor=eeeeee border>
  <tr>
    <td>$ docker exec qa-redis-1  /usr/local/bin/redis-cli info</td>
  </tr>
</table>

#####Donna want to make sure she can connect to Redis from inside a container so she runs the following command
<BR>
<table bgcolor=eeeeee border>
  <tr>
    <td>$ docker run -it redis  /usr/local/bin/redis-cli -h \`docker inspect  --format '{{ .NetworkSettings.IPAddress }}'  qa-redis-1\` info</td>
  </tr>
</table>

#####Donna tries the same for Mongo
<BR>
<table bgcolor=eeeeee border>
  <tr>
    <td>$ docker run -it mongo mongo --host \`docker inspect  --format '{{ .NetworkSettings.IPAddress }}'
 qa-db-1\` --eval "printjson(db.serverStatus())"</td>
  </tr>
</table>

#####Before continuing Donna cleans up all the stopped containers
<BR>
<table bgcolor=eeeeee border>
  <tr>
    <td>$ docker ps -a<BR>
$ docker rm \`docker ps -a | grep Exited | awk '{print $1}' \`<BR>
$ docker ps -a</td>
  </tr>
</table>
