## login

    Usage: docker login [OPTIONS] [SERVER]

    Register or log in to a Docker registry server, if no server is
	specified "https://index.docker.io/v1/" is the default.

      -e, --email=""       Email
      -p, --password=""    Password
      -u, --username=""    Username

If you want to login to a self-hosted registry you can specify this by
adding the server name.

    example:
    $ docker login localhost:8080
