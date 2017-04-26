A simple and *stable* nginx image for use in sdc-docker.git
tests. Before this we often used 'nginx:latest', and hit at
least one bug there it changed its exposed ports that broke
our tests.

- exposes TCP ports 80 and 443
- uses the nginx-alpine image to be smaller
