# Load test: before and after the search/runtime fixes

Run on 2026-10-18 against `leadmaker_perf`. I recreated it from scratch with `dbmate drop` and `up`, which includes `20261018220000_search_performance`. `synth.mjs` then generated 100,000 companies, 2,200 users, 185k contacts and 197k activity logs (725 MB). The services ran on the host through `scripts/perf/services.sh` (ports 19080-19083, Redis DB 6, `LOG_LEVEL=info` as in the baseline) with the fixers' settings at their defaults:

`DATABASE_POOL_MAX=10 DATABASE_SEARCH_POOL_MAX=8 SEARCH_CONCURRENCY=8 SEARCH_QUEUE_MAX=32 SEARCH_QUEUE_WAIT_MS=1000 SEARCH_STATEMENT_TIMEOUT_MS=2000 STATEMENT_TIMEOUT_MS=1000 REDIS_COMMAND_TIMEOUT_MS=250 REDIS_COOLDOWN_MS=1000 UPSTREAM_TIMEOUT_MS=5000`

I ran the matrix with `DURATION=45 LABEL_PREFIX=postfix- sh scripts/perf/matrix.sh`. The before runs are the unprefixed `runs/*.json` files from the pre-fix code; those ran for 60 s, so compare req/s rather than request counts. Two extra runs are described below.

**Environment caveats.** Postgres is the shared compose container on a laptop: 8 Docker vCPUs, default settings (`shared_buffers` 128MB for a 725 MB database, `work_mem` 4MB, `max_connections` 100) and a 64 MB `/dev/shm`. The load generator, the four Node services and other agents' work share the same 8 cores. Postgres CPU comes from `docker stats` for the whole container, where 800% means all 8 vCPUs busy.

## Verdict

| scenario | search p95 (<= 300 ms) | profile p95 (<= 200 ms) | KPI p95 (<= 500 ms) | throughput |
|---|---|---|---|---|
| §3 design load, read-only: 500 VUs, 2.5 s think (`vus500-cold` / `-warm`) | **PASS** 218 / 240 ms (was 9.6 / 12.8 s) | **PASS** 57 / 68 ms (was 14.4 / 13.3 s) | **PASS** 51 / 72 ms (was 9.0 / 4.2 s) | **200 req/s** (was 49 / 44) |
| 50 and 200 VUs | PASS, at most 65 ms | PASS, at most 27 ms | PASS, at most 23 ms | 20.6 / 80 req/s, limited only by think time |
| 500 VUs with 5% writes and cache invalidation working (`postfix-vus500-writes5-invalidating`) | **FAIL** 772 ms (+472) | **FAIL** 228 ms (+28) | PASS 245 ms | 176 req/s; 37% of searches shed with 503 |
| 500 VUs with 5% writes, matrix run (`postfix-vus500-writes5`): **not valid**, see Errors | (PASS 184 ms) | (PASS 61 ms) | (PASS 49 ms) | 199 req/s |
| Overload: 200 VUs, no think time (`vus200-saturation`), about 2.6x the design load | FAIL 855 ms (+555) | FAIL 234.5 ms (+35) | PASS 165 ms | 526 req/s (was 26); 29% of searches shed with 503 |
| Same overload with `SEARCH_CONCURRENCY=5` | FAIL 790 ms | **PASS** 190 ms | PASS 163 ms | 430 req/s; 43% of searches shed with 503 |

- **Read-only targets are met.** At the §3 load (about 200 req/s from 500 concurrent users) every read target is met, and nothing timed out: the overloaded baseline runs had 82 and 173 gateway 504s, and no after run has any. About 1.9% of searches (121 of 6,538 and 128 of 6,526) were shed with a fast 503 + Retry-After. One search failed with a 500, explained under Errors. The percentiles are computed over all responses; the p95 of 2xx responses only is within 2 ms of it (220 / 242 ms).
- **Writes are still a miss: up to 472 ms over on search and 28 ms over on profile.** Once the relay's cache invalidation actually works, a 5% write mix (5.5 writes/s) INCRs `leads:version` about 4 times a second (35 to 217 during the run). The list-cache hit rate falls to 0.3% (19 of 3,595), so every search goes to Postgres. Postgres then runs at 697% of 800% and the search limiter sheds 37% of searches. The baseline's write run had the same dead consumer, so its numbers were optimistic too.
- **Overload is handled.** The services stay responsive (526 req/s served) and shed searches fast. Profile misses the target by 35 ms with search concurrency 8 and passes with concurrency 5. The query service runs at 80–100% of one core here, so in this run it is limited by the Node event loop as well as by Postgres.

