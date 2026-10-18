# LeadMaker

GAF contractor lead pipeline: scrape, enrich and tag roofing contractors around a ZIP code.

## Setup

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
.venv/bin/leadmaker jobs enqueue scrape --zip 07030 --requested-by rep42  # rep-triggered; 20 per rep per hour
.venv/bin/leadmaker worker                                             # runs queued + scheduled jobs
.venv/bin/leadmaker accounts import crm_export.csv                     # existing / lapsed / prospect tagging
.venv/bin/leadmaker tag --rules examples/tag_rules.example.json        # user-defined tags + priority boosts
.venv/bin/leadmaker audit --gaf-id 1136285                             # field-level change history
```

## Configuration

All environment variables are optional.

| Variable | Effect |
|---|---|
| `DATABASE_URL` | Defaults to `sqlite:///data/leadmaker.db`; set `postgresql+psycopg://…` for Postgres. |
| `GOOGLE_MAPS_API_KEY` | Enables Google Places enrichment and Google geocoding of the search origin. |
| `GEMINI_API_KEY` | Enables LLM extraction on the Gemini API (free tier for the demo). |
| `ANTHROPIC_API_KEY` | Enables LLM extraction on Claude (production). |
| `LEADMAKER_LLM_PROVIDER`, `LEADMAKER_LLM_MODEL`, `LEADMAKER_LLM_BASE_URL`, `LEADMAKER_LLM_RPM`, `LEADMAKER_LLM_RPD` | Choose the LLM provider and model, point at an OpenAI-compatible server, and set client-side rate limits. |
| `LEADMAKER_EXTRACTION_SLOTS` | JSON file of custom fields for LLM extraction (see `examples/extraction_slots.example.json`). |
| `LEADMAKER_CONTACT` | User-Agent contact string; the NWS weather API asks for one (e.g. `LeadMaker (you@example.com)`). |
| `LEADMAKER_CACHE_DIR` | Download cache for BBB sitemaps and Census/NOAA files (default `data/cache`). |
| `LEADMAKER_USER_JOBS_PER_HOUR` | On-demand jobs each rep may queue per hour (default 20). |
| `SOCRATA_APP_TOKEN` | Raises rate limits on the NY/NYC open-data APIs. |
| `LEADMAKER_CONCURRENCY`, `LEADMAKER_HOST_INTERVAL`, `LEADMAKER_PROFILE_TTL_HOURS`, `LEADMAKER_ENRICHMENT_TTL_HOURS` | Throughput, politeness and freshness controls. |
