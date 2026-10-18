# Build Checklist

**Status key**

| Status | Meaning |
|---|---|
| **Built** | In the code; run on the real 10013 data unless the note says otherwise. Section 1 items are covered by tests; tests for everything else come at the end |
| **Demo** | To build for the prototype |
| **Designed** | Production design only; documented, not built |
| **Later** | Parked for now |
| **Undecided** | Needs a decision |

## Section 1: Data Acquisition & Tagging

| Item | Status | Notes |
|---|---|---|
| GAF listing scrape (Coveo search API), any US ZIP + radius | Built | `leadmaker/sources/gaf/`; 424 contractors for 10013 / 25 mi |
| GAF profile pages (legal name, years, employees, reviews) | Built | 424/424 fetched |
| Scheduled and on-demand runs (job queue, schedules, worker) | Built | `leadmaker/jobs.py`; `leadmaker run`, `jobs enqueue`, `schedule add`, `worker`. Tested offline; no schedules set up in the real DB yet |
| Incremental updates (content hash, input hash, TTLs) | Built | Profiles 7 days, enrichments 30 days |
| Pipeline audit log with field-level diffs | Built | `audit_events`; added after the first GAF scrape, so the existing contractors have no listing/profile change events yet. User actions come with `activity_logs` (Section 2) |
| Per-host rate limiting and retries | Built | `leadmaker/http.py`; per worker process |
| NY corporations, NYC licences, FMCSA, OpenStreetMap | Built | `ny_dos`, `nyc_dcwp`, `fmcsa`, `osm` |
| Website discovery, crawl and web signals | Built | `website_discovery`, `website_crawl`, `web_signals` |
| Google Places | Built | Keyless mode only (Maps link); full data needs `GOOGLE_MAPS_API_KEY` |
| System tags, segment, 0–100 priority score with reasons | Built | `leadmaker/tagging/` |
| Material and work-type tags: metal, shingle, flat, slate, tile, storm/emergency | Built | From the website crawl |
| TPO and new-construction tags | Demo | Not tagged yet |
| Rule-based tags from a JSON file | Built | `leadmaker/custom_tags.py`; separate from rep-created custom tags |
| CRM customer-list import (prospect / existing / lapsed / do not contact) | Built | `leadmaker/accounts.py`; no real customer list imported yet |
| LLM extraction from website text | Demo | `llm_extract` is written but has never run (needs `ANTHROPIC_API_KEY` and `uv pip install -e '.[llm]'`) |
| AI summaries triggered by the pipeline | Demo | Section 4 |
| Size-aware decision-maker with owner fallback | Demo | Contact choice ignores company size today |
| BBB names and titles (prototype scraping) | Demo | Matcher exists in `research/reviews_directories/`; not in the pipeline |
| BBB API | Designed | Production replacement for scraping |
| Hunter.io email discovery | Later | |
| Weather/storm signals (NWS alerts + county storm history) | Demo | Storm history is in `research/market_demand/`; not in the pipeline |
| Local news feeds | Demo | Source not chosen yet |
| Info slots that guide LLM extraction | Demo | Experimental; drop if extraction quality is poor |
| Reps and managers trigger territory refreshes (merged per area, rate-limited per user) | Demo | Queue already rejects duplicate jobs; no per-user rate limit yet |
| Run completeness guard (don't mark leads delisted after a cut-short read) | Demo | Bug: an empty or cut-short GAF read logs every missing lead as delisted (all of them if empty), and the run still reports succeeded |
| Duplicate-job guard under many workers (unique index on open jobs) | Demo | Today duplicate rejection is check-then-insert, so two workers can enqueue the same scheduled job on Postgres |
| LLM rate limits through the queue (Batches API job) | Demo | `llm_extract` already builds batch requests and parses results (`batch_request`, `result_from_message`); no batch job kind or runner yet |
| Shared rate limiter across many workers (Redis token bucket) | Designed | |

## Section 2: Backend Storage & Retrieval

| Item | Status | Notes |
|---|---|---|
| JSONB columns + GIN index on tags | Built | Verified on Postgres 16 with all 424 leads copied over; SQLite still used locally |
| SQLite DB in the repo as the demo seed | Later | `data/`, `research/` and `tests/` stay out of git until they settle down |
| Postgres + PostGIS as the main database (docker compose) | Demo | |
| Internal company ID + `company_source_ids` | Demo | Today every table is keyed on the GAF contractor ID |
| Users and roles, allocations, per-rep state, overrides, custom tags, insights, regional signals, activity log, outbox | Demo | Schema in `SystemDesign.md` §5 |
| Gateway + RBAC, CRM Write, Query & Filter, AI services (TypeScript) | Demo | |
| `LeadFilter` schema + one visibility rule on every read path | Demo | |
| Redis cache + outbox relay + live updates (SSE) | Demo | |
| Optimistic locking on shared fields | Demo | |
| Team KPI materialized view | Demo | |
| Per-user API rate limits | Demo | |
| Read replicas, PgBouncer, read-your-writes routing | Designed | Local setup runs one primary |
| SSO (OIDC), row-level security, backups with point-in-time recovery | Designed | |
| Geographic partitioning | Later | |

## Section 3: Frontend

| Item | Status | Notes |
|---|---|---|
| Territory dashboard (KPIs, map, weather, briefing) | Demo | |
| Lead list (priority sort, ranking reasons, tag toggles, My / Unallocated switch) | Demo | |
| Lead profile (contacts, overrides, insights, notes, weather) | Demo | |
| Manager allocation view (queue, bulk assign, suggestions) | Demo | |
| Floating AI assistant | Demo | |
| "Changed since last poll" badges | Demo | Needs a second pipeline run to have data |

## Section 4: AI Tools & Insights

| Item | Status | Notes |
|---|---|---|
| Batch business summaries and sales pitches (stable layer) | Demo | `llm_extract` emits a short website-based summary; the summary and pitch from all facts (`company_insights`) are not built |
| Weather timing layer (rules per county, no per-lead LLM calls) | Demo | |
| Lead Q&A scoped to one lead | Demo | |
| Natural-language filtering via `LeadFilter` tool call | Demo | |
| Territory briefing (digest + cached AI rewrite) | Demo | |
| Provider-agnostic model layer (Anthropic, Gemini, ...) chosen by config | Demo | `llm_extract` calls Anthropic directly today |
| AI evaluation set | Demo | Built last, with testing |

## Deployment & Testing

| Item | Status | Notes |
|---|---|---|
| `docker compose up` local stack seeded from `data/leadmaker.db` | Demo | |
| Hosted deployment (containers, managed Postgres/Redis, secrets manager) | Designed | |
| 192 offline tests for Section 1 | Built | `pytest -q`; `tests/` is not in git yet |
| Visibility, override-survival and smoke tests | Demo | Built last |

## Known Issues

- Website-only contact names can be template text (e.g. "Thomas Smith, Founder & CEO" on one site).
- 32 web-signal lookups timed out (archive.org rate limits); they retry on the next run.
- `leadmaker/enrich/fmcsa_census.py` is an unused duplicate of `fmcsa.py`. It still has 7 tests in `tests/test_enrich_fmcsa_census.py`; removing both leaves 185 tests.
