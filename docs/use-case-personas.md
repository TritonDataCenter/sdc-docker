#Use Case Personas
##Donna 
###Role : Senior Developer/Application architect
- Technical lead for a newly started greenfield software development project. 
- Part of a 5-10 person team, 100% focused on getting the new product to market as fast as possible. Cost is not the primary concern.  Recognize that normal purchasing process is time prohibitive. 
- Need to have a clear path to performance and scale, but initial milestones are all focused around functionality. 
- Donna and her team have decided to architect the new system as a collection of micro services

####Key motivators: 
- Anything to shorten the go to market schedule for the next new application
- Minimal dependency on any other part of the organization (e.g. IT)
- Smooth, gradual learning curve
- Well understood technology
- Distinct separation between dev and ops
- Easy to get started with new sub components 
- Clear path from “laptop development” to production
- Avoiding complexity of infrastructure
- Simplicity, ease of use
- Rapid identification of source of performance problems
- Node debugging

####Where does Docker fit in?
- Docker is the primary delivery mechanism for software packages. When Donna wants to try a new software component, she downloads a Docker image from Docker Hub or she finds a DockerFile on Github.
- Each developer is responsible for a set of micro services which are each packaged and delivered in a Docker container
- Continuous Integration and testing automation is all instrumented using Docker

##Jonah
###DevOps Manager
- 3-5 years in the current role. 
- Responsible for deploying products to staging and production. This responsibility includes performance testing, security, logging and monitoring. 
- Was responsible for selecting Splunk for log management and statsd/graphite combined with Nagios for monitoring. 
- Hires a 3rd party on a periodic basis for compliance certification and penetration testing. 
- After Jonah moved all external facing applications to the public cloud, there has not been a need for a dedicated network resource on his team.
- Jonah is a trusted technology advisor for IT management.

####Key motivators:
- Driving down cost
- Increase utilization
- Easy to manage tools and infrastructure
- Predictability and Reliability
- Repeatable process oriented technology
- Technology that clearly defines demarcation between development and operations
- Abundant availability of training and certification 
- Supported solution 
- Distinct separation between dev and ops
- Concerned about networking
- Concerned about security
- Concerned about log management
- Concerned about monitoring
- Persistence
 
####Where does Docker fit in?
- Guarantees that if the software works on the developer’s laptop, it works on the server regardless of versions, distros and dependencies.
- Standardized way of receiving software from development
- Minimizes the risk of deployment errors between testing, staging and production environments

