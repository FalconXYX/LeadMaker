#!/usr/bin/env sh
# Cross-service end-to-end suite against a running stack, through the gateway only.
#   GATEWAY_URL  gateway base URL (default http://localhost:8080)
#   E2E_DB       database the stack uses (default leadmaker); the pipeline steps and cleanup run against it
#   E2E_PIPELINE compose (default: tests/integration_stack/pipeline.py in the worker image) | host (.venv)
#   E2E_COMPOSE_PROJECT / E2E_PG_CONTAINER   where postgres runs (default compose project 'leadmaker')
#   E2E_REFRESH_MAX  most distinct refresh areas tried before expecting 429 (default 60)
#   E2E_REQUIRE_ASSISTANT=1  fail (instead of skip) when the gateway has no assistant; E2E_REDIS_DB its Redis DB index
# Needs the demo users (DEMO_MODE=1), leads allocated to rep1 and rep2 (db/seed) and GAF listings with
# reputation tags (the Section 1 import). Against the shared database the compose worker must be stopped
# (compose.sh does it): the refresh test enqueues real scrape jobs, which it deletes afterwards.
set -eu
cd "$(dirname "$0")"
# assistant.test.mjs (Section 4) runs after it: skipped unless the stack's assistant is on the fake provider.
exec node --test --test-concurrency=1 --test-reporter=spec "$@" e2e.test.mjs assistant.test.mjs
