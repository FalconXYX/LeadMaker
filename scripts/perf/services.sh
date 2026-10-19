#!/usr/bin/env sh
# Starts gateway/query/crm-write/relay on the host against the perf database and a private Redis DB.
# Usage: scripts/perf/services.sh start|stop|pids
#   PERF_DB (leadmaker_perf), PERF_REDIS_DB (6), PERF_PORT_BASE (19080), PERF_LOG_DIR (/tmp/leadmaker-perf),
#   DATABASE_POOL_MAX (10, per process), LOG_LEVEL (info), PERF_DB_PARAMS (URL query, e.g. options=-c%20jit%3Doff)
#   Everything else in the environment passes through, e.g. query's DATABASE_SEARCH_POOL_MAX, SEARCH_CONCURRENCY,
#   SEARCH_QUEUE_MAX, SEARCH_STATEMENT_TIMEOUT_MS, STATEMENT_TIMEOUT_MS and the gateway's UPSTREAM_TIMEOUT_MS.
set -eu
cd "$(dirname "$0")/../.."

db="${PERF_DB:-leadmaker_perf}"
redis_db="${PERF_REDIS_DB:-6}"
base="${PERF_PORT_BASE:-19080}"
logs="${PERF_LOG_DIR:-/tmp/leadmaker-perf}"
case "$db" in *_perf) ;; *) echo "PERF_DB must end in _perf" >&2; exit 2 ;; esac
[ "$redis_db" != 0 ] || { echo "PERF_REDIS_DB must not be 0" >&2; exit 2; }
mkdir -p "$logs"

start_one() {  # name port
    (
        export NODE_ENV=production PORT="$2" DEMO_MODE=1 \
            DATABASE_URL="postgres://leadmaker:leadmaker@localhost:55432/$db${PERF_DB_PARAMS:+?$PERF_DB_PARAMS}" \
            REDIS_URL="redis://localhost:56379/$redis_db" \
            JWT_SECRET=perf-jwt-secret INTERNAL_TOKEN=perf-internal-token \
            QUERY_URL="http://localhost:$((base + 1))" CRM_WRITE_URL="http://localhost:$((base + 2))" \
            RATE_LIMIT_PER_SECOND="${RATE_LIMIT_PER_SECOND:-1000}" RATE_LIMIT_BURST="${RATE_LIMIT_BURST:-2000}" \
            DATABASE_POOL_MAX="${DATABASE_POOL_MAX:-10}" LOG_LEVEL="${LOG_LEVEL:-info}"
        cd "services/$1"
        nohup node src/index.ts >"$logs/$1.log" 2>&1 &
        echo $! >"$logs/$1.pid"
    )
}

case "${1:-}" in
start)
    start_one query $((base + 1))
    start_one crm-write $((base + 2))
    start_one relay $((base + 3))
    start_one gateway "$base"
    for port in "$base" $((base + 1)) $((base + 2)) $((base + 3)); do
        i=0
        until curl -fsS "http://localhost:$port/healthz" >/dev/null 2>&1 || curl -fsS "http://localhost:$port/health" >/dev/null 2>&1; do
            i=$((i + 1))
            [ "$i" -lt 60 ] || { echo "port $port did not become healthy; see $logs" >&2; exit 1; }
            sleep 0.5
        done
    done
    echo "services up on $base-$((base + 3)) (db $db, redis db $redis_db, logs $logs)"
    ;;
stop)
    for s in gateway query crm-write relay; do
        [ -f "$logs/$s.pid" ] && kill "$(cat "$logs/$s.pid")" 2>/dev/null || true
        rm -f "$logs/$s.pid"
    done
    ;;
pids)
    sep=''
    for s in gateway query crm-write relay; do
        [ -f "$logs/$s.pid" ] && printf '%s%s=%s' "$sep" "$s" "$(cat "$logs/$s.pid")" && sep=','
    done
    echo
    ;;
*) echo "usage: $0 start|stop|pids" >&2; exit 2 ;;
esac