## EXPLAIN (single user, warm, median of 5)

From `node scripts/perf/explain.mjs --label postfix`. The before column is `results/explain/summary.json` (old compiler, JIT on); the after column is `results/postfix-explain/` (jit off at the database level).

| statement | median before (ms) | median after (ms) | JIT before (ms) | seq scans on companies after |
|---|---|---|---|---|
| search:default:rep | 16.8 | 9 | 0 | none |
| search:mine:rep | 4.4 | 4 | 0 | none |
| search:unallocated_tags:rep | 192.4 | 15.7 | 0 | none |
| search:cert_segment_rating:manager | 336.7 | 18.3 | 0 | Seq Scan on companies (rows=1001, loops=1) |
| search:near_distance:manager | 66 | 30.9 | 40.8 | none |
| search:near_storm:rep | 140.6 | 34.2 | 0 | none |
| search:text:rep | 61.6 | 26.9 | 32.1 | none |
| search:unchecked_team:manager | 48.7 | 7.7 | 0 | Seq Scan on companies (rows=1001, loops=1) |
| search:unchecked_me:rep | 4.2 | 3.8 | 0 | none |
| search:custom:manager | 9.5 | 7.9 | 0 | none |
| search:years_sort:manager | 1074.3 | 5.5 | 0 | none |
| search:default:manager | 32 | 6 | 0 | none |
| profile:head:rep | 1.3 | 1.1 | 0 | none |
| profile:body | 1 | 1 | 0 | none |
| kpi:mine:rep | 0.7 | 0.8 | 0 | none |
| kpi:team | 9.2 | 9.4 | 0 | none |

Every search shape is now at most 34 ms single-user. The two remaining `Seq Scan on companies (rows=1001)` entries are the capped total, which stops after 1,001 rows. Searches return `{items, nextCursor, total, totalCapped}`; I checked this through the gateway, where the default manager list gave total 1000 and totalCapped true.

## Load matrix, before and after

Columns: p50/p95/p99 in ms. "p95 of 2xx only" excludes the fast 503 sheds. Cache hit = hit / (hit + miss + bypass) of `X-Cache`.

| run | VUs | think | req/s before -> after | non-2xx before | non-2xx after | Postgres CPU % avg/max before -> after | query CPU % before -> after |
|---|---|---|---|---|---|---|---|
| vus50-cold | 50 | 2500 ms | 20.5 -> **20.6** | 0 | 0 | 101/179.6 -> 99.7/175.7 | 7.9/19.4 -> 9.3/24.1 |
| vus50-warm | 50 | 2500 ms | 20.5 -> **20.6** | 0 | 0 | 102.7/190.5 -> 34.1/62.3 | 6.8/23.9 -> 12.6/29.8 |
| vus200-cold | 200 | 2500 ms | 47 -> **79.8** | 0 | 0 | 415.9/468.9 -> 114/278.4 | 14.7/32.7 -> 28.2/61.9 |
| vus200-warm | 200 | 2500 ms | 51.2 -> **79.9** | 0 | 0 | 418.4/481.4 -> 102/230 | 16.9/32.3 -> 24/53.7 |
| vus500-cold | 500 | 2500 ms | 49.4 -> **200** | 0 | 121x search 503 | 425.6/512.6 -> 401.2/705.2 | 13.6/35.2 -> 45.2/107 |
| vus500-warm | 500 | 2500 ms | 43.9 -> **198.9** | 0 | 128x search 503, 1x search 500 | 429/499.4 -> 506.5/758.2 | 12.8/30.5 -> 50.4/87.2 |
| vus500-writes5 (not valid, see Errors) | 500 | 2500 ms | 27 -> **198.7** | 119x search 504, 54x profile 504 | 48x search 503 | 440.7/661.4 -> 494.6/614.8 | 9.3/30 -> 44.9/80.9 |
| vus200-saturation | 200 | 0 ms | 26.1 -> **525.8** | 12x search 504, 70x profile 504 | 3279x search 503 | 410.5/558.7 -> 712.2/804.1 | 6.8/23.4 -> 79.5/102.7 |

