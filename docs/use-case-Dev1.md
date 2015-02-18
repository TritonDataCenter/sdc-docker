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

```
$ docker pull mongo
$ docker pull redis
```

### S2 Starting MongoDB

#### Starting the mongo container
```
$ docker run --name qa-db-1 -d -p 27017:27017 mongo
```

##### A quick test to ensure the database is up and running correctly 
```
$ docker exec qa-db-1 mongo  test --eval "printjson(db.serverStatus())"
```

##### To ensure mongo can be accessed outside of the mongo container Donna "curls" to the port she expects mongo is listening to
```
$ curl `docker inspect  --format '{{ .NetworkSettings.IPAddress }}' qa-db-1`:27017
```

######The result she expected looks like this. 
```
It looks like you are trying to access MongoDB over HTTP on the native driver port.
```

### S3 Starting Redis

####Starting the Redis container

```
$ docker run --name qa-redis-1 -d redis
```

######A quick test to ensure redis is up and running correctly 
```
$ docker exec qa-redis-1  /usr/local/bin/redis-cli info
```

#####To ensure Redis can be accessed outside of the Redis container Donna "curls" to the port she expects Redis is listening to
```
$ curl `docker inspect  --format '{{ .NetworkSettings.IPAddress }}' 
 qa-redis-1`:6379`
```

######The expected result is not formatted well, but it is clear that the port is responding 
```
-ERR wrong number of arguments for 'get' command
-ERR unknown command 'User-Agent:'
-ERR unknown command 'Host:'
-ERR unknown command 'Accept:'
^C
```

##### Donna wants to use Redis as a caching services so she needs to make configuration changes 
```
$ echo "maxmemory 2mb" > /home/donna/app/redis/redis.cfg<BR>
$ echo "maxmemory-policy allkeys-lru" >> /home/donna/app/redis/redis.cfg
```
#####Donna removes the current Redis container 
```
$ docker rm -f qa-redis-1
```

#####She launches a new Redis container that uses the customized configuration file
```
$ docker run --name qa-redis-1 
-v /home/donna/app/redis/redis.cfg:/usr/local/etc/redis/redis.conf 
-d redis redis-server /usr/local/etc/redis/redis.conf
```

#####She then reconfirms that Redis is running and with the correct configuration
```
$ docker exec qa-redis-1  /usr/local/bin/redis-cli info
```

#####Donna want to make sure she can connect to Redis from inside a container so she runs the following command
```
$ docker run -it redis  /usr/local/bin/redis-cli -h `docker inspect  --format '{{ .NetworkSettings.IPAddress }}'  qa-redis-1` info
```

#####Donna tries the same for Mongo
```
$ docker run -it mongo mongo --host `docker inspect  --format '{{ .NetworkSettings.IPAddress }}'
 qa-db-1` --eval "printjson(db.serverStatus())"
 ```

#####Before continuing Donna cleans up all the stopped containers
```
$ docker ps -a
$ docker rm `docker ps -a | grep Exited | awk '{print $1}' `
$ docker ps -a
```