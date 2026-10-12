#!/bin/sh
set -eu
# Railway mounts a root-owned volume; only the dedicated /data root is initialized.
if [ "$(id -u)" = 0 ]; then
    if [ "${DATA_DIR:-/data}" != /data ]; then
        echo 'Docker DATA_DIR must be /data' >&2
        exit 1
    fi
    chown node:node /data
    exec flock -n /data/renderer.lock setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec flock -n "${DATA_DIR:-/data}/renderer.lock" "$@"