### vus50-cold (50 VUs, think 2500 ms, 46.1 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 863 / 659 | 15.9 -> 15.7 | 362.4 -> **64.7** | 576.7 -> 97.8 | n/a | PASS | 44% -> 43% |
| GET /api/leads/:id | 200 | 242 / 193 | 8 -> 8 | 20.3 -> **20** | 26.7 -> 37.4 | n/a | PASS | 44% -> 40% |
| GET /api/kpis | 500 | 126 / 98 | 4.7 -> 5.1 | 12.9 -> **18.1** | 29.8 -> 55.2 | n/a | PASS | - -> - |

Slowest search shapes after (p95 ms): text 117.7, years_sort 102.2, near_storm 83.4, custom 69.8. Max in flight 10 -> 4.

### vus50-warm (50 VUs, think 2500 ms, 46.1 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 863 / 659 | 16.4 -> 17.8 | 376.4 -> **64.7** | 586 -> 84.1 | 64.7 (659) | PASS | 44% -> 43% |
| GET /api/leads/:id | 200 | 242 / 192 | 6.4 -> 8.5 | 14.7 -> **19** | 22.5 -> 39.3 | 19 (192) | PASS | 100% -> 100% |
| GET /api/kpis | 500 | 126 / 98 | 4 -> 4.9 | 11.7 -> **15.3** | 17 -> 30.3 | 15.3 (98) | PASS | - -> - |

Slowest search shapes after (p95 ms): near_storm 84.8, years_sort 84.7, text 84.5, near_distance 69.9. Max in flight 7 -> 4.

### vus200-cold (200 VUs, think 2500 ms, 46.1 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 2027 / 2623 | 1614.3 -> 14.5 | 3849.1 -> **59.8** | 4937.8 -> 131.1 | 59.8 (2623) | PASS | 34% -> 43% |
| GET /api/leads/:id | 200 | 545 / 713 | 2782.4 -> 6.4 | 5539.4 -> **26.5** | 6451.9 -> 57 | 26.5 (713) | PASS | 48% -> 53% |
| GET /api/kpis | 500 | 255 / 344 | 1323.3 -> 4.3 | 3038.3 -> **22.3** | 3346 -> 62 | 22.3 (344) | PASS | - -> - |

Slowest search shapes after (p95 ms): near_storm 129.1, years_sort 125.8, text 65.3, near_distance 61.6. Max in flight 131 -> 25.

### vus200-warm (200 VUs, think 2500 ms, 46.1 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 2196 / 2623 | 1259 -> 13.3 | 3904.4 -> **56.8** | 5066.2 -> 175.8 | 56.8 (2623) | PASS | 35% -> 43% |
| GET /api/leads/:id | 200 | 597 / 713 | 1498.5 -> 5.2 | 3361.4 -> **19.2** | 3764.5 -> 64.2 | 19.2 (713) | PASS | 98% -> 100% |
| GET /api/kpis | 500 | 287 / 344 | 11.5 -> 3.3 | 2127.6 -> **14.3** | 2403.8 -> 104.5 | 14.3 (344) | PASS | - -> - |

Slowest search shapes after (p95 ms): near_storm 104.1, years_sort 64.4, custom 64, near_distance 62.8. Max in flight 138 -> 28.

### vus500-cold (500 VUs, think 2500 ms, 46.2 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 2141 / 6538 | 7753.8 -> 22.3 | 9612.8 -> **218.2** | 10742.3 -> 295.7 | 219.7 (6417) | PASS | 19% -> 43% |
| GET /api/leads/:id | 200 | 532 / 1805 | 8878.9 -> 11.5 | 14403.3 -> **57.1** | 14705.4 -> 122.9 | 57.1 (1805) | PASS | 51% -> 63% |
| GET /api/kpis | 500 | 296 / 888 | 7580.3 -> 8.7 | 8993.9 -> **50.8** | 9457 -> 102.9 | 50.8 (888) | PASS | - -> - |

Slowest search shapes after (p95 ms): near_distance 251.9, text 240.8, default 239.5, custom 236.4. Max in flight 442 -> 71.

### vus500-warm (500 VUs, think 2500 ms, 46.3 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 1882 / 6526 | 9327.7 -> 29.6 | 12817.2 -> **240.2** | 14858.2 -> 362.2 | 242 (6397) | PASS | 17% -> 43% |
| GET /api/leads/:id | 200 | 483 / 1799 | 9725.8 -> 15 | 13256.2 -> **67.7** | 14418.3 -> 118.8 | 67.7 (1799) | PASS | 100% -> 92% |
| GET /api/kpis | 500 | 276 / 887 | 2895.3 -> 10.2 | 4225 -> **71.9** | 5299.9 -> 119.7 | 71.9 (887) | PASS | - -> - |

