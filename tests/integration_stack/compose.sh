#!/usr/bin/env sh
# The whole chain in a private compose project (default 'lme2e': its own containers, volumes and host ports),
# so the shared demo database is never written: scripts/stack-up.sh (migrations, Section 1 import, seed,
# services), the suite through the gateway with the worker stopped, then down -v. The refresh test enqueues
# real scrape jobs for 0xxxx ZIPs, which a running worker would scrape live; the suite drops them.
# Fails if docker-compose.yml lets anything but the import service (read-only) bind the Section 1 directory,
# or if the Section 1 file or its -wal/-shm changed during the run (stack-guard.mjs).
#   KEEP=1           leave the project up afterwards (worker started again); the next run reuses it
#   SKIP_STACK_UP=1  run the suite against the project as it is
#   E2E_PROJECT      compose project (default lme2e); 'leadmaker' runs against the shared stack, never torn down
#   E2E_GATEWAY_PORT / E2E_POSTGRES_PORT / E2E_REDIS_PORT / E2E_WEB_PORT
#                    host ports of a private project (18180 / 55442 / 56389 / 13000)
#   SNAPSHOT_RESTORE a private project defaults to 0 (Section 1 import + seed) when the Section 1 file exists, else 1
#                    (the committed demo snapshot)
# Other variables: see run.sh.
set -eu
cd "$(dirname "$0")/../.."

project="${E2E_PROJECT:-lme2e}"
if [ "$project" = leadmaker ]; then
    KEEP=1
else
    # A short role cache keeps the role-freshness test quick; the gateway and the suite both read it.
    export POSTGRES_HOST_PORT="${E2E_POSTGRES_PORT:-55442}" REDIS_HOST_PORT="${E2E_REDIS_PORT:-56389}" \
        GATEWAY_HOST_PORT="${E2E_GATEWAY_PORT:-18180}" WEB_HOST_PORT="${E2E_WEB_PORT:-13000}" \
        REPLICA_HOST_PORT="${E2E_REPLICA_PORT:-55443}" \
        USER_ROLE_TTL_SECONDS="${USER_ROLE_TTL_SECONDS:-5}"
    # A private stack never calls a real model: the assistant runs on the deterministic fake (assistant.test.mjs
    # needs it), the worker chains no insights after refreshes and writes no AI brief, and no provider key from
    # .env reaches the containers (shell values win over .env in compose interpolation).
    export LEADMAKER_ASSISTANT_LLM_PROVIDER=fake LEADMAKER_ALLOW_FAKE_LLM=1 LEADMAKER_INSIGHTS_ON_REFRESH=0 \
        LEADMAKER_BRIEFING_AI=0 GEMINI_API_KEY= ANTHROPIC_API_KEY= LEADMAKER_LLM_API_KEY= E2E_REQUIRE_ASSISTANT=1
fi
export COMPOSE_PROJECT_NAME="$project" E2E_COMPOSE_PROJECT="$project"

finish() {
    if [ -n "${KEEP:-}" ]; then
        docker compose --profile app start worker >/dev/null 2>&1 || true
    else
        echo "tearing down compose project $project (KEEP=1 keeps it)" >&2
        docker compose --profile app down -v --remove-orphans >/dev/null 2>&1 || true
    fi
}
trap finish EXIT
trap 'exit 130' INT TERM

guard="tests/integration_stack/stack-guard.mjs"
section1=$(docker compose --profile app config --format json | node "$guard" mounts)
section1="${SECTION1_DB:-$section1}"
# A private project runs the suite on the Section 1 import plus a fresh seed when the Section 1 file is present (what
# the suite was written against), and on the committed demo snapshot when it is not (a fresh clone has no data/).
if [ "$project" != leadmaker ] && [ -z "${SNAPSHOT_RESTORE:-}" ]; then
    if [ -f "$section1" ]; then SNAPSHOT_RESTORE=0; else SNAPSHOT_RESTORE=1; fi
    export SNAPSHOT_RESTORE
fi
before=$(node "$guard" stat "$section1")

[ -n "${SKIP_STACK_UP:-}" ] || sh scripts/stack-up.sh
docker compose --profile app stop worker
status=0
GATEWAY_URL="${GATEWAY_URL:-http://$(docker compose port gateway 8080)}" sh tests/integration_stack/run.sh "$@" || status=$?
if [ "$(node "$guard" stat "$section1")" != "$before" ]; then
    printf '%s or its -wal/-shm changed during the run; the stack must never write them. Before:\n%s\n' "$section1" "$before" >&2
    status=1
fi
exit "$status"
