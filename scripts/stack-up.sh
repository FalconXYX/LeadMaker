#!/usr/bin/env sh
# Brings up the whole local stack with the demo data; the same as docker compose --profile app up -d --build,
# plus --wait for healthy services. Compose runs, in order: migrations (dbmate), the Section 1 import (a copy
# of data/leadmaker.db, idempotent), db/seed (idempotent), then the four services and the worker.
# SKIP_BUILD=1 reuses the built images; SECTION1_DB=path imports another Section 1 file.
set -eu

if [ -n "${SECTION1_DB:-}" ]; then
    [ -f "$SECTION1_DB" ] || { echo "no such file: $SECTION1_DB" >&2; exit 2; }
    SECTION1_DIR=$(cd "$(dirname "$SECTION1_DB")" && pwd)
    SECTION1_DB_FILE=$(basename "$SECTION1_DB")
    export SECTION1_DIR SECTION1_DB_FILE
fi
cd "$(dirname "$0")/.."
if [ -n "${SKIP_BUILD:-}" ]; then build=--no-build; else build=--build; fi
docker compose --profile app up -d --wait "$build"
echo "stack up: gateway http://$(docker compose port gateway 8080)"