Slowest search shapes after (p95 ms): text 302.8, years_sort 288.6, near_storm 274.9, near_distance 269.4. Max in flight 444 -> 93.

### vus500-writes5 (500 VUs, think 2500 ms, 5% writes, 46.2 s)

Not valid, before or after: the relay's cache-invalidation consumer was dead after the cold runs' FLUSHDB, so writes never invalidated the list cache. See `postfix-vus500-writes5-invalidating` under Extra runs.

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 1141 / 6224 | 14359 -> 26.8 | 21793.4 -> **183.6** | 23260.3 -> 290.3 | 184.1 (6176) | PASS | 15% -> 42% |
| GET /api/leads/:id | 200 | 308 / 1765 | 16321.7 -> 15 | 21965.4 -> **61.3** | 22868.6 -> 118.2 | 61.3 (1765) | PASS | 100% -> 78% |
| GET /api/kpis | 500 | 149 / 839 | 6422.8 -> 8.7 | 16676.6 -> **49.4** | 21121.1 -> 82.2 | 49.4 (839) | PASS | - -> - |
| POST /api/leads/:id/(notes|state) | - | 29 / 355 | 56.2 -> 27.8 | 196.7 -> **116.5** | 339.1 -> 171.9 | 116.5 (355) |  | - -> - |

Slowest search shapes after (p95 ms): near_storm 276.6, text 252.1, custom 228, near_distance 221.8. Max in flight 465 -> 71.

### vus200-saturation (200 VUs, think 0 ms, 30.3 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 1119 / 11237 | 8506.5 -> 92.8 | 12397.5 -> **855.1** | 15002.5 -> 1072.6 | 915.8 (7958) | FAIL (+555 ms) | 32% -> 81% |
| GET /api/leads/:id | 200 | 274 / 3116 | 9778.3 -> 107.8 | 15008.9 -> **234.5** | 15021.5 -> 315.6 | 234.5 (3116) | FAIL (+35 ms) | 99% -> 75% |
| GET /api/kpis | 500 | 182 / 1578 | 8160.3 -> 60.3 | 11174.1 -> **165** | 11673.2 -> 218.6 | 165 (1578) | PASS | - -> - |

Slowest search shapes after (p95 ms): text 1060.9, near_storm 1036.9, near_distance 980.3, scope_all 921.6. Max in flight 200 -> 145.

## Extra runs

- **`postfix-vus500-writes5-invalidating`:** the 5% write run repeated after fixing the harness so cache invalidation really runs; see Errors. Compared with the pre-fix `vus500-writes5`.
- **`postfix-vus200-saturation-conc5`:** the overload run with `SEARCH_CONCURRENCY=5`, everything else at the defaults.

| run | VUs | think | req/s before -> after | non-2xx before | non-2xx after | Postgres CPU % avg/max before -> after | query CPU % before -> after |
|---|---|---|---|---|---|---|---|
| postfix-vus500-writes5-invalidating | 500 | 2500 ms | 27 -> **175.7** | 119x search 504, 54x profile 504 | 2084x search 503 | 440.7/661.4 -> 696.9/758.1 | 9.3/30 -> 43.7/75.4 |
| postfix-vus200-saturation-conc5 | 200 | 0 ms | 26.1 -> **429.5** | 12x search 504, 70x profile 504 | 3971x search 503 | 410.5/558.7 -> 668.4/804.5 | 6.8/23.4 -> 62.8/90.4 |

### postfix-vus500-writes5-invalidating vs vus500-writes5 (500 VUs, think 2500 ms, 5% writes, 46.4 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 1141 / 5679 | 14359 -> 401.8 | 21793.4 -> **771.5** | 23260.3 -> 995.4 | 838.4 (3595) | FAIL (+472 ms) | 15% -> 1% |
| GET /api/leads/:id | 200 | 308 / 1473 | 16321.7 -> 65.9 | 21965.4 -> **228.2** | 22868.6 -> 366.8 | 228.2 (1473) | FAIL (+28 ms) | 100% -> 58% |
| GET /api/kpis | 500 | 149 / 742 | 6422.8 -> 48.5 | 16676.6 -> **245.3** | 21121.1 -> 406.4 | 245.3 (742) | PASS | - -> - |
| POST /api/leads/:id/(notes|state) | - | 29 / 253 | 56.2 -> 97.8 | 196.7 -> **328.1** | 339.1 -> 463.4 | 328.1 (253) |  | - -> - |

