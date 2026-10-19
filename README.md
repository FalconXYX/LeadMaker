# LeadMaker

GAF contractor lead pipeline: scrape, enrich and tag roofing contractors around a ZIP code, served to reps and managers through a set of TypeScript services.

## Run the stack (Docker)

```bash
cp .env.example .env                              # optional; every value has a working local default
docker compose --profile app up -d --build        # or: npm run stack:up
```

This applies the migrations, imports a copy of `data/leadmaker.db`, seeds the demo users (50 leads each for three reps), then starts the gateway on http://localhost:8080, the services and the pipeline worker. Plain `docker compose up -d` starts only Postgres, Redis and the migrations.

Demo login (only when `DEMO_MODE=1`):

```bash
curl -s localhost:8080/auth/dev-login -H 'content-type: application/json' -d '{"email":"rep1@demo.local"}'
# users: manager@demo.local, rep1@demo.local, rep2@demo.local, rep3@demo.local
```

Tests and tools:

```bash
npm install
npm run typecheck
npm run test:db                     # packages/db; each workspace also has `npm run test:db -w <name>`
npm run test:stack                  # cross-service scenarios on a private stack built from empty volumes
npm run db:migrate | db:status | db:rollback | db:psql
.venv/bin/pytest -q                 # pipeline (offline); -m pg runs against the compose Postgres
.venv/bin/python scripts/import_parity.py <section1.db> <postgres-url>
node scripts/perf/synth.mjs && sh scripts/perf/matrix.sh   # 100k-lead load test (see scripts/perf/)
```

## AI tools (Section 4)

With `GEMINI_API_KEY` in `.env` (or another provider, see Configuration), the stack adds:

- **Batch insights**: a summary, one pitch line (with its product focus), talking points and the person to ask for, built from every fact about a lead (GAF data, website text, size, tags, notes, custom fields) and shown on the profile. A lead is regenerated only when its `input_hash` (inputs + prompt version + model) changes; weather never triggers a rerun. Refresh jobs queue them for the area they touched, and crm-write queues one for a lead 60 s after a note, call, override, custom field or tag, or stage change. Guards reject invented certifications, contacts, URLs, weather talk and promises about the distributor; one prompt never mixes two reps' leads.
- **Territory briefing**: a deterministic digest of the last data poll, the weather alerts and the last 30 days of storm reports, with a cached AI rewrite that may only reuse the digest's numbers, places and names, shown as one line on the dashboard (nothing when there is nothing to say).
- **Assistant** (`services/assistant`, port 8085 inside the compose network; the browser reaches it through the gateway at `/api/assistant/*`, and the floating drawer is the UI): Q&A about the open lead, natural-language list filtering through the `applyListFilters` tool, and "who should I call first" through the read-only `todaysCalls` tool (overdue and due-today follow-ups first, like the dashboard). Every read goes through the query service as the asking user.

```bash
docker compose exec worker leadmaker insights --dry-run              # what would regenerate, and the call estimate (no calls)
docker compose exec worker leadmaker insights --limit 20            # generate now (allocated leads first)
docker compose exec worker leadmaker insights --stale                # only leads whose notes/fields/website changed
docker compose exec worker leadmaker insights show --company <id>    # the latest insight row of one lead
docker compose exec worker leadmaker jobs enqueue insights --zip 10013 --radius 25   # as a background job
docker compose exec worker leadmaker briefing --print                # territory digests (+ AI rewrite)
docker compose exec worker leadmaker briefing --no-ai --print        # digests only, no model call
docker compose exec worker leadmaker jobs list                       # job status and results
```

AI evaluation set (`evals/`, see `evals/README.md`):

```bash
npm run eval:offline                                           # every case on the fake provider: 0 model calls (CI)
node evals/assistant/run.ts --live --dry-run                   # the live plan and call estimate (no provider, no key read)
.venv/bin/python -m evals.insights.run --live --dry-run
npm run eval:live                                              # NL filter, lead Q&A and insights against the model in .env
node --env-file-if-exists=.env evals/assistant/run.ts --live --suite nl_filter --limit 5 --max-calls 6   # a smaller run
node evals/assistant/run.ts --via-gateway http://localhost:8080   # nl_filter end to end through the running stack (uses its model)
```

Live runs are capped (`--max-calls`; by default at most 9 NL-filter, 6 lead Q&A and 3 insights calls) and write reports to `data/evals/` (`--out` to change it). Providers other than Gemini and the fake are refused without `--allow-provider`, because they are paid APIs.

Gemini free-tier quotas are per model (`gemini-3.8-flash`: 20 requests a day per project, measured 2026-10-19). By default the worker and the assistant run on `gemini-3.5-flash-lite`, whose free day is much larger (no limit hit after about 170 calls); the worker stops at 150 calls a day and resumes on its next run, and the assistant stops at 100 and then answers with its fallback, `gemini-3.8-flash` (20). Each user gets a quarter of the assistant's day, so one person can't spend the team's. When every model's day is spent the drawer says when AI answers come back and closes the message box; lists, filters and profiles keep working. Keep the worker's model stable: changing it regenerates every insight. AI schedules are opt-in (`LEADMAKER_AI_SCHEDULES=1`). Every automated test uses the deterministic `fake` provider.

## Pipeline setup

```bash
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -e ".[dev]"
```

## Run

