var linuxSignalNames = [
    'SIGHUP',
    'SIGINT',
    'SIGQUIT',
    'SIGILL',
    'SIGTRAP',
    'SIGABRT',
    'SIGBUS',
    'SIGFPE',
    'SIGUSR1',
    'SIGSEGV',
    'SIGUSR2',
    'SIGPIPE',
    'SIGALRM',
    'SIGTERM',
    // Please not that for now we do not support sending SIGSTKFLT to a Docker
    // container, so the handler set for it would not be called. However, we
    // should be able to support that eventually, so we still set it up.
    'SIGSTKFLT',
    'SIGCHLD',
    'SIGCONT',
    'SIGTSTP',
    'SIGTTIN',
    'SIGTTOU',
    'SIGURG',
    'SIGXCPU',
    'SIGXFSZ',
    'SIGVTALRM',
    'SIGPROF',
    'SIGWINCH',
    'SIGPOLL',
    'SIGPWR',
    'SIGSYS'
];

linuxSignalNames.forEach(function setupSignalHandler(signalName) {
    process.on(signalName, function onSignal() {
        console.log(signalName);
    });
});

// Hold the loop open without using I/O from stdin so that this code can be run
// by a Docker container started in detached mode (with docker run -d).
setInterval(function noOp() {
}, 10 * 1000);