Slowest search shapes after (p95 ms): near_storm 955.1, text 919.2, custom 844.9, years_sort 836.4. Max in flight 465 -> 100.

### postfix-vus200-saturation-conc5 vs vus200-saturation (200 VUs, think 0 ms, 30.3 s)

| endpoint | target p95 | requests before / after | p50 before -> after | p95 before -> after | p99 before -> after | p95 of 2xx only (after) | verdict (after, all responses) | cache hit before -> after |
|---|---|---|---|---|---|---|---|---|
| POST /api/leads/search | 300 | 1119 / 9262 | 8506.5 -> 66.8 | 12397.5 -> **790** | 15002.5 -> 1077.9 | 890.9 (5291) | FAIL (+490 ms) | 32% -> 72% |
| GET /api/leads/:id | 200 | 274 / 2448 | 9778.3 -> 72.3 | 15008.9 -> **190** | 15021.5 -> 381.8 | 190 (2448) | PASS | 99% -> 87% |
| GET /api/kpis | 500 | 182 / 1291 | 8160.3 -> 48.2 | 11174.1 -> **162.6** | 11673.2 -> 340 | 162.6 (1291) | PASS | - -> - |

Slowest search shapes after (p95 ms): unchecked_team 981.4, near_storm 943.1, text 940.4, years_sort 874.5. Max in flight 200 -> 154.


## Cache hit rates

- **List cache (`X-Cache` on search): 43% in every read-only run after, against 17–44% before.**
  - The rate no longer falls with load (before: 44% at 50 VUs, 35% at 200, 17–19% at 500). Before, slow searches meant fewer repeat requests landed within the 60 s TTL.
  - "Warm" makes no difference for lists because entries expire after 60 s. The cold and warm runs replay the same seeded request sequence and get the same counts (2,779 / 2,775 hits at 500 VUs).
  - Shared manager keys (`leads:q:mgr:…`) only help managers, who are about 9% of VUs. Reps' keys stay per user, which caps the rate.
  - With no think time the rate is 81%, because users repeat the same filters within the TTL.
  - **With writes it collapses to 0.3%,** because every write INCRs the global `leads:version`.
- **Profile cache:** 40–63% cold, 92–100% warm. The after runs serve 3–4x more profile requests, so more leads are opened for the first time. With writes it is 58%, because each write bumps a lead's version.
- **Redis degradation:** 0 Redis timeouts in the matrix and in the write re-run, against 842 "Command timed out" in the baseline. The no-think conc-5 run had exactly one, on a GET of `kpi:team`. It was served uncached through the normal read path, as the lead decided, and logged with `degraded: 1`.

## Postgres CPU

- **At 500 VUs, read-only:** 401–507% average, 705–758% peak. Before, it was 426–429%, while serving a quarter of the throughput.
- **With writes and working invalidation:** 697% average, 758% peak, which is saturated.
- **At 200 VUs:** 102–114% average, against 416–418% before. The before runs were burning CPU on years/cert/tag rechecks.
- **At 50 VUs:** both cold runs average about 100%, but the warm run after averages 34%, against 103% before. The 50-VU cold run includes the first-touch reads after synth, and the container also carries the compose stack's background polling.
- **Every shape queues at 500 VUs.** Search p95 is 170–300 ms for every filter shape, including `mine` and `default`, which take 4–9 ms single-user. That is waiting in the limiter's queue (8 slots). Postgres CPU per served search is about 50 ms under 8-way concurrency, against 4–34 ms single-user. The cause is CPU contention, with 128 MB of shared buffers for a 725 MB database. The headroom at the design load is about 60–80 ms of p95.

## Errors

| run | non-2xx after | cause |
|---|---|---|
| vus500-cold / -warm | 121 / 128 × search 503 (`busy`, Retry-After: 1) | Limiter shedding: the queue was full or the 1 s queue wait ran out |
| vus500-warm | 1 × search 500 | Postgres 53100 `could not resize shared memory segment ... No space left on device`. A parallel-query DSM segment did not fit the container's 64 MB `/dev/shm` |
| vus500-writes5 | 48 × search 503 | Limiter shedding |
| vus500-writes5-invalidating | 2,084 × search 503 | Limiter shedding: the list cache is defeated by `leads:version` INCRs |
| vus200-saturation (conc 8 / conc 5) | 3,279 / 3,971 × search 503 | Overload shedding, by design |

