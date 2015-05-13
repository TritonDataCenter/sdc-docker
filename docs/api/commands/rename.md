# rename

    Usage: docker rename OLD_NAME NEW_NAME

    rename an existing container to a NEW_NAME

The `docker rename` command allows the container to be renamed to a different name.

## Divergence

There is no known divergence between the Triton SDC Docker and Docker Inc. implementations of this method. Please contact Joyent support or file a ticket if you discover any.

## Related

- [`sdc-renamemachine`](https://apidocs.joyent.com/cloudapi/#RenameMachine) and `POST /my/machines/:id?action=rename` in CloudAPI
