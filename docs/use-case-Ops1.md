

##Creating a Docker based service discovery
Jonah starts to think about how he could make a very simple Service Discovery purely based on metadata from Docker. He begins by starting two instances of the eviking/mydockerapp container. Old habits make him remap the host port to a port other than the default specified in the image on the 2nd container
```
$ docker run -d --name=myApp eviking/mydockerapp
$ docker run -d -p 8088:8089 --name=myApp2 eviking/mydockerapp
```
A quick test to ensure both application containers are running (Make sure Trent’s json tool is installed)
```
$ docker inspect `docker ps -q -f status=running`| json -gaj -c 'this.Config.Image=="eviking/mydockerapp"' Config.Image Config.Hostname  NetworkSettings.IPAddress NetworkSettings.Ports
```
The expected result is in json
```
[
  {
    "Config.Image": "eviking/mydockerapp",
    "Config.Hostname": "a137d48a862d",
    "NetworkSettings.IPAddress": "172.17.0.4",
    "NetworkSettings.Ports": {
      "8089/tcp": [
        {
          "HostIp": "0.0.0.0",
          "HostPort": "8088"
        }
      ]
    }
  },
  {
    "Config.Image": "eviking/mydockerapp",
    "Config.Hostname": "32da762ec20d",
    "NetworkSettings.IPAddress": "172.17.0.3",
    "NetworkSettings.Ports": {
      "8089/tcp": null
    }
  }
]
```

###_Creating a load balancer based on HAproxy and Docker_
Jonah takes the next logical step and starts to build a HAproxy load balancer based on metadata out of Docker. He writes a little node.js program that can process the information and turn it into a HAproxy config file.

```
var _fs = require('fs');

var body = '';
var data = '';
var port = '';
var containerName = '';

process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', function(chunk) {
    body += chunk;
});

process.argv.forEach(function (val, index, array) {
  containerName = val;
});

process.stdin.on('end', function () {
   try {
     _fs.readFile('haproxyCFG.template', 'utf8', function (err,cfgheader) {
       if (err) {
         return console.log(err);
       }
       data = JSON.parse(body);
       console.log(cfgheader);
       for (container in data) {
         if (data[container]['Config']['Image'] == containerName) {
           port = String(Object.keys(data[container]['NetworkSettings']['Ports']));
           console.log("    server " + data[container]['Config']['Hostname'] + " " + data[container]['NetworkSettings']['IPAddress'] + ":" + port.split("/")[0] + " maxconn 32");
         }
       }
     });
   } catch (er) {
      console.log('error: ' + er.message);
   }
})   
```

The script requires a template file called __haproxyCFG.template__
```
   global
        #daemon
        maxconn 256

    defaults
        mode http
        timeout connect 5000ms
        timeout client 50000ms
        timeout server 50000ms

    listen http-in
    bind *:80
    stats enable
    stats hide-version
    stats scope   .
    stats uri     /admin?stats
    stats realm   Haproxy\ Statistics
    stats auth    admin:joypass123
```
Now Jonah can run the following command to generate the HAproxy configuration file. __eviking/mydockerapp__ is the full container name that Jonah wants to load balance.
```
$ docker inspect `docker ps -q -f status=running` | node HAproxyGen.js eviking/mydockerapp > haproxy.cfg
```
The generated configuration file should look like this:
```
    global
        #daemon
        maxconn 256

    defaults
        mode http
        timeout connect 5000ms
        timeout client 50000ms
        timeout server 50000ms

    listen http-in
    bind *:80
    stats enable
    stats hide-version
    stats scope   .
    stats uri     /admin?stats
    stats realm   Haproxy\ Statistics
    stats auth    admin:joypass123

    server a137d48a862d 172.17.0.4:8089 maxconn 32
    server 32da762ec20d 172.17.0.3:8089 maxconn 32
```
The final step is to start the HAproxy container with the newly generated configuration file.
```
$ docker run -d  -p 80:80 -v /home/ubuntu/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg --name lb  haproxy
```
Jonah is now ready to test it by curling the HAproxy stats page
```
$ curl -u admin "http://`docker inspect  --format '{{ .NetworkSettings.IPAddress }}' lb`/admin?stats;csv"
```
The expected output looks something like this: (The password is *joypass123*)
```
Enter host password for user 'admin':
# pxname,svname,qcur,qmax,scur,smax,slim,stot,bin,bout,dreq,dresp,ereq,econ,eresp,wretr,wredis,status,weight,act,bck,chkfail,chkdown,lastchg,downtime,qlimit,pid,iid,sid,throttle,lbtot,tracked,type,rate,rate_lim,rate_max,check_status,check_code,check_duration,hrsp_1xx,hrsp_2xx,hrsp_3xx,hrsp_4xx,hrsp_5xx,hrsp_other,hanafail,req_rate,req_rate_max,req_tot,cli_abrt,srv_abrt,comp_in,comp_out,comp_byp,comp_rsp,lastsess,last_chk,last_agt,qtime,ctime,rtime,ttime,
http-in,FRONTEND,,,1,1,2000,1,0,0,0,0,0,,,,,OPEN,,,,,,,,,1,1,0,,,,0,1,0,1,,,,0,0,0,0,0,0,,1,1,1,,,0,0,0,0,,,,,,,,
http-in,a137d48a862d,0,0,0,0,32,0,0,0,,0,,0,0,0,0,no check,1,1,0,,,,,,1,1,1,,0,,2,0,,0,,,,0,0,0,0,0,0,0,,,,0,0,,,,,-1,,,0,0,0,0,
http-in,32da762ec20d,0,0,0,0,32,0,0,0,,0,,0,0,0,0,no check,1,1,0,,,,,,1,1,2,,0,,2,0,,0,,,,0,0,0,0,0,0,0,,,,0,0,,,,,-1,,,0,0,0,0,
http-in,BACKEND,0,0,0,0,200,0,0,0,0,0,,0,0,0,0,UP,2,2,0,,0,113,0,,1,1,0,,0,,1,0,,0,,,,0,0,0,0,0,0,,,,,0,0,0,0,0,0,0,,,0,0,0,0,
```
Jonah tries to access the load-balanced application by "curl'ing" the load balancer
```
$ curl  "http://`docker inspect  --format '{{ .NetworkSettings.IPAddress }}' lb`/"
{ "requestCounter":10, "hostname":a137d48a862d ,"dockerContainerName":a137d48a862d}

$ curl  "http://`docker inspect  --format '{{ .NetworkSettings.IPAddress }}' lb`/"
{ "requestCounter":9, "hostname":32da762ec20d ,"dockerContainerName":32da762ec20d}

$ curl  "http://`docker inspect  --format '{{ .NetworkSettings.IPAddress }}' lb`/"
{ "requestCounter":11, "hostname":a137d48a862d ,"dockerContainerName":a137d48a862d}

$ curl  "http://`docker inspect  --format '{{ .NetworkSettings.IPAddress }}' lb`/"
{ "requestCounter":10, "hostname":32da762ec20d ,"dockerContainerName":32da762ec20d}
```