- **The matrix's write run is not valid.** `load.mjs --flush-redis` used FLUSHDB, which also deleted the `events` stream and the relay's `cache-invalidation` consumer group. The relay then logged `NOGROUP` every second, 516 times, and never recreated the group. So `leads:version` and the KPI keys were never invalidated during `postfix-vus500-writes5`, and the pre-fix `vus500-writes5` had the same problem. `postfix-vus500-writes5-invalidating` repeats that run with the harness fixed: the flush now deletes only cache keys, the services were restarted, and the consumer group showed lag 0 with 862 entries read.
- Gateway 504s: 0 in every after run.

## Why the remaining targets are missed

1. **Writes defeat the list cache.**
   - Any lead change INCRs `leads:version`, the SystemDesign §5 contract, which makes every cached page unreachable. At 5% writes from 500 users that happens about 4 times a second.
   - Uncached, the 8 search slots serve about 78 searches/s (3,595 in 46 s) with Postgres saturated. The design load needs about 140/s.
   - Possible fixes (contract/design decisions for the lead):
     - Bump the version only for changes that alter list-visible fields or filter membership.
     - Coalesce INCRs to at most one per few seconds; a 60 s TTL already accepts staleness.
     - Cache page ids and versions, then re-hydrate rows whose `version` changed, like the per-manager flag re-read.
     - Per-scope versions.
2. **Little Postgres headroom on this machine.** The read-only design load already uses 5–6 of the container's 8 vCPUs with default memory settings, and the load generator and services share those cores. Production would put searches on the replica(s) with tuned `shared_buffers`. Locally, `SEARCH_CONCURRENCY` trades search shedding for profile latency (8: profile 234.5 ms under overload; 5: 190 ms, but 43% of searches shed).
3. **One query process.** The query service's single Node event loop runs at 80–100% under overload. Scale it horizontally in production.

## Test suites (after the fixes)

| suite | result |
|---|---|
| `npm run typecheck` (root, all 6 workspaces) | clean |
| `npm run test:db` (packages/db on `leadmaker_db_test`) | 20 / 20 passed |
| crm-write on `leadmaker_crm_write_test` | 77 / 77 passed |
| gateway on `leadmaker_gateway_test` | 53 / 53 passed |
| relay on `leadmaker_relay_test` | 25 / 25 passed |
| query on `leadmaker_query_test` | 174 / 174 passed (6 files, including runtime.test.ts) |
| packages/shared `vitest` | 42 passed, 55 skipped |
| packages/shared `filter-equivalence.test.ts` (read-only, `TEST_DATABASE_URL` = the 100k-row `leadmaker_perf`) | 55 / 55 passed |
| `.venv/bin/pytest -q` | 867 passed, 22 deselected |
| `tests/integration_stack/host-stack.sh test` (`leadmaker_e2e`, ports 18080-18083) | 13 / 13 passed |

- Each service's `*_test` database was dropped and re-migrated with dbmate, exactly as its `test:db` script does.
- The suites ran with `TEST_REDIS_URL=redis://localhost:56379/6` instead of the scripts' Redis DBs 13 / 11 / 12 / 14, because 14 was off limits.
- The e2e run used `E2E_REDIS_DB=6` instead of the default 5, for the same reason.

## Harness changes (scripts/perf)

- **`matrix.sh`:** `LABEL_PREFIX` (here `postfix-`), so a re-run no longer overwrites the baseline files.
- **`explain.mjs`:** `--label`, which writes to `results/<label>-explain/`.
- **`load.mjs`:**
  - **Retry-After:** a 429/503 with Retry-After makes that user wait at least that long (max 5 s), like a real client. Previously a shed request was retried at once, which inflated 503 counts in no-think runs.
  - **2xx-only percentiles:** each endpoint has an `ok` block with percentiles over 2xx responses only, so fast 503s can't flatter the p95. `postfix-vus50-cold` ran before this field existed; it had no non-2xx responses.
  - **Cache-only flush:** `--flush-redis` deletes only the `lead:*`, `leads:*` and `kpi:*` keys instead of FLUSHDB, so the relay's stream and consumer group survive.
- **`services.sh`:** comment only. The fixers' environment variables pass through.
