#!/usr/bin/env sh
# Regenerates db/snapshot/leadmaker-demo.dump from the compose database (default 'leadmaker'), which a fresh
# stack then loads automatically (scripts/db-restore-snapshot.sh). The snapshot is shipped in git and carries
# EVERYTHING in the database: the demo users, their notes and sales history, and anything you typed while
# testing. Clean the data first. The source database is never written: it is copied into a scratch database
# (SNAPSHOT_SCRATCH_DB, default leadmaker_snap), the copy drops delivered outbox rows and pending jobs (a fresh
# stack must not inherit queued work), is dumped data-only (no schema_migrations, no PostGIS spatial_ref_sys),
# then dropped.
set -eu
cd "$(dirname "$0")/.."

src="${SNAPSHOT_SOURCE_DB:-leadmaker}"
scratch="${SNAPSHOT_SCRATCH_DB:-leadmaker_snap}"
out="${SNAPSHOT_FILE:-db/snapshot/leadmaker-demo.dump}"
user="${POSTGRES_USER:-leadmaker}"
for name in "$src" "$scratch"; do
    case "$name" in
        '' | *[!a-z0-9_]*) echo "invalid database name: $name" >&2; exit 2 ;;
    esac
done
[ "$src" != "$scratch" ] || { echo "the scratch database must differ from the source" >&2; exit 2; }

echo "WARNING: the snapshot includes all demo data in '$src' (users, notes, activity, tasks) and is committed to git." >&2
pg() { docker compose exec -T postgres "$@"; }
psql_on() { db="$1"; shift; pg psql -U "$user" -d "$db" -X -q -v ON_ERROR_STOP=1 "$@"; }

trap 'pg dropdb -U "$user" --if-exists "$scratch" >/dev/null 2>&1 || true' EXIT
pg dropdb -U "$user" --if-exists "$scratch"
pg createdb -U "$user" "$scratch"
pg sh -c "pg_dump -U '$user' -d '$src' -Fc | pg_restore -U '$user' -d '$scratch' --no-owner --exit-on-error"
psql_on "$scratch" -c "DELETE FROM outbox_events WHERE published_at IS NOT NULL" \
    -c "DELETE FROM jobs WHERE status IN ('queued', 'running')"

mkdir -p "$(dirname "$out")"
tmp="$out.tmp"
pg pg_dump -U "$user" -d "$scratch" -Fc -Z 9 --data-only -n public \
    -T public.schema_migrations -T public.spatial_ref_sys > "$tmp"
mv "$tmp" "$out"
echo "snapshot: $out ($(wc -c < "$out" | tr -d ' ') bytes; $(psql_on "$scratch" -At -c "SELECT count(*) FROM companies") companies)"
