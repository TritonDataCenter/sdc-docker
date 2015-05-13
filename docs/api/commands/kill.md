# kill

    Usage: docker kill [OPTIONS] CONTAINER [CONTAINER...]

    Kill a running container using SIGKILL or a specified signal

      -s, --signal="KILL"    Signal to send to the container

The main process inside the container will be sent `SIGKILL`, or any
signal specified with option `--signal`.

## Divergence

SDC Docker only supports a subset of signals for `docker kill`. These currently include:

- `SIGABRT`
- `SIGALRM`
- `SIGBUS`
- `SIGCHLD`
- `SIGCONT`
- `SIGFPE`
- `SIGHUP`
- `SIGILL`
- `SIGINT`
- `SIGIO`
- `SIGIOT`
- `SIGKILL`
- `SIGLOST`
- `SIGPIPE`
- `SIGPOLL`
- `SIGPROF`
- `SIGPWR`
- `SIGQUIT`
- `SIGSEGV`
- `SIGSTOP`
- `SIGSYS`
- `SIGTERM`
- `SIGTRAP`
- `SIGTSTP`
- `SIGTTIN`
- `SIGTTOU`
- `SIGURG`
- `SIGUSR1`
- `SIGUSR2`
- `SIGVTALRM`
- `SIGWINCH`
- `SIGXCPU`
- `SIGXFSZ`

Please contact Joyent support or file a ticket if you discover any additional divergence.

## Related

- [`docker stop`](../commands/stop.md) as in `docker stop $(docker ps -a -q)`
- [`sdc-stopmachine`](https://apidocs.joyent.com/cloudapi/#StopMachine) and `POST /my/machines/:id?action=stop` in CloudAPI
