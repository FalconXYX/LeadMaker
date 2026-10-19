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

Final run on 2026-10-18: `leadmaker validate` 34 pass / 2 warn / 0 fail; live source checks 11/11; 810 offline tests.

| Item | Status | Notes |
|---|---|---|
| GAF listing scrape (Coveo search API), any US ZIP + radius | Built | `leadmaker/sources/gaf/`; 424 contractors for 10013 / 25 mi; second read complete (424/424, 0 changed) |
| GAF profile pages (legal name, years, employees, reviews) | Built | 424/424 fetched |
| Scheduled and on-demand runs (job queue, schedules, worker) | Built | `leadmaker/jobs.py`; schedules and rep requests merge per area; tested offline, no schedules set up in the real DB |
| Reps and managers trigger territory refreshes (merged per area, rate-limited per user) | Built | `jobs enqueue --requested-by`; 20 per rep per hour (`LEADMAKER_USER_JOBS_PER_HOUR`) |
| Run completeness guard (no delisting after a cut-short read) | Built | Run marked partial, delisting skipped; validated by replaying the real area |
| Duplicate-job guard under many workers | Built | Partial unique index on open jobs + race-safe enqueue, retry and schedule firing |
| Incremental updates (content hash, input hash, TTLs) | Built | Profiles 7 days, enrichments 30 days; quota skips never replace a good result |
| Pipeline audit log with field-level diffs | Built | `audit_events`, incl. removed contacts; added after the first GAF scrape, so original listing/profile events are missing |
| Per-host rate limiting and retries | Built | `leadmaker/http.py`; per worker process |
| NY corporations, NYC licences, FMCSA, OpenStreetMap | Built | 159 / 92 / 95 / 10 matches. Audited precision: NY DOS 25/25, NYC DCWP 25/25, FMCSA 23/25 before fixes (both errors and 4 more found by tests are now rejected) |
| BBB names and titles (prototype scraping) | Built | 161 matches (38%), 141 named people. Audited: matches 30/30, people 25/25. Licence numbers count as evidence |
| BBB API | Designed | Production replacement for scraping |
| Website discovery, crawl and web signals | Built | 239 leads with a website; crawl 220 ok; web signals 188 ok. Audited websites 30/30 |
| Google Places | Built | Keyless mode only (Maps link); full data needs `GOOGLE_MAPS_API_KEY` |
| Size-aware target contact with owner fallback | Built | 210 leads with an identified decision-maker (up from 127). Audited target contacts 29/29 |
| System tags, segment, 0–100 priority score with reasons | Built | strategic 106 · growth 122 · emerging 64 · long tail 132 |
| Material and work-type tags | Built | TPO 66, new construction 40, storm/emergency 143. Audited: TPO 19/19, single-ply 20/20, new construction 13/17 before fixes (all 4 errors fixed), storm 14/15 (fixed). Service tags cite the page snippet they came from |
| Rule-based tags from a JSON file | Built | `leadmaker/custom_tags.py`; separate from rep-created custom tags |
| CRM customer-list import (prospect / existing / lapsed / do not contact) | Built | `leadmaker/accounts.py`; stable ids and upsert on `--append`; no real customer list imported yet |
| Weather/storm signals (NWS alerts + county storm history) | Built | 17 counties; 43 alerts in 7 days; 582 storm events in 24 months; warning polygons stored |
| Local news feeds | Built | GDELT + local RSS; 27 rows; coverage is thin for NJ counties |
| Provider-agnostic LLM layer + LLM extraction | Built | Gemini (demo) / Claude (production) / OpenAI-compatible; never run live: needs `GEMINI_API_KEY` |
| Info slots that guide LLM extraction | Built | Experimental; `LEADMAKER_EXTRACTION_SLOTS`; not run live |
| LLM rate limits | Built | Client-side RPM/RPD budget + 429 backoff; Batches API job kind not built |
| AI summaries triggered by the pipeline | Built | Section 4: scrape, tag and pipeline jobs queue `insights` for the area they touched (only when a provider is configured), and refreshes and `signals` queue the territory briefing; merged per area by dedupe keys. crm-write queues `insights` for one lead 60 s after an edit that changes its inputs (merged per lead) |
| Hunter.io email discovery | Later | |
| Shared rate limiter across many workers (Redis token bucket) | Designed | |

## Section 2: Backend Storage & Retrieval

Final run on 2026-10-18: 631 TypeScript tests, 890 offline + 15 Postgres Python tests, 28/28 cross-service scenarios through the gateway on a stack built from empty volumes.

