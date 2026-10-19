#!/usr/bin/env sh
# The load matrix: 50 / 200 / 500 VUs with a 2.5 s mean think time (500 VUs ~= the §3 200 req/s), each cold
# (private Redis DB flushed) then warm, plus a 5% write mix at 500 VUs and a back-to-back saturation run.
# Expects scripts/perf/services.sh start to have run. Results: scripts/perf/results/runs/[$LABEL_PREFIX]*.json
set -eu
cd "$(dirname "$0")/../.."
redis="redis://localhost:56379/${PERF_REDIS_DB:-6}"
duration="${DURATION:-60}"
prefix="${LABEL_PREFIX:-}"
pids="$(sh scripts/perf/services.sh pids)"
run() { node scripts/perf/load.mjs "$@" --sample "$pids" --sample-container leadmaker-postgres-1 --duration "$duration"; }  # first --flag wins

for vus in 50 200 500; do
    run --vus "$vus" --think 2500 --label "${prefix}vus$vus-cold" --flush-redis "$redis"
    run --vus "$vus" --think 2500 --label "${prefix}vus$vus-warm"
done
run --vus 500 --think 2500 --writes 5 --label "${prefix}vus500-writes5"
run --vus 200 --think 0 --duration 30 --label "${prefix}vus200-saturation"
