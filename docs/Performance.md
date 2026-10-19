# Performance and numbers

**Highlights**
- At 100k leads and about 200 req/s, search p95 dropped from about 9.6 s to 199-301 ms after tuning (target 300 ms).
- 2,836 automated tests pass, including 43 end-to-end scenarios on a stack built from empty volumes.
- The AI eval set (102 cases) passes offline, and 24 of 25 live cases pass on Gemini 3.5 Flash-Lite.
- Assistant answers take 1.4-2.9 s, down from 12-47 s before the model switch.

## Load test at 100k leads

The tests ran on one laptop in Docker: 8 vCPUs, default Postgres memory settings, and a single Postgres primary. The read replica was added later and isn't in these numbers. `scripts/perf/synth.mjs` fills a separate database with 100,000 synthetic companies and 2,200 users. `scripts/perf/matrix.sh` then runs 500 virtual users with a 2.5 s think time, about 200 req/s, which is the design load. Values are p95 in milliseconds. The run summary and query plans are in `scripts/perf/results/`.

| Run | Search | Profile | KPIs | req/s |
|---|---|---|---|---|
| Read-only, before tuning | 9,613 | 14,403 | 8,994 | 49 |
| Read-only, after tuning (4 runs) | 199-301 | 82-109 | 82-120 | 198-200 |
| 5% writes, before tuning | 21,793 | 21,965 | 16,677 | 27 |
| 5% writes, after tuning (3 runs) | 260-326 | 99-141 | 90-148 | 194-197 |

Three changes did most of the work:
- **Indexed generated columns** for tags and founding year. Single-user search queries went from up to 1,074 ms to at most 34 ms.
- **A search limiter.** 8 searches run at once, up to 32 more wait at most 1 s, and anything beyond that gets a fast "try again" instead of piling up.
- **List caches invalidated only for the scopes a write touches.**

Runs vary on a shared laptop, and write-heavy runs sit right at the 300 ms target. One known slow spot remains: a manager's facet counts across all 100k leads take about 8 s and time out. The 424-lead demo isn't affected.

## Tests, AI and data

| Area | Result |
|---|---|
| Automated tests | 2,836 passed, 0 failed: services, pipeline, web, evals and 43 end-to-end scenarios |
| AI evals, offline (fake model) | 102 of 102: filters 53/53, lead Q&A 29/29, insights 20/20 |
| AI evals, live (Gemini 3.5 Flash-Lite) | 24 of 25 (filters 8/8, Q&A 6/6, insights 10/11) |
| Assistant response time | 1.4-2.9 s |
| Per-lead AI Refresh | 3.5-23 s from click to updated text |
| AI guardrails | Unsupported "distributor promise" claims fell from 42% of insights to 12% after the guard was added; the remainder are backed by rep notes |
| Demo data | 424 leads, 418 with AI insights, 119 weather and news signals, 3 MB database snapshot |

All numbers are local measurements: one laptop, shared CPU, and short 30-60 s load runs. AI calls use Gemini's free tier, so the batch insights for all leads are spread across nightly runs rather than generated at once.
