#!/usr/bin/env bash
# Primary, first start only (mounted into /docker-entrypoint-initdb.d, after the image's 10_postgis.sh): the
# 'replicator' role the postgres-replica service streams from, and the pg_hba.conf line that lets it connect.
# Idempotent. REPLICATION_PASSWORD defaults to the local-dev 'replicator'; set your own outside local demos.
# An existing data volume never runs this; README "Read replica" has the one-time commands for that case.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v pw="${REPLICATION_PASSWORD:-replicator}" <<'SQL' || exit 1
SELECT format('CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator')\gexec
SQL
hba_line='host replication replicator all scram-sha-256'
grep -qxF "$hba_line" "$PGDATA/pg_hba.conf" || echo "$hba_line" >> "$PGDATA/pg_hba.conf" || exit 1