| Item | Status | Notes |
|---|---|---|
| Postgres 16 + PostGIS + JSONB, one migration runner | Built | dbmate, plain SQL in `db/migrations/` (9 files, all round-trip up/down); Prisma client generated from the migrated DB |
| Internal company ID + `company_source_ids` | Built | UUIDs; GAF ids are a source mapping |
| Python pipeline rewritten onto the new schema | Built | Writes scraped values only, plus audit, timeline rows and outbox events in the same transaction; `leadmaker import-sqlite` loads Section 1 data (parity check 38/38, idempotent) |
| Users and roles, allocations with history, per-rep state, overrides, contacts, custom tags and fields, insights, regional signals, activity log, outbox | Built | `company_insights` is written by Section 4 |
| API Gateway & Auth | Built | JWT dev login for the demo users, role re-read every 30 s, per-user Redis token bucket, spoofed identity headers stripped, SSE filtered by visibility |
| Query & Filter service | Built | `LeadFilter` compiled to one parameterised SQL query, keyset pagination, totals capped at 1,000; profiles with effective values, edit badges and "source changed since your edit"; KPIs, weather/news, custom tag and field catalogs, activity paging, allocation suggestions |
| Core CRM Write service | Built | Notes, calls/emails/visits, checked/serviced, overrides with optimistic locking (409 with who/when), rep-added contacts, custom tags and fields, allocations and bulk allocation by filter, refresh requests (merged per area, 20 per user per hour) |
| One visibility rule on every read and write path | Built | Reps act on their leads and view the pool; reassigned leads return 404 to the old rep |
| Outbox relay + Redis Streams + live updates (SSE) | Built | At-least-once with idempotent consumers; recovers if Redis loses the stream |
| Redis caching | Built | Profiles per version, lead lists per rep/pool/all version (gzipped), KPIs, signals |
| Team KPI materialized view | Built | Refreshed about 2 s after allocations and state changes, every 5 min, and after pipeline runs; rep KPIs are live counts |
| Refresh → tags + county | Built | A rep's refresh also tags the new leads and assigns counties (ZIP-based) in the same job |
| In-app notifications | Built | Notifier service: allocated, reassigned, source changed, manager note, refresh done, new leads in the pool, storm alerts; merged repeats, preferences, live over SSE |
| Push and email notifications | Designed | Needs the web app's service worker and an email provider |
| Performance at 100k leads (synthetic) | Built | 500 users read-only: search p95 199–301 ms, profile 82–109 ms, KPIs 82–120 ms at about 200 req/s. With 5% writes: search p95 260–326 ms (target 300; at the limit on a loaded laptop), profile 99–141 ms. Details in `docs/Performance.md`. Harness and results in `scripts/perf/` |
| Search pools, admission control, timeouts | Built | Separate search pool with a concurrency limit and 2 s statement timeout, so profiles and KPIs stay fast under search load |
| Read replica | Built | A local streaming hot standby (`postgres-replica`); the query service reads from it and routes a user's reads to the primary for 5 s after their own write |
| More replicas, PgBouncer | Designed | Statement timeouts become per-role settings behind PgBouncer |
| SSO (OIDC), row-level security, backups with point-in-time recovery | Designed | |
| Saved views and per-user UI preferences | Built | `/api/views` (managers can share a view with the team) and `/api/preferences` with optimistic locking |
| Bulk endpoints and limits | Built | Bulk tag attach, bulk unassign, tag rename/delete, facet counts, map points; limits served by `/api/config` |
| Geographic partitioning | Later | |
| SQLite DB in the repo as the demo seed | Later | `data/` and `research/` stay out of git; the demo ships as a Postgres snapshot in `db/snapshot/` |

## Section 3: Frontend

| Item | Status | Notes |
|---|---|---|
React + Vite + TypeScript app in `apps/web/` (standalone package; 217 tests). Served by the `web` container at http://localhost:3000; `npm run dev` in `apps/web` serves it on :5173.

