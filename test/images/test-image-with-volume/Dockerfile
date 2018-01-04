FROM busybox
VOLUME /foo
# Create a file within the volume and read from that volume to test both read
# and write access. If any of these commands fails, the exit code of a container
# running this image will be non-zero and will be communicated to the test that
# created it.
CMD echo "bar" > /foo/bar && ls /foo
