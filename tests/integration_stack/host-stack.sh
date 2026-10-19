#!/usr/bin/env sh
# Runs gateway, query, crm-write and relay (and services/notifier once it exists) on the host against a private
# database and Redis DB index, for dry runs of the suite without the compose 'app' profile.
#   tests/integration_stack/host-stack.sh setup    drop + migrate E2E_DB, import a copy of data/leadmaker.db (host .venv), seed
#   tests/integration_stack/host-stack.sh start    start the services (logs and pids in E2E_STATE_DIR)
#   tests/integration_stack/host-stack.sh stop     stop them
#   tests/integration_stack/host-stack.sh test     setup, start, run.sh, stop
# The gateway caches users.role for USER_ROLE_TTL_SECONDS (default 3 here, so the role-freshness test is quick).
set -eu
cd "$(dirname "$0")/../.."

db="${E2E_DB:-leadmaker_e2e}"
redis_db="${E2E_REDIS_DB:-5}"
state="${E2E_STATE_DIR:-${TMPDIR:-/tmp}/leadmaker-e2e}"
gw="${E2E_GATEWAY_PORT:-18080}" q="${E2E_QUERY_PORT:-18081}" crm="${E2E_CRM_PORT:-18082}" relay="${E2E_RELAY_PORT:-18083}"
notifier="${E2E_NOTIFIER_PORT:-18084}" role_ttl="${USER_ROLE_TTL_SECONDS:-3}"
case "$db" in leadmaker | leadmaker_test | *_test) echo "refusing shared database $db" >&2; exit 2 ;; esac
[ "$redis_db" = 0 ] && { echo "refusing Redis DB 0" >&2; exit 2; }

export DATABASE_URL="postgres://leadmaker:leadmaker@localhost:${POSTGRES_HOST_PORT:-55432}/$db"
export REDIS_URL="redis://localhost:${REDIS_HOST_PORT:-56379}/$redis_db"
export INTERNAL_TOKEN="${INTERNAL_TOKEN:-e2e-internal-token}"
export JWT_SECRET="${JWT_SECRET:-e2e-jwt-secret}"
export DEMO_MODE=1 LOG_LEVEL="${LOG_LEVEL:-warn}"

pg() { docker compose exec -T postgres psql -U leadmaker -d "$db" -X -q -v ON_ERROR_STOP=1 "$@"; }
has_notifier() { [ -f services/notifier/src/index.ts ]; }

setup() {
    sh scripts/dbmate.sh --db "$db" drop >/dev/null 2>&1 || true
    sh scripts/dbmate.sh --db "$db" up >/dev/null
    mkdir -p "$state/import"
    for f in data/leadmaker.db data/leadmaker.db-wal data/leadmaker.db-shm; do
        if [ -f "$f" ]; then cp "$f" "$state/import/"; fi
    done
    env -u DATABASE_URL .venv/bin/leadmaker --db "postgresql+psycopg://leadmaker:leadmaker@localhost:${POSTGRES_HOST_PORT:-55432}/$db" \
        import-sqlite "$state/import/leadmaker.db" >/dev/null
    { printf "SET seed.per_rep = '%s';\n" "${SEED_LEADS_PER_REP:-50}"; cat db/seed/*.sql; } | pg --single-transaction -f -
    docker compose exec -T redis redis-cli -n "$redis_db" FLUSHDB >/dev/null
}

launch() {  # name port env...
    name="$1" port="$2"; shift 2
    env PORT="$port" "$@" node "services/$name/src/index.ts" >"$state/$name.log" 2>&1 &
    echo $! >"$state/$name.pid"
}

ready() {  # url: waits up to 30 s
    i=0
    until curl -fsS -o /dev/null "$1" 2>/dev/null; do
        i=$((i + 1))
        [ $i -gt 60 ] && return 1
        sleep 0.5
    done
}

start() {
    mkdir -p "$state"
    launch query "$q"
    launch crm-write "$crm" QUERY_URL="http://localhost:$q" LEADMAKER_USER_JOBS_PER_HOUR="${LEADMAKER_USER_JOBS_PER_HOUR:-5}"
    launch relay "$relay" OUTBOX_POLL_INTERVAL_MS=500
    # Optional: without it the gateway answers /api/notifications with 502 and the suite skips the notifications block.
    has_notifier && launch notifier "$notifier" NOTIFIER_CONSUMER_NAME=e2e
    launch gateway "$gw" QUERY_URL="http://localhost:$q" CRM_WRITE_URL="http://localhost:$crm" NOTIFIER_URL="http://localhost:$notifier" \
        USER_ROLE_TTL_SECONDS="$role_ttl"
    for url in "http://localhost:$q/healthz" "http://localhost:$crm/health" "http://localhost:$relay/healthz" "http://localhost:$gw/readyz"; do
        ready "$url" || { echo "not ready: $url (logs in $state)" >&2; return 1; }
    done
    if has_notifier && ! ready "http://localhost:$notifier/healthz"; then
        echo "warning: notifier not ready on :$notifier, stopped (see $state/notifier.log)" >&2
        kill "$(cat "$state/notifier.pid")" 2>/dev/null || true
        rm -f "$state/notifier.pid"
    fi
    echo "stack up: gateway http://localhost:$gw (logs in $state)"
}

stop() {
    for name in gateway notifier relay crm-write query; do
        f="$state/$name.pid"
        [ -f "$f" ] && { kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }
    done
}

case "${1:-test}" in
    setup) setup ;;
    start) start ;;
    stop) stop ;;
    test)
        setup
        trap stop EXIT INT TERM
        start
        GATEWAY_URL="http://localhost:$gw" E2E_DB="$db" E2E_PIPELINE=host USER_ROLE_TTL_SECONDS="$role_ttl" sh tests/integration_stack/run.sh
        ;;
    *) echo "usage: $0 setup|start|stop|test" >&2; exit 2 ;;
esac