| Item | Status | Notes |
|---|---|---|
| Territory dashboard (KPIs, map, weather, briefing) | Built | KPI tiles link to filtered lists; map fitted to the user's leads; weather/news with demand impact; deterministic "act on today" briefing; team table for managers |
| Lead list (priority sort, ranking reasons, tag toggles, My / Unallocated switch) | Built | Every `LeadFilter` facet with counts, removable chips, saved views (shareable by managers), per-user display prefs synced to the server, bulk tagging, keyboard navigation |
| Lead profile (contacts, overrides, insights, notes, weather) | Built | Edited / "source changed since your edit" badges, inline edits with a conflict dialog, size-based target contact, rep-added contacts, timeline including pipeline changes, live updates from other users |
| Manager allocation view (queue, bulk assign, suggestions) | Built | Team load, bulk and by-filter assignment with before/after load and Undo, county/ZIP suggestions to approve |
| Notifications bell | Built | Unread badge, live toasts, mark read, per-type preferences |
| Floating AI assistant | Built | Chat drawer, context-aware prompts (the pitch prompt follows the lead's storm data), filter-applying cards with Undo and the match count; connected to the Section 4 assistant service; progress lines while it works; status line shows setup, quota (with the reset day in ET) and offline states, and a spent quota closes the message box; errors that a retry can't fix have no Try again; "." opens it |
| "Changed since last poll" badges | Built | Driven by `updated_in_last_poll`; the "what changed" line needs a second pipeline run to have data |
| Login | Demo | One-click demo users (`DEMO_MODE=1`); production uses OIDC |

## Section 4: AI Tools & Insights

| Item | Status | Notes |
|---|---|---|
| Batch business summaries and sales pitches (stable layer) | Built | `leadmaker/insights/` and the `insights` job: a summary, one pitch line with its product focus, talking points, the person to ask for and the cited facts, from every fact (GAF data, website text as `W1`, size, tags, rep notes, custom fields). Prompt `insights/v2`: third-person pitch led by what sets the lead apart, no promises about the distributor. Regenerated only when `input_hash` (facts + prompt version + model) changes; crm-write queues a lead 60 s after a note, call, override, custom field or tag, or stage change. One prompt holds one rep's leads (or pool leads) only, and an item that repeats another lead's private notes is rejected. Guards reject invented certifications, contacts, URLs, weather, season and urgency words, "you" in the pitch, and distributor terms no fact grounds (one retry); a role-only contact and extra product lines are repaired without a call. Demo (2026-10-19, `gemini-3.5-flash-lite`): 419 of 424 leads have an insight; 156 on v2 (146 of the 150 allocated), the pool keeps v1 until the next run. On v2 rows "your" in pitches went from 270/409 to 0 and "upcoming" from 114 to 0 |
| Weather timing layer (rules per county, no per-lead LLM calls) | Built | Badges in export; warnings tested per address against the NWS polygon; "high" only with a storm report. Audited 26/26. Weather is not an insight input, so it never triggers an LLM rerun |
| Lead Q&A scoped to one lead | Built | `services/assistant` (port 8085 in compose; `/api/assistant/*` behind the gateway): the open lead's context comes from query's `/leads/:id/ai-context` as the asking user (404 for a lead they can't see; contact emails and phones are never sent to the model). Answers cite sections as "Sources" chips and correct a premise the timing data contradicts. Every read uses the user's permissions. Demo model `gemini-3.5-flash-lite` (1.4-2.7 s live) with `gemini-3.8-flash` as fallback when its day is spent; each user gets a quarter of the day's model calls; usage is charged even when the client disconnects. The drawer shows progress ("Searching your leads…") and closes the message box with the reset time when every model's day is spent |
| Natural-language filtering via `LeadFilter` tool call | Built | The `applyListFilters` tool emits the shared `LeadFilter`; the drawer applies it to the list with Undo, and the card shows the match count with the list's own chip labels. One LLM call. A rep's filter that matches none of their own leads widens to "Mine + unallocated" and says so ("Roofers in Brooklyn": 14). Read-only tools: `findLeads`, `openLead`, and `todaysCalls` for "who should I call first", in the dashboard's order (live: 4 overdue, 9 due today, matching Today's calls) |
| Territory briefing (digest + cached AI rewrite) | Built | `leadmaker/briefing/` and `GET /api/territory-brief`: a hashed deterministic digest (last poll's changes, roofing-relevant alerts, storm-response leads, storm-restoration roofers in counties with NOAA storm reports in the last 30 days, the new pool), plus an AI rewrite (`briefing/v2`) cached per hash. The prompt sees only what the text kept; the validator holds every number to what it counts and every county, alert and company name to the digest, and a rejected rewrite is cached as an empty marker so it costs one call. One muted line in the dashboard header (expandable on phones). Demo: non-quiet for the team and all 3 reps (4 rewrites, 0 rejected) |
| Provider-agnostic model layer (Anthropic, Gemini, ...) chosen by config | Built | Python `leadmaker/llm/` and TS `services/assistant/src/llm/`: Gemini, Anthropic, OpenAI-compatible and a deterministic fake, chosen by env, with per-model daily budgets and fallback models for the assistant (`LEADMAKER_ASSISTANT_FALLBACK_MODELS`). Gemini free tier runs live in the demo; the Claude and OpenAI paths are unit-tested with fixtures only (paid providers default to a 5,000-call daily ceiling) |
| AI evaluation set | Built | `evals/`: 53 NL-filter, 29 lead Q&A and 19 insights cases with an assertion DSL (now with `todaysCalls` and `matchCountMin`) and contract checks (stream shape, scope, citations, no keys); insights rubric R1-R11 (R10 distributor promises, R11 third person). Offline (`npm run eval:offline`, fake provider): asserted cases 30/30, 18/18 and 18/18. Live on `gemini-3.5-flash-lite` (2026-10-19, 18 calls): NL filter 8/8, lead Q&A 6/6, insights 10/11 (the guards rejected a retry that said "upcoming", so one lead got no insight); contract checks passed on every case |

## Deployment & Testing

| Item | Status | Notes |
|---|---|---|
| Local stack seeded from `data/leadmaker.db` | Built | `docker compose --profile app up -d --build` (or `npm run stack:up`): migrations, a copy-based import, seed, then the services and the worker. Plain `docker compose up` starts only Postgres, Redis and migrations |
| Hosted deployment (containers, managed Postgres/Redis, secrets manager) | Designed | Every service is a container; demo secrets and `DEMO_MODE=1` are for local use only |
| Offline tests for the pipeline | Built | 1,168 tests (Section 1 acceptance, end-to-end CLI, unit, schema drift, Section 4 insights and briefing on the fake provider); `pytest -q`; `pytest -m pg` runs 22 against Postgres; `tests/` not in git yet |
| Service tests | Built | 996 vitest tests across 8 packages (including the assistant), each against its own test database; 384 web tests |
| Cross-service scenarios through the gateway | Built | 43 scenarios (visibility, writes, conflicts, pipeline re-scrape keeps overrides, live events, allocation, refresh limits, notifications, role changes; Section 4: assistant SSE, filter previews per user, Q&A refusing other reps' leads, rate and quota limits, batch insights reaching the profile over SSE, a note queuing an insights refresh, the territory brief and its scope rules) on the fake LLM provider; `npm run test:stack` builds a private stack from empty volumes |
| Data validation command | Built | `leadmaker validate` (integrity, run health, freshness, provenance, tagging, audit, signals, consistency); works on Postgres |
| Import parity check | Built | `scripts/import_parity.py` compares a Section 1 SQLite file with the Postgres import |
| Live source drift checks | Built | `pytest -m live` (11 checks, ~25 requests) |

## Known Issues

- 9 leads have sources that name different website domains (possibly sister brands or BBB listings); 54 of 256 leads with a source phone don't match GAF's phone (often tracking numbers).
- The weather API's robots.txt disallows crawlers; the pipeline uses its documented public API (2 requests per run). Set `LEADMAKER_CONTACT` to a contact address, as NWS asks.
- Partial-county forecast-zone alerts (no polygon) still count county-wide.
- `leadmaker/enrich/fmcsa_census.py` is an unused duplicate of `fmcsa.py` (still covered by 7 tests).
- Counties come from the lead's ZIP (Census ZCTA file), not PostGIS point-in-polygon; weather badges still check NWS warning polygons per address.
- GAF attributes are stored in typed company columns (tier, certifications, rating), not the generic `scraped_attributes` JSONB, which nothing writes yet.
- Login is demo-only (`POST /auth/dev-login`); there is no API to add users or change roles.
- Gemini free-tier quotas are per model and small: `gemini-3.8-flash` allows 20 requests a day per project (measured 2026-10-19). The worker and the assistant now default to `gemini-3.5-flash-lite` (no 429 after about 170 calls that day; its real limit is unknown), capped client-side at 150 and 100 a day, and share its Google quota; the assistant falls back to `gemini-3.8-flash` when its day is spent.
- The first `insights/v2` run spent 42 calls on 160 leads (23 batches plus 19 retries): the stricter guards send more items back once. 259 pool leads (and 4 allocated leads whose v2 answer the guards rejected) still show their v1 insight until the next run (`leadmaker jobs enqueue insights --zip 10013 --radius 25`, or `LEADMAKER_AI_SCHEDULES=1`).
- The distributor-terms guard grounds a term anywhere in the lead's facts, not in the claim's own cited fact, so "our shingle pricing" passes when any note mentions pricing.
- Any `tag` job recomputes `account_status` from the `accounts` table, which the demo seed leaves empty, so the 10 seeded customers and 5 lapsed customers become prospects again (and their insights regenerate). Seed matching `accounts` rows or import a customer list before refreshing the demo data.
- `INTERNAL_TOKEN` defaults to a public value in compose; the assistant logs a warning under `NODE_ENV=production`, but the services do not refuse to start, and any container on the compose network can reach query and the assistant with it.