This lets him validate that HAproxy is load-balancing correctly between the two node containers.

The last test Jonah tries is to add another container to the load-balancing 
```
$ docker run -d --name myApp3  eviking/mydockerapp
5713dcf7c562dc7cc56cf484ef71a588418d16214c00652361cb27bbee52941f
$ docker inspect `docker ps -q -f status=running` | node HAproxyGen.js eviking/mydockerapp > haproxy.cfg ; docker restart lb
lb
```
Curl'ing the stats csv validates that the 3rd container is now part of the load balancing group. (The password is *joypass123*)
```
$ curl -u admin "http://`docker inspect  --format '{{ .NetworkSettings.IPAddress }}' lb`/admin?stats;csv"
Enter host password for user 'admin':
# pxname,svname,qcur,qmax,scur,smax,slim,stot,bin,bout,dreq,dresp,ereq,econ,eresp,wretr,wredis,status,weight,act,bck,chkfail,chkdown,lastchg,downtime,qlimit,pid,iid,sid,throttle,lbtot,tracked,type,rate,rate_lim,rate_max,check_status,check_code,check_duration,hrsp_1xx,hrsp_2xx,hrsp_3xx,hrsp_4xx,hrsp_5xx,hrsp_other,hanafail,req_rate,req_rate_max,req_tot,cli_abrt,srv_abrt,comp_in,comp_out,comp_byp,comp_rsp,lastsess,last_chk,last_agt,qtime,ctime,rtime,ttime,
http-in,FRONTEND,,,1,2,2000,3,800,14519,0,0,1,,,,,OPEN,,,,,,,,,1,1,0,,,,0,1,0,2,,,,0,1,0,1,0,0,,1,1,3,,,0,0,0,0,,,,,,,,
http-in,5713dcf7c562,0,0,0,0,32,0,0,0,,0,,0,0,0,0,no check,1,1,0,,,,,,1,1,1,,0,,2,0,,0,,,,0,0,0,0,0,0,0,,,,0,0,,,,,-1,,,0,0,0,0,
http-in,a137d48a862d,0,0,0,0,32,0,0,0,,0,,0,0,0,0,no check,1,1,0,,,,,,1,1,2,,0,,2,0,,0,,,,0,0,0,0,0,0,0,,,,0,0,,,,,-1,,,0,0,0,0,
http-in,32da762ec20d,0,0,0,0,32,0,0,0,,0,,0,0,0,0,no check,1,1,0,,,,,,1,1,3,,0,,2,0,,0,,,,0,0,0,0,0,0,0,,,,0,0,,,,,-1,,,0,0,0,0,
http-in,BACKEND,0,0,0,0,200,0,800,14519,0,0,,0,0,0,0,UP,3,3,0,,0,281,0,,1,1,0,,0,,1,0,,0,,,,0,0,0,0,0,0,,,,,0,0,0,0,0,0,0,,,0,0,0,0,
```