```bash
.venv/bin/leadmaker scrape --zip 10013 --radius 25   # GAF listing + profile pages
.venv/bin/leadmaker enrich                            # all enabled secondary sources
.venv/bin/leadmaker tag                               # tags / segment / priority score
.venv/bin/leadmaker signals                           # county weather alerts, storm history, local news
.venv/bin/leadmaker run --zip 10013 --radius 25       # scrape + enrich + tag in one go
.venv/bin/leadmaker export --format csv --out data/leads.csv
.venv/bin/leadmaker stats                             # what's in the DB
.venv/bin/leadmaker sources                           # which enrichers are enabled and why
.venv/bin/pytest -q                                   # offline test suite
```

Scheduling, queueing, CRM accounts and audit:

```bash
.venv/bin/leadmaker schedule add --name nyc-daily --kind pipeline --zip 10013 --every-hours 24
.venv/bin/leadmaker jobs enqueue scrape --zip 10013 --also-zip 07030   # on-demand; duplicate jobs are rejected
.venv/bin/leadmaker jobs enqueue scrape --zip 07030 --requested-by <user-uuid>  # rep-triggered; 20 per user per hour
.venv/bin/leadmaker import-sqlite data/leadmaker.db                    # load a Section 1 SQLite file into Postgres
.venv/bin/leadmaker worker                                             # runs queued + scheduled jobs
.venv/bin/leadmaker accounts import crm_export.csv                     # existing / lapsed / prospect tagging
.venv/bin/leadmaker tag --rules examples/tag_rules.example.json        # user-defined tags + priority boosts
.venv/bin/leadmaker audit --gaf-id 1136285                             # field-level change history
```

## Configuration

All environment variables are optional.

| Variable | Effect |
|---|---|
| `LEADMAKER_DATABASE_URL` | The pipeline's database. Defaults to `sqlite:///data/leadmaker.db`; set `postgresql+psycopg://leadmaker:leadmaker@localhost:55432/leadmaker` for the compose Postgres. A `postgres://` `DATABASE_URL` (the services' form) is ignored by the pipeline. |
| `GOOGLE_MAPS_API_KEY` | Enables Google Places enrichment and Google geocoding of the search origin. |
| `GEMINI_API_KEY` | Enables LLM extraction on the Gemini API (free tier for the demo). |
| `ANTHROPIC_API_KEY` | Enables LLM extraction on Claude (production). |
| `LEADMAKER_LLM_PROVIDER`, `LEADMAKER_LLM_MODEL`, `LEADMAKER_LLM_BASE_URL`, `LEADMAKER_LLM_RPM`, `LEADMAKER_LLM_RPD` | Choose the LLM provider and model, point at an OpenAI-compatible server, and set client-side rate limits. |
| `LEADMAKER_WORKER_LLM_MODEL`, `LEADMAKER_WORKER_LLM_RPD` | Compose only: the worker's model and daily cap for batch insights and briefings (default: `LEADMAKER_LLM_MODEL`, else the provider's batch default, `gemini-3.5-flash-lite` for Gemini; 150). |
| `LEADMAKER_INSIGHTS_BATCH_SIZE`, `LEADMAKER_INSIGHTS_ON_REFRESH`, `LEADMAKER_AI_SCHEDULES`, `LEADMAKER_BRIEFING_AI` | Leads per insights call (compose 5), queue insights after refreshes (1), the opt-in 15-minute stale-insights and hourly briefing schedules (0), and the briefing's AI rewrite (1). |
| `LEADMAKER_ASSISTANT_LLM_PROVIDER`, `LEADMAKER_ASSISTANT_LLM_MODEL`, `LEADMAKER_ASSISTANT_RPM`, `LEADMAKER_ASSISTANT_RPD` | The assistant's own provider/model and global budget of that model (Gemini: `gemini-3.5-flash-lite`, 8 a minute, 100 a day; Claude and OpenAI-compatible: 120 a minute, 5,000 a day as a cost ceiling). |
| `LEADMAKER_ASSISTANT_FALLBACK_MODELS` | Models of the same provider tried in order when the primary's day is spent, as `model[:requests per day]` (Gemini default `gemini-3.8-flash:20`; `none` turns them off). |
| `ASSISTANT_USER_LLM_CALLS_PER_DAY` | Model calls one user may make a day (default: a quarter of the assistant's daily budget, at least 6; the service warns at startup if one user could spend it all). |
| `ASSISTANT_USER_PER_MINUTE`, `ASSISTANT_USER_PER_DAY`, `ASSISTANT_PROVIDER_TIMEOUT_MS`, `ASSISTANT_REQUEST_TIMEOUT_MS` | Per-user assistant limits (6 a minute, 150 questions a day) and timeouts (compose: 70 s per model call, 80 s per request). |
| `LEADMAKER_INSIGHTS_ON_EDIT`, `LEADMAKER_INSIGHTS_EDIT_DELAY_SECONDS` | crm-write: queue an insights job for a lead when an edit changes its AI inputs (compose: on, after 60 s, merged per lead). |
| `LEADMAKER_EXTRACTION_SLOTS` | JSON file of custom fields for LLM extraction (see `examples/extraction_slots.example.json`). |
| `LEADMAKER_CONTACT` | User-Agent contact string; the NWS weather API asks for one (e.g. `LeadMaker (you@example.com)`). |
| `LEADMAKER_CACHE_DIR` | Download cache for BBB sitemaps and Census/NOAA files (default `data/cache`). |
| `LEADMAKER_USER_JOBS_PER_HOUR` | On-demand jobs each rep may queue per hour (default 20). |
| `SOCRATA_APP_TOKEN` | Raises rate limits on the NY/NYC open-data APIs. |
| `LEADMAKER_CONCURRENCY`, `LEADMAKER_HOST_INTERVAL`, `LEADMAKER_PROFILE_TTL_HOURS`, `LEADMAKER_ENRICHMENT_TTL_HOURS` | Throughput, politeness and freshness controls. |
