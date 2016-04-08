# commit

## Divergence

Commit works the same in Triton SDC Docker and Docker Inc, except for below caveat:

 * in Triton SDC Docker, an image cannot have tags that reference two different
   registries. Example:

    ```
        $ docker run -d busybox sh -c "touch /newfile.txt && sleep 86400"
        123456789
        $ docker commit 123456789 tagname  (okay, same registry - 'docker.io')
        $ docker commit 123456789 quay.io/user/tagname   (different registry - fails)
    ```

## Related

- Insert a list of related Docker and CloudAPI methods here
