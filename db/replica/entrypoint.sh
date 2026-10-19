#!/usr/bin/env bash
# postgres-replica: a read-only hot standby of the postgres service, fed by streaming replication.
# First start (no cluster in $PGDATA): pg_basebackup from the primary into a scratch directory, renamed into place
# only once complete, so an interrupted copy is redone rather than started. -R writes standby.signal and the
# primary_conninfo. Later starts just resume streaming. To re-clone, remove the replica's volume.
# No replication slot: a replica stopped while the primary writes more WAL than it keeps (max_wal_size) must be
# re-cloned, but a removed replica can never make the primary hold WAL forever.
set -eu
: "${PGDATA:?}" "${PRIMARY_HOST:=postgres}" "${PRIMARY_PORT:=5432}"

if [ "$(id -u)" = 0 ]; then
    mkdir -p "$(dirname "$PGDATA")"
    chown postgres:postgres "$(dirname "$PGDATA")"
    exec gosu postgres "$0" "$@"
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    partial="$PGDATA.partial"
    export PGPASSWORD="${REPLICATION_PASSWORD:-replicator}"
    tries=0
    until rm -rf "$partial" && pg_basebackup -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U replicator -w \
            -D "$partial" -X stream -R -c fast; do
        tries=$((tries + 1))
        if [ "$tries" -ge 90 ]; then
            echo "postgres-replica: no base backup from $PRIMARY_HOST after $tries tries. If the primary's data" \
                 "volume predates the replica, run the one-time setup in README (Read replica)." >&2
            exit 1
        fi
        sleep 2
    done
    unset PGPASSWORD
    chmod 700 "$partial"
    rm -rf "$PGDATA"
    mv "$partial" "$PGDATA"
fi

exec postgres -c hot_standby=on
