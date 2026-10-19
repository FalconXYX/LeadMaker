#!/usr/bin/env sh
# Applies db/seed/*.sql in one transaction: demo users, then (once companies exist) ~50 leads per rep.
# Idempotent, so run it again after importing companies. SEED_LEADS_PER_REP overrides the 50; SEED_DEMO_ACTIVITY=0
# skips the demo sales history (003_demo_activity.sql).
# Uses psql with a postgres:// DATABASE_URL when both exist (the compose 'seed' service), else psql in the
# compose postgres.
set -eu
cd "$(dirname "$0")/.."

per_rep="${SEED_LEADS_PER_REP:-50}"
case "$per_rep" in
    '' | *[!0-9]*) echo "SEED_LEADS_PER_REP must be a whole number" >&2; exit 2 ;;
esac
demo_activity="${SEED_DEMO_ACTIVITY:-1}"
case "$demo_activity" in
    '' | *[!a-zA-Z0-9]*) echo "SEED_DEMO_ACTIVITY must be 1 or 0" >&2; exit 2 ;;
esac

{
    printf "SET seed.per_rep = '%s';\n" "$per_rep"
    printf "SET seed.demo_activity = '%s';\n" "$demo_activity"
    cat db/seed/*.sql
} | if case "${DATABASE_URL:-}" in postgres://* | postgresql://*) command -v psql >/dev/null 2>&1 ;; *) false ;; esac; then
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction -f -
else
    docker compose exec -T postgres psql -U "${POSTGRES_USER:-leadmaker}" -d "${SEED_DB:-leadmaker}" \
        -X -q -v ON_ERROR_STOP=1 --single-transaction -f -
fi
