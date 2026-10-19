#!/usr/bin/env sh
# Proves every migration's down undoes its up: applies all migrations to a scratch database,
# rolls them all back, checks nothing is left behind, applies them again, then drops the database.
# Needs the compose postgres running (npm run db:up).
set -eu
cd "$(dirname "$0")/.."

db=leadmaker_roundtrip
dbmate() { sh scripts/dbmate.sh --db "$db" "$@"; }
psql_db() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-leadmaker}" -d "$db" -Atc "$1"; }

dbmate drop >/dev/null
dbmate --wait up
n=$(ls db/migrations/*.sql | wc -l | tr -d ' ')
i=0
while [ "$i" -lt "$n" ]; do
    dbmate rollback
    i=$((i + 1))
done

left=$(psql_db "
    SELECT string_agg(name, ', ') FROM (
        SELECT c.relname AS name FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind IN ('r', 'm', 'v', 'S', 'i') AND c.relname NOT LIKE 'schema_migrations%'
        UNION ALL SELECT 'extension ' || extname FROM pg_extension WHERE extname <> 'plpgsql'
        UNION ALL SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
        WHERE s.nspname = 'public'
        UNION ALL SELECT 'type ' || t.typname FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace
        WHERE s.nspname = 'public' AND t.typtype IN ('c', 'e', 'd') AND t.typrelid = 0
    ) x")
if [ -n "$left" ]; then
    echo "rollback left objects behind: $left" >&2
    exit 1
fi
echo "all $n migrations rolled back cleanly"

dbmate up
dbmate drop >/dev/null
echo "round trip OK"
