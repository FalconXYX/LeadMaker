#!/usr/bin/env sh
# Loads the demo snapshot (db/snapshot/leadmaker-demo.dump, data only) into an EMPTY, migrated database: real
# leads, enrichment, AI insights, territory briefs and NWS/NOAA signals, plus the demo users and their sales
# history. Never restores over existing data: with any company present it does nothing. Then it moves the demo
# sales history (activity, tasks, allocations, rep state, notifications) forward by whole days so the latest
# activity is today; AI text, signals and pipeline history keep their real dates. SNAPSHOT_SHIFT_DATES=0 keeps
# every date as captured. SNAPSHOT_RESTORE=0 or a missing file skips the restore (the Section 1 import and the
# seed then load the database instead).
# Uses pg_restore and psql with a postgres:// DATABASE_URL when both exist (the compose 'restore' service), else
# the compose postgres container.
set -eu
cd "$(dirname "$0")/.."

snapshot="${SNAPSHOT_FILE:-db/snapshot/leadmaker-demo.dump}"
case "${SNAPSHOT_RESTORE:-1}" in
    0 | false | no) echo "restore: SNAPSHOT_RESTORE=${SNAPSHOT_RESTORE}; skipping"; exit 0 ;;
esac
if [ ! -f "$snapshot" ]; then
    echo "restore: no snapshot at $snapshot; skipping"
    exit 0
fi

if case "${DATABASE_URL:-}" in postgres://* | postgresql://*) command -v pg_restore >/dev/null 2>&1 ;; *) false ;; esac; then
    sql() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
    as_sql() { pg_restore "$@" -f - "$snapshot"; }
else
    db="${SNAPSHOT_DB:-leadmaker}"
    sql() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-leadmaker}" -d "$db" -X -q -v ON_ERROR_STOP=1 "$@"; }
    as_sql() { docker compose exec -T postgres pg_restore "$@" -f - < "$snapshot"; }
fi

companies=$(sql -At -c "SELECT count(*) FROM companies")
if [ "$companies" != 0 ]; then
    echo "restore: the database already has $companies companies; snapshot not restored"
    exit 0
fi

# Data only (the migrations own the schema), in one transaction: all or nothing. It re-checks that there are no
# companies, then replaces the default lead-sourcing area the migrations insert with the snapshot's.
# --disable-triggers: no outbox rows or version bumps while loading, and foreign keys are not checked mid-load
# (the snapshot is a consistent copy).
# COMMIT is sent only after pg_restore succeeded; without it psql's transaction rolls back.
{
    printf '%s\n' "BEGIN;" \
        "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM companies) THEN RAISE EXCEPTION 'companies appeared; snapshot not restored'; END IF; END \$\$;" \
        "DELETE FROM schedules;"
    as_sql --data-only --disable-triggers --no-owner --exit-on-error && printf 'COMMIT;\n'
} | sql > /dev/null
loaded=$(sql -At -c "SELECT count(*) FROM companies")
if [ "$loaded" = 0 ]; then
    echo "restore: loading $snapshot failed; nothing was written" >&2
    exit 1
fi
echo "restore: loaded $snapshot ($loaded companies)"

case "${SNAPSHOT_SHIFT_DATES:-1}" in
    0 | false | no) shift_dates=0 ;;
    *) shift_dates=1 ;;
esac
sql -v shift="$shift_dates" <<'SQL'
BEGIN;
SET LOCAL session_replication_role = replica;  -- plain data fix-up: no triggers, no outbox rows
SELECT GREATEST(current_date - max(created_at)::date, 0) AS days FROM activity_logs WHERE actor_type = 'user' \gset
\if :shift
UPDATE activity_logs SET created_at = created_at + make_interval(days => :days) WHERE actor_type = 'user';
UPDATE tasks SET due_at = due_at + make_interval(days => :days), done_at = done_at + make_interval(days => :days),
    created_at = created_at + make_interval(days => :days), updated_at = updated_at + make_interval(days => :days);
UPDATE companies SET last_contacted_at = last_contacted_at + make_interval(days => :days),
    stage_changed_at = stage_changed_at + make_interval(days => :days)
 WHERE last_contacted_at IS NOT NULL OR stage_changed_at IS NOT NULL;
UPDATE lead_allocations SET allocated_at = allocated_at + make_interval(days => :days),
    ended_at = ended_at + make_interval(days => :days);
UPDATE lead_rep_state SET checked_at = checked_at + make_interval(days => :days),
    serviced_at = serviced_at + make_interval(days => :days), updated_at = updated_at + make_interval(days => :days);
UPDATE notifications SET created_at = created_at + make_interval(days => :days),
    updated_at = updated_at + make_interval(days => :days), read_at = read_at + make_interval(days => :days);
\echo restore: demo history moved forward :days day(s)
\endif
REFRESH MATERIALIZED VIEW team_dashboard_kpis;
COMMIT;
SQL
echo "restore: done"
