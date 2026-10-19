# LeadMaker

LeadMaker is an AI-assisted lead generator and CRM for a roofing supply distributor. It finds GAF-certified roofing contractors around a ZIP code, enriches them from public sources, then tags and scores them and writes an AI summary and pitch for each. Reps work their leads in a web app, and managers allocate leads and track the team.

Design write-up: [DESIGN.md](DESIGN.md). All the design docs (DESIGN.md, system design with its architecture diagram, requirements, performance) are also in one page at [docs/index.html](docs/index.html). Open it in a browser; the diagram needs a network connection. Rebuild it after editing a doc with `.venv/bin/python scripts/docs-site/build.py`.

## Prerequisites

- **Docker Desktop** (Compose v2) with at least **12 GB free disk** for images and build cache. A first build from a clean clone used about 9 GB. The six Node service images are about 1.2 GB each (they share their base layers), PostGIS about 0.9 GB and the worker about 0.4 GB.
- **Node 24 or newer** (`engines` in `package.json`), for tests, migrations and the web dev server.
- **Python 3.12 and [uv](https://docs.astral.sh/uv/)**, to run the pipeline and its tests on the host.
- Optional: a **Gemini API key** (free tier) for the AI features. Without one, the app runs with the AI turned off.

Host tooling (not needed just to run the stack):

```bash
npm install                                    # root workspaces (services/*, packages/*); also generates the Prisma client
(cd apps/web && npm install)                   # the web app has its own lockfile
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -e ".[dev,postgres]"   # add ,llm for Claude
```

## Quick start: everything with one command

```bash
cp .env.example .env        # every value has a working local default; set GEMINI_API_KEY for the AI
npm run stack:up            # = docker compose --profile app up -d --build, plus --wait for healthy services
```

The first build takes several minutes. Compose runs these in order:

1. Postgres and Redis.
2. Migrations (dbmate).
3. The demo snapshot, `db/snapshot/leadmaker-demo.dump`, loaded only into an empty database. A fresh clone starts with the 424 real leads, their AI insights, territory briefs and weather signals, plus the demo users and their sales history (see [The database](#the-database)).
4. Import of a copy of `data/leadmaker.db`, the scraped contractor data, if you have it (`data/` is not in git). The original file is mounted read-only and never written. After the snapshot it finds nothing new.
5. The seed: demo users, about 50 leads per rep, and demo sales history. After the snapshot it finds them already there.
6. The services, the worker and the web app.

Open **http://localhost:3000**. In demo mode you are signed in as rep1 (Jordan Lee). To change users, open the account menu at the top right and choose **Switch user**:

| User | Role |
|---|---|
| `manager@demo.local` (Alex Morgan) | manager: team dashboard, the **Allocation** page and the **Admin** page (lead-sourcing areas and recent runs) |
| `rep1@demo.local`, `rep2@demo.local`, `rep3@demo.local` | sales reps: dashboard, leads, tasks |

To get an API token for curl, request one from dev-login (available only when `DEMO_MODE=1`):

```bash
curl -s localhost:8080/auth/dev-login -H 'content-type: application/json' -d '{"email":"rep1@demo.local"}'   # {"token": ..., "user": ...}
```

What runs:

| Service | Port | What it does |
|---|---|---|
| `web` | `127.0.0.1:3000` | nginx serving the React app; proxies `/api` and `/auth` to the gateway |
| `gateway` | `127.0.0.1:8080` | auth (JWT, dev-login), per-user rate limits, routing, the live event stream |
| `query` | 8081 (internal) | reads: lead lists, search, profiles, KPIs |
| `crm-write` | 8082 (internal) | writes: notes, stages, tasks, tags, allocations, refresh requests |
| `relay` | 8083 (internal) | publishes the outbox to the Redis event stream, invalidates caches, refreshes KPIs |
| `notifier` | 8084 (internal) | in-app notifications |
| `assistant` | 8085 (internal) | the AI chat drawer, reached through the gateway at `/api/assistant/*` |
| `worker` | none | the Python pipeline: job queue and schedules |
| `postgres` | `127.0.0.1:55432` | PostGIS 16 (user and password `leadmaker`) |
| `postgres-replica` | `127.0.0.1:55433` | read-only streaming replica; the query service reads from it |
| `redis` | `127.0.0.1:56379` | cache, rate limits, event stream |
| `dbmate`, `restore`, `import`, `seed` | none | one-shot setup containers; they exit 0 when done |

Check and operate the stack:

```bash
docker compose ps                                   # every long-running service should say (healthy); the worker has no health check
curl -s localhost:8080/readyz                       # gateway readiness
docker compose logs -f worker                       # follow one service's logs
docker compose --profile app up -d --build gateway  # rebuild and restart one service after a code change
SKIP_BUILD=1 npm run stack:up                       # start again without rebuilding
docker compose --profile app stop                   # stop everything, keep the data
docker compose --profile app down                   # remove the containers, keep the data volumes
```

Plain `docker compose up -d` (no profile) starts only Postgres, Redis and the migrations.

## Run the lead retriever

The pipeline goes scrape (GAF directory listing and profile pages), then enrich (secondary sources), then tag (tags, segment, priority score), then signals (weather, storms, news), then AI insights, then the territory briefing.

**In Docker** (the worker container already points at the stack's database):

```bash
docker compose exec worker leadmaker jobs enqueue pipeline --zip 30301 --radius 25   # queue a full refresh of an area
docker compose exec worker leadmaker jobs list --limit 5                             # job status and results
```

A `pipeline` job does scrape, enrich, county assignment and tagging for the area. It then queues AI insights for the area and the territory briefing. The worker picks it up within a few seconds. New leads land in the unallocated pool, and the manager hands them out on the Allocation page.

**On the host**, use `.venv/bin/leadmaker` with `LEADMAKER_DATABASE_URL` pointing at the compose Postgres. That line is in `.env.example`, and the CLI reads `.env` itself. Without it, the CLI falls back to the SQLite source file `data/leadmaker.db` and stops with a message rather than write to it.

```bash
export LEADMAKER_DATABASE_URL=postgresql+psycopg://leadmaker:leadmaker@localhost:55432/leadmaker   # if .env lacks it
.venv/bin/leadmaker stats
```

The commands below are the same in both places: prefix them with `docker compose exec worker` or `.venv/bin/`.

Change the location:

```bash
leadmaker run --zip 30301 --radius 25                    # scrape + enrich + tag, in the foreground
leadmaker run --zip 10013 --radius 25 --also-zip 07030   # several areas in one go (--also-zip repeats)
leadmaker scrape --zip 30301 --radius 15                 # one step at a time...
leadmaker enrich --zip 30301 --radius 15                 # enrich, tag and export default to 10013 / 25 miles:
leadmaker tag --zip 30301 --radius 15                    #   pass the area you scraped
leadmaker signals                                        # county weather alerts, storm history, local news
```

**Without the CLI**: any signed-in user can queue a scrape of an area through the API, limited to 20 a user per hour. In the web app, the manager's **Admin** page does the same: add an area under lead sourcing, then press **Run now**.

```bash
TOKEN=$(curl -s localhost:8080/auth/dev-login -H 'content-type: application/json' -d '{"email":"manager@demo.local"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:8080/api/refresh -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"postal_code":"30301","radius_miles":25}'
```

Schedules and on-demand jobs (the worker runs both):

```bash
leadmaker schedule add --name atl-daily --kind pipeline --zip 30301 --radius 25 --every-hours 24
leadmaker schedule list                                  # also: schedule enable|disable --name atl-daily
leadmaker jobs enqueue scrape --zip 10013 --also-zip 07030           # duplicate open jobs are merged
leadmaker jobs enqueue scrape --zip 07030 --requested-by <user-uuid> # as a rep: counts against their hourly limit
leadmaker jobs list --status failed
leadmaker jobs retry-dead                                # requeue jobs that ran out of attempts
leadmaker worker                                         # a worker on the host (--once to drain the queue and exit)
```

Inspect, export and audit:

```bash
leadmaker stats                                          # what is in the database
leadmaker sources                                        # which enrichers are enabled, and why not
leadmaker runs --limit 5                                 # recent pipeline runs
leadmaker validate                                       # data checks on the newest area (--strict fails on warnings)
leadmaker export --format csv --out data/leads.csv       # or --format json
leadmaker audit --gaf-id 1136285                         # field-level change history (or --company-id, --run-id)
```

Customer list and custom tags:

```bash
.venv/bin/leadmaker accounts import crm_export.csv       # mark existing / lapsed / prospect (template: examples/accounts_template.csv)
.venv/bin/leadmaker accounts list
leadmaker tag --rules examples/tag_rules.example.json    # your own tags and priority boosts (also $LEADMAKER_TAG_RULES)
```

`accounts import` replaces the previous list unless you pass `--append`. The worker container has `examples/` but not your files, so run imports of your own CSV from the host.

## Run the website

The stack's `web` container serves a production build at http://localhost:3000. For development, run the Vite dev server against the stack's gateway:

```bash
cd apps/web
npm run dev          # http://localhost:5173; proxies /api and /auth to API_TARGET (default http://localhost:8080)
npm run build        # type-check and build into dist/
npm run preview      # serve dist/ at http://localhost:4173
```

Map tiles (`VITE_TILE_URL`, `VITE_TILE_ATTRIBUTION`) and demo mode (`VITE_DEMO_MODE`, `VITE_DEFAULT_DEMO_USER`) are build-time settings. After changing them in `.env`, rebuild the container with `docker compose --profile app up -d --build web`.

## The database

Postgres with PostGIS runs in compose on `localhost:55432`. The schema lives in `db/migrations` (dbmate).

```bash
npm run db:up                       # Postgres + Redis + migrations only
npm run db:migrate                  # apply new migrations
npm run db:status                   # applied / pending
npm run db:rollback                 # undo the newest migration
npm run db:new -- add_some_table    # new migration file in db/migrations
npm run db:psql                     # psql shell on the leadmaker database
npm run db:roundtrip                # prove every migration's down undoes its up (scratch database)
npm run db:generate                 # regenerate the Prisma client (packages/db; npm install also does it)
npm run db:pull                     # refresh the Prisma schema from the database after a migration
```

Load a SQLite file of scraped contractors into Postgres. The file is copied first and never written, and re-runs skip rows already there:

```bash
.venv/bin/leadmaker import-sqlite data/leadmaker.db
SECTION1_DB=path/to/other.db npm run stack:up      # or have the compose import service load another file
.venv/bin/python scripts/import_parity.py data/leadmaker.db postgres://leadmaker:leadmaker@localhost:55432/<db>   # check an import into an otherwise empty database, column by column
```

A fresh stack loads the demo snapshot `db/snapshot/leadmaker-demo.dump` (about 3 MB, data only) right after the migrations, through the `restore` service (`scripts/db-restore-snapshot.sh`). It runs only when the database has no companies, so it never overwrites your data. It moves the demo sales history (activity, tasks, allocations, notifications) forward by whole days so the latest activity is today; the AI text, signals and pipeline history keep their real dates. Without the file, or with `SNAPSHOT_RESTORE=0`, the import and the seed load the database as before.

```bash
npm run db:restore-snapshot         # load the snapshot into an empty, migrated database (does nothing otherwise)
npm run db:snapshot                 # regenerate it from the running database
```

`db:snapshot` copies the database into a scratch database, drops delivered outbox rows and queued jobs, dumps it and drops the copy; the live database is never written. The snapshot holds **everything** in the database, including notes and anything typed while testing, and it is committed to git, so clean the data first.

What is real and what is demo data (the snapshot holds both):

- **Real**: the contractors and everything about them: GAF profile data, enrichment (Google Places, BBB, FMCSA, OSM, websites), tags and scores, county weather and storm signals (NWS/NOAA), and the AI insights and territory briefs.
- **Demo** (`db/seed`, applied by the `seed` service or `npm run db:seed`):
  - the four users, plus a territory and about 50 top leads for each rep (`SEED_LEADS_PER_REP`);
  - four weeks of sales history: stages, calls, emails, visits, tasks, and about 10% marked existing or lapsed customers. Every row it writes is marked `demo_seed`, it runs once, and `SEED_DEMO_ACTIVITY=0` turns it off.

The seed is idempotent and does nothing until companies exist, so after scraping into an empty database, run `npm run db:seed` again.

## AI

Set `GEMINI_API_KEY` in `.env` (free tier) and recreate the stack (`docker compose --profile app up -d`). `LEADMAKER_LLM_PROVIDER` chooses the provider:

- `auto` (the default) picks Gemini when a Gemini key is set, else Claude when `ANTHROPIC_API_KEY` is set, else an OpenAI-compatible server when `LEADMAKER_LLM_BASE_URL` is set.
- You can also name one: `gemini`, `anthropic` or `openai_compat`, with `LEADMAKER_LLM_API_KEY` for the last.

The worker and the assistant have their own model settings (see Configuration).

What it adds:

- **Lead insights**, shown on each lead's profile: a summary, one pitch line (with its product focus), talking points and the person to ask for. They are built from every fact about the lead: GAF data, website text, size, tags, notes and custom fields.
  - A lead is regenerated only when its inputs, the prompt version or the model change.
  - After a note, call, override, custom field, tag or stage change, crm-write queues a regeneration 60 s later.
  - Guards reject invented certifications, contacts and URLs, weather talk, and promises about the distributor.
- **Refresh**: the AI insights card on a lead's profile has a **Refresh** button (**Generate** before a lead has any), which regenerates that lead right away. Each user gets 30 a day (`LEADMAKER_MANUAL_INSIGHTS_PER_USER_PER_DAY`). These runs use their own daily model allowance (`LEADMAKER_MANUAL_INSIGHTS_PER_DAY`, 40), so they still work after the batch budget is spent.
- **Territory briefing**, one line on the dashboard. It is a deterministic digest of the last data poll, weather alerts and 30 days of storm reports. A cached AI rewrite may reuse only the digest's numbers, places and names. Nothing is shown when there is nothing to say.
- **Assistant**, the floating chat drawer, served by `services/assistant`. It answers questions about the open lead, filters the lead list from plain English, and answers "who should I call first" from overdue and due-today follow-ups. Every read goes through the query service as the asking user.

```bash
docker compose exec worker leadmaker insights --dry-run              # what would regenerate, and the call estimate (no calls)
docker compose exec worker leadmaker insights --limit 20             # generate now (allocated leads first)
docker compose exec worker leadmaker insights --stale                # only leads whose notes, fields or website changed
docker compose exec worker leadmaker insights --zip 30301 --radius 25   # one area's leads
docker compose exec worker leadmaker insights show --company <id>    # the latest insight of one lead, as JSON
docker compose exec worker leadmaker jobs enqueue insights --zip 10013 --radius 25   # as a background job
docker compose exec worker leadmaker briefing --print                # territory digests and their AI rewrite
docker compose exec worker leadmaker briefing --no-ai --print        # digests only, no model call
```

AI schedules are opt-in. `LEADMAKER_AI_SCHEDULES=1` makes the worker add a 15-minute stale-insights run and an hourly briefing. To set your own interval, use `leadmaker insights schedule --every-hours N` or `leadmaker briefing schedule --every-hours N`.

Gemini free-tier quotas are per model: `gemini-3.8-flash` allows 20 requests a day per project (measured 2026-10-19). So the worker and the assistant default to `gemini-3.5-flash-lite`, whose free day is much larger (no limit hit after about 170 calls).

- The worker stops at 150 calls a day and resumes on its next run.
- The assistant stops at 100, then falls back to `gemini-3.8-flash` (20). Each user gets a quarter of the assistant's day.
- When every model's day is spent, the drawer says when AI answers come back. Lists, filters and profiles keep working.
- Keep the worker's model stable: changing it regenerates every insight.

Evaluations (`evals/`, details in `evals/README.md`):

```bash
npm run eval:offline                                           # every case on the deterministic fake provider: 0 model calls
node evals/assistant/run.ts --live --dry-run                   # live plan and call estimate (no provider, no key read)
.venv/bin/python -m evals.insights.run --live --dry-run
npm run eval:live                                              # NL filter, lead Q&A and insights against the model in .env
node --env-file-if-exists=.env evals/assistant/run.ts --live --suite nl_filter --limit 5 --max-calls 6   # a smaller run
node evals/assistant/run.ts --via-gateway http://localhost:8080   # NL filter end to end through the running stack
```

Live runs are capped. By default they make at most 9 NL-filter, 6 lead Q&A and 3 insights calls (`--max-calls` changes this), and they write reports to `data/evals/`. Providers other than Gemini and the fake are refused without `--allow-provider`, because they are paid APIs.

## Tests

Most suites need the compose Postgres and Redis (`npm run db:up`). Every automated test uses the fake AI provider.

```bash
npm run typecheck                       # every workspace
npm test                                # unit tests of every workspace
npm run test:db                         # packages/db against a fresh test database
npm run test:db -w @leadmaker/query     # one workspace's database tests (gateway, crm-write, relay, notifier, assistant, shared)
npm run test:stack                      # end-to-end scenarios on a private compose project from empty volumes, torn down after
                                        # (Section 1 import + seed when data/leadmaker.db exists, else the demo snapshot)
.venv/bin/pytest -q                     # pipeline, offline
.venv/bin/pytest -q -m pg               # pipeline against the compose Postgres (its own leadmaker_pipeline_test database)
(cd apps/web && npm run typecheck && npm test && npm run build)   # web app
npx tsc -p evals/tsconfig.json          # typecheck the evals
```

Load test, with 100k synthetic leads on a separate `leadmaker_perf` database (see `scripts/perf/`, results in `scripts/perf/results/SUMMARY.md`):

```bash
sh scripts/dbmate.sh --db leadmaker_perf up
node scripts/perf/synth.mjs                 # wipes and refills leadmaker_perf only
sh scripts/perf/services.sh start           # services on the host, ports 19080-19083
sh scripts/perf/matrix.sh                   # 50 / 200 / 500 virtual users, cold and warm
node scripts/perf/report.mjs                # one table over every run
sh scripts/perf/services.sh stop
```

## Configuration

Every variable is optional. `docker compose` reads `.env` for substitution, and `.env.example` lists the defaults with comments. After a change, run `docker compose --profile app up -d` to recreate the affected containers. Build-time `VITE_*` settings need `--build web` as well.

| Variable | Effect |
|---|---|
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Turns on the AI on Gemini (free tier for the demo). |
| `ANTHROPIC_API_KEY` | AI on Claude (production; install the `llm` extra on the host). |
| `LEADMAKER_LLM_PROVIDER`, `LEADMAKER_LLM_MODEL`, `LEADMAKER_LLM_BASE_URL`, `LEADMAKER_LLM_API_KEY`, `LEADMAKER_LLM_RPM`, `LEADMAKER_LLM_RPD` | Provider (`auto`, `gemini`, `anthropic`, `openai_compat`) and model, an OpenAI-compatible server and its key, and client-side rate limits. |
| `LEADMAKER_WORKER_LLM_MODEL`, `LEADMAKER_WORKER_LLM_RPD` | The worker's model and daily cap for insights and briefings (default `LEADMAKER_LLM_MODEL`, else `gemini-3.5-flash-lite` on Gemini; 150 a day). |
| `LEADMAKER_INSIGHTS_BATCH_SIZE`, `LEADMAKER_INSIGHTS_ON_REFRESH`, `LEADMAKER_AI_SCHEDULES`, `LEADMAKER_BRIEFING_AI` | Leads per insights call (5), queue insights after refreshes (1), the opt-in AI schedules (0), and the briefing's AI rewrite (1). |
| `LEADMAKER_INSIGHTS_ON_EDIT`, `LEADMAKER_INSIGHTS_EDIT_DELAY_SECONDS` | crm-write queues insights for a lead when an edit changes its AI inputs (on, after 60 s, merged per lead). |
| `LEADMAKER_MANUAL_INSIGHTS_PER_USER_PER_DAY`, `LEADMAKER_MANUAL_INSIGHTS_PER_DAY`, `LEADMAKER_WORKER_URGENT_POLL_SECONDS` | The profile Refresh: presses per user per day (30), the worker's own model allowance for them (40), and how fast an idle worker wakes for one (1 s). |
| `LEADMAKER_ASSISTANT_LLM_PROVIDER`, `LEADMAKER_ASSISTANT_LLM_MODEL`, `LEADMAKER_ASSISTANT_RPM`, `LEADMAKER_ASSISTANT_RPD` | The assistant's provider, model and global budget (Gemini: `gemini-3.5-flash-lite`, 8 a minute, 100 a day; Claude and OpenAI-compatible: 120 a minute, 5,000 a day as a cost ceiling). |
| `LEADMAKER_ASSISTANT_FALLBACK_MODELS` | Models tried in order when the primary's day is spent, as `model[:requests per day]` (Gemini default `gemini-3.8-flash:20`; `none` turns them off). |
| `ASSISTANT_USER_LLM_CALLS_PER_DAY`, `ASSISTANT_USER_PER_MINUTE`, `ASSISTANT_USER_PER_DAY` | Per-user assistant limits: model calls a day (default a quarter of the assistant's budget, at least 6), and questions (6 a minute, 150 a day). |
| `ASSISTANT_PROVIDER_TIMEOUT_MS`, `ASSISTANT_REQUEST_TIMEOUT_MS`, `ASSISTANT_TIMEOUT_MS`, `ASSISTANT_GEMINI_THINKING_LEVEL` | Assistant timeouts (compose: 70 s per model call, 80 s per request; the gateway's limit 90 s) and the Gemini thinking level (empty = `low`). |
| `LEADMAKER_DATABASE_URL` | The pipeline's database on the host, in SQLAlchemy form (`postgresql+psycopg://leadmaker:leadmaker@localhost:55432/leadmaker`). The services' `postgres://` `DATABASE_URL` is ignored by the pipeline. |
| `DATABASE_URL`, `DATABASE_REPLICA_URL`, `REDIS_URL` | Node services and Prisma on the host; the query service reads from the replica when set. |
| `POSTGRES_HOST_PORT`, `REPLICA_HOST_PORT`, `REDIS_HOST_PORT`, `GATEWAY_HOST_PORT`, `WEB_HOST_PORT` | Host ports (55432, 55433, 56379, 8080, 3000). |
| `GATEWAY_BIND`, `WEB_BIND` | Host interface (127.0.0.1). `0.0.0.0` shares the app on your LAN, and with demo mode on, anyone who can reach it can sign in. |
| `DEMO_MODE`, `JWT_SECRET`, `JWT_TTL`, `INTERNAL_TOKEN` | Demo sign-in (`POST /auth/dev-login`; never enable it in production), token signing, and the service-to-service token. Use long random values outside local demos. |
| `VITE_DEMO_MODE`, `VITE_DEFAULT_DEMO_USER`, `VITE_TILE_URL`, `VITE_TILE_ATTRIBUTION` | Web build: demo mode (on), who it signs in as (`rep1@demo.local`), and the map tiles. |
| `SEED_LEADS_PER_REP`, `SEED_DEMO_ACTIVITY` | Leads allocated to each demo rep (50) and the demo sales history (1 = on). |
| `SNAPSHOT_RESTORE`, `SNAPSHOT_SHIFT_DATES` | Load the demo snapshot into an empty database (1 = on), and move its demo history to today (1 = on). |
| `SECTION1_DB` (`npm run stack:up`), `SECTION1_DIR`, `SECTION1_DB_FILE` | The SQLite file the import service loads (default `data/leadmaker.db`). |
| `MAX_BULK_ALLOCATION`, `MAX_BULK_TAG`, `WEEKLY_ACTIVITY_GOAL`, `LEADMAKER_USER_JOBS_PER_HOUR` | Most leads one allocation may move (5,000), one bulk tag may tag (500), each rep's weekly activity goal (25), and area refreshes each user may queue per hour (20). |
| `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_BURST`, `UPSTREAM_TIMEOUT_MS`, `USER_ROLE_TTL_SECONDS`, `SSE_ROLE_CHECK_MS` | Gateway: per-user rate limit (10/s, burst 40), upstream timeout, and how long a changed role takes to apply. |
| `LEAD_LIST_CACHE_TTL_SECONDS`, `DATABASE_POOL_MAX`, `DATABASE_SEARCH_POOL_MAX`, `SEARCH_CONCURRENCY`, `SEARCH_QUEUE_MAX`, `SEARCH_QUEUE_WAIT_MS`, `SEARCH_STATEMENT_TIMEOUT_MS`, `STATEMENT_TIMEOUT_MS`, `REDIS_COMMAND_TIMEOUT_MS` | Query service caching, pools, search load shedding and timeouts (see `.env.example`). |
| `KPI_REFRESH_INTERVAL_MS`, `KPI_REFRESH_DEBOUNCE_MS`, `LIST_VERSION_COALESCE_MS` | Relay: KPI refresh period and debounce, and list-cache invalidation coalescing. |
| `WORKER_POLL_SECONDS` | Seconds between the worker's job-queue polls when idle (5). |
| `GOOGLE_MAPS_API_KEY` | Google Places enrichment and Google geocoding of the search origin. |
| `SOCRATA_APP_TOKEN` | Higher rate limits on the NY/NYC open-data APIs. |
| `BRAVE_SEARCH_API_KEY`, `SERPAPI_KEY` | Website discovery for contractors without a listed site. |
| `LEADMAKER_TAG_RULES`, `LEADMAKER_EXTRACTION_SLOTS` | JSON files of custom tag rules and custom LLM extraction fields (see `examples/`). |
| `LEADMAKER_CONTACT` | User-Agent contact string; the NWS weather API asks for one (e.g. `LeadMaker (you@example.com)`). |
| `LEADMAKER_CACHE_DIR`, `LEADMAKER_LLM_USAGE_FILE` | Download cache for BBB, Census and NOAA files (`data/cache`), and the file holding the client-side LLM day counter. |
| `LEADMAKER_CONCURRENCY`, `LEADMAKER_HOST_INTERVAL`, `LEADMAKER_PROFILE_TTL_HOURS`, `LEADMAKER_ENRICHMENT_TTL_HOURS`, `LEADMAKER_BBB_INDEX_TTL_HOURS` | Scraper throughput, politeness and freshness. |

## Troubleshooting

- **`postgres-replica` never becomes healthy on an older database volume.** The replication user is created only when the database is first initialised. For a volume created before the replica existed, run this once, then `docker compose --profile app up -d postgres-replica`:

  ```bash
  docker compose exec -T postgres psql -U leadmaker -d postgres -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator'"
  docker compose exec -T postgres sh -c 'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
  docker compose exec -T postgres psql -U leadmaker -d postgres -c 'SELECT pg_reload_conf()'
  ```

- **Out of disk during a build.** Build the images one at a time, then start the stack without rebuilding:

  ```bash
  for s in import gateway query crm-write relay notifier assistant worker web; do docker compose --profile app build "$s"; done
  SKIP_BUILD=1 npm run stack:up
  ```

  `docker system df` shows where the space went. `docker builder prune` frees the build cache, but it also clears caches other projects use, so run it at your own discretion.
- **Services unhealthy after Docker Desktop restarts.** Postgres and Redis have no restart policy, so start them, then the rest: `docker compose up -d postgres redis && SKIP_BUILD=1 npm run stack:up`.
- **Port already in use.** Set `WEB_HOST_PORT`, `GATEWAY_HOST_PORT`, `POSTGRES_HOST_PORT`, `REPLICA_HOST_PORT` or `REDIS_HOST_PORT` in `.env`. If you move Postgres or Redis, update `DATABASE_URL`, `LEADMAKER_DATABASE_URL` and `REDIS_URL` too. The test scripts assume 55432 and 56379.
- **Import refuses `data/leadmaker.db` because its `-wal` has frames.** Stop whatever has the file open, then run `sqlite3 data/leadmaker.db 'PRAGMA wal_checkpoint(TRUNCATE)'`.
- **The app is empty.** The snapshot loads only into an empty database (`docker compose logs restore` says why it skipped), and if `data/leadmaker.db` is also missing, the import is skipped. Retrieve leads with `docker compose exec worker leadmaker jobs enqueue pipeline --zip 10013 --radius 25`, then run `npm run db:seed` to allocate them to the demo reps.
- **The AI shows as offline.** There is no provider key in `.env`, or the day's quota is spent. `docker compose logs assistant worker` says which.
- **Reset everything to a fresh demo.** This deletes every Docker volume of the stack: all CRM edits, AI insights generated since, the worker's download cache and its LLM day counter. The next start loads the snapshot again. `data/leadmaker.db` is not touched.

  ```bash
  docker compose --profile app down -v && npm run stack:up
  ```

## Repo layout

```
apps/web/          React web app (Vite); nginx config and Dockerfile for the web container
services/          TypeScript services: gateway, query, crm-write, relay, notifier, assistant
packages/db/       Prisma schema and client shared by the services
packages/shared/   shared types and contracts (filters, events, limits, cache keys)
leadmaker/         Python pipeline and CLI: scrapers, enrichers, tagging, signals, jobs, AI insights, briefings
db/migrations/     dbmate SQL migrations (the schema)
db/seed/           demo users, allocations and demo sales history
db/snapshot/       the demo database snapshot a fresh stack loads (npm run db:snapshot regenerates it)
evals/             AI evaluation suites and runners
examples/          tag rules, extraction slots and a customer-list template
scripts/           stack, database and seed scripts; Dockerfiles; the perf harness (scripts/perf)
tests/             pipeline tests (pytest) and the end-to-end stack suite
data/              the scraped SQLite source, caches and eval reports (git-ignored)
docs/              design notes
```
