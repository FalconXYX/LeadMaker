# System Design: B2B Roofing Sales Intelligence Platform

## 1. Overview

A B2B lead intelligence platform for a single enterprise roofing distributor (single tenant, so there is no tenant ID; access is role-based within one organization). The system scrapes contractor data (seeded from GAF around ZIP 10013), enriches it with public business registries, company websites and local weather/news, and pre-generates sales insights. It uses a **Primary/Read Replica (CQRS-style read/write split)** database architecture to separate heavy asynchronous scraping/AI writes from fast, read-heavy CRM queries across thousands of reps. The design is industry-agnostic: roofing with GAF is the first industry, and every lead has an internal ID that doesn't depend on the source that found it.

---

## 2. System Architecture Diagram

--- <iframe src="https://mermaid.live/embed?theme=redux-dark-color&look=classic&mode=dark#pako:eNqlVtty2zYQ_ZUdeuKRp5TVTtMXxeMZ3WK7kW1ZVOppoz5AJESihggOAEpmk_x7FxdSpO32pfKDCXCxl7NnD_g1iEVCg2Gw5eIQZ0RqWI3XOeDv3Tu4w3fKrSac0Vx_WQcXm8vJ8hYe6QZGRQG9JSWxhgGsorOLwebyYiMHl1Oiso0gMgnhI-OaSrLhFOZMaRXCnJIEFlJsGae4HHEuYqKZyPH5BiYZ0evgTxf0imh6IJWLOlrc1BtNoCUtYK_O4ZbkJKUSolgUxukS7TDejmllnTl3qtykkhQZRFTuWUwVoOcxiZ9onhz3equqoFEsWaHPmkwsBMtbX7-QFCwIkmEcf7JJ6k5ok0OkiS7x__2eSskSszUplRY7WJG0U7jqhHkoqfQl20c49SC-CmSQ9K-MJcPkf4DfmGIbxpmuYFly2q0AwXWe7_P-lO4I1o2Yv-UXHk5H6O3zTR18JQSHCeGc5WnjFIF7Da4WEpthsJ0STTD9CYkzPAVzUqEjw5hk4KErMNEuykuaMPWlZ7O0z01a10JbVzSE2R7JiJEkJTsM0Gn3WcvZQrIdkdV07B0uhNKppNHDvH4FPZfJdHykLzafWBrd5IqlmSGtIdosYebxV7ExcJcUA9-XeiOeuzFNeW8FNPvGD2cxUS0Gk6R_n_PK4kYR8lssRjLC2d80wW7SQ6umt_BesIJiUyzgI1XlMaadUmWIhRliexuD3qLSmci7eK8kS3F0HC0iRDdB1kgc6CNFvInJ-SVTS-oONqA0hfnKFfwlNgq0VYBe9OlmAfP7yafZtJuFg1yqOg27wvRnuWRxtjPdfhTyCS2aAFejjzBlksaIWxXCotwgsghwijJjZiGE8XiMMydyLYkxgggb3Z0185I-17LmFq8CPVKiMyoHpkE7QBkyYzbH2eVwZ7vTcjilXBPnzj5iASlC3_iyMbCYU2xSUWq4RqXEsaTxU9cPSkTTFDPGyu8cOVopTWspiWhqIAoNqYU0o49CKLuzP5979RoTHWdm-arQ2bNFykpxVO5wPIyknCKB8EQLuRYL8ZJwNwOaeXE2oOY0dsLWujvgot-__LYOrlerRYT8iqLZOvhWn-oIPqClFdhTqCXQ3gvHoF6yQItGb1phoTd5WEa1uuRevMHFt_OuwMycid9IhLfDON7wqKR9e68kdoSVOWSzcgdcgnVtKFGNkVWvtpGzOU68F21na0SjY3x-tP5dlLLv8-5t6QEUkK0RZXHIAaMYCe1U0uA0HdeS4_XAKqfPqjlQB3Py0TrwMrXWCXvA6R-acFK9KNk-1o6tbCPl9yhrSZ3KnO0pfC5w7TBomNBk3yjXK0p5SbJEsbrTQIe6bDZrQTHUcXPtLJp9Y2RH1O27aW0xBC-VA5gL7A2SNMZ-Kn1OpE6p8WHGEzOw06j-y5HB0lACBWWAFEQBN2zDY45KOK3ugBnbdoD6hnqLyV7OnPlElLnRBZbmhCOLcmF8_StvJpySHMYcP44w_8fMxBrAlSSVQt3Di1tX9kPA2secKDWlW0jolpRcA37a8eHJ1v5CVGPxRIcnP9ufX_YPLNHZ8KfzX4rnMBZcyOHJj_b34YVP5cfb-3xv_v6PT0fMsCk6dPyu43wIwiDFz7VgqGVJw2BH5Y6YZfB1HeA1sENVHa4Didfkcz8h8qlvI62DcB1wIZ7sWxuIxevgO3orSP6HELvaoRRlmgXDLXYBV6Wl_5QRvMu9yfd_ACCrugg" width="100%" height="480" style="border:0" loading="lazy" title="Mermaid diagram" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>

## 3. Requirements

### Functional

- **Role-Based Access:** Reps see the leads allocated to them (their territory) and can view, but not act on, unallocated leads. Managers see every lead and are the only ones who allocate or reassign leads.
- **Dashboard:** Shows KPI counters (unserviced, unchecked, updated in last poll), a map of the rep's leads, weather/news alerts, and a territory AI summary.
- **Filtering & Custom Fields:** Filter by system tags (size, age, GAF certs, roof materials), segment, priority score and account status, or by custom tags that reps create and custom data slots.
- **Lead Profiles:** Displays company details, size-based target contacts (Owner for small shops vs. Office/Purchasing Manager for larger companies, falling back to the owner), rep notes, weather context, and AI sales pitches. Notes are visible to anyone who can view the lead.
- **Lead Allocation (Managers):** An unallocated queue for new leads, bulk assignment of a filtered list to a rep, and allocation suggestions that the manager approves.
- **AI Chatbot:** Answers questions about specific leads and translates natural language queries into UI list filters, under the same visibility rules as the user.

### Non-Functional

- **Read-Heavy Scalability:** Supports thousands of reps via **PostgreSQL Read Replicas**, connection pooling (PgBouncer) and Redis caching so heavy reads never block writes.
- **Override Safety:** Pipeline re-scrapes never overwrite manual rep edits.
- **Multi-User Attribution:** Notes and edits track `user_id` and timestamps with optimistic locking to prevent edit collisions.
- **Delta Processing:** Scrapers and LLMs reuse stored results within each source's refresh window and only reprocess records whose inputs changed, to save compute.

### Targets (sizing assumptions)

| Area          | Target                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scale         | 2,000 reps + 200 managers; ~500 concurrent at peak (~200 requests/s)                                                                                |
| Latency (p95) | Lead list/filter ≤ 300 ms · lead profile ≤ 200 ms · dashboard KPIs ≤ 500 ms · natural-language filter ≤ 3 s                                         |
| Freshness     | A rep's edit is visible to other users within 5 s · GAF re-polled weekly · enrichments refreshed every 30 days · weather alerts polled every 15 min |
| Availability  | 99.9% for the read API · daily backups with point-in-time recovery                                                                                  |

---

## 4. Data Pipeline (Ingestion & Tagging)

1. **Triggers:** Runs on a recurring schedule (cron) or on-demand when a rep/manager requests a territory refresh (or searches a new area) or adds a new custom extraction field. Duplicate requests for the same area are merged into one job, and requests are rate-limited per user. Jobs go through a database-backed job queue (Postgres with `SKIP LOCKED` claiming; today's offline pipeline also runs it on SQLite until the Postgres move) with retries and backoff, a dead-letter state and duplicate-job rejection. Per-host rate limits are enforced in each worker's HTTP client; in production they are shared across workers through a Redis token bucket.
2. **Scrapers:** Pulls base attributes from the GAF directory, enriches from public registries (NY corporations, NYC contractor licences, USDOT/FMCSA), finds decision-makers through Better Business Bureau profiles (owner/manager names and titles), and crawls contractor websites for material specialties (metal, shingle, flat/TPO), work types (new construction vs. storm repair), and target contacts. Hunter.io email discovery is parked for later.
3. **Environmental Signals:** Pulls regional weather forecasts/storm alerts and local roofing news per county. These feed a separate, cheap timing layer and never trigger per-lead LLM calls (see §7).
4. **Delta Check:** Within each source's refresh window (GAF profiles 7 days, enrichments 30 days), a stored result is reused unless its `input_hash` changed; after the window it is refreshed, and errors are always retried. `content_hash` flags which GAF listings changed, for change tracking and the audit log. LLM insights re-run only when their `input_hash` changes. A run that reads fewer results than expected is marked partial and doesn't mark leads as delisted or changed. All pipeline outputs write strictly to the **Primary Write DB**.
   - When a material field changes, the Delta Engine sets `last_material_change_at`. At the end of a complete run, it sets `updated_in_last_poll` for the leads that run covered (true if new or changed).
   - When a company is first created, its `county_fips` is set from its location (PostGIS point-in-polygon against Census county boundaries).
5. **Tagging:** A deterministic rules engine turns raw fields into system tags (each with a reason and source), a segment (strategic / growth / emerging / long tail) and a 0–100 priority score.

---

## 5. Backend & Database Architecture

- **CQRS / Read-Write Split:**
  - **PostgreSQL Primary (Write Store):** Handles all pipeline ingestion writes, LLM insight writes, and rep mutations (notes, status changes, manual overrides, allocations).
  - **PostgreSQL Read Replicas (Read-Only Store):** Asynchronously replicates from the Primary DB (materialized views are refreshed on the Primary and replicate like any table). All dashboard loads, territory filtering, and chatbot context lookups hit the Read Replicas to isolate read traffic from write load. After a write, that user's reads go to the Primary for a few seconds so their own edit never seems to disappear.
- **PostgreSQL + JSONB + PostGIS:** Stores core relational data alongside `JSONB` columns for scraped attributes, system tags and custom data slots (system tags and custom data slots GIN-indexed), so new fields need no schema migrations. `PostGIS` handles radius searches. Geographic partitioning is deferred until data volumes require it.
- **Redis:** Caches hot lead profiles, common filter queries and KPI counters, and holds per-user rate-limit counters. Entries are invalidated by events whenever the pipeline or a rep changes a lead. Rep-specific cache keys include the user ID so one rep's results are never served to another.
- **Event Bus:** Every write inserts an event into an `outbox_events` table in the same transaction; a relay publishes it to Redis Streams. Services subscribe to the events they need (e.g., the AI service consumes `lead.updated`), and the same events drive cache invalidation and live UI updates. Consumers are idempotent. Production can swap in Kafka or SNS+SQS.
- **Override Protection:** The pipeline only writes scraped values. Rep edits go to a separate `field_overrides` table that the pipeline never touches, covering both company fields and individual contacts. The read layer shows the override when one exists, otherwise the scraped value. If the scraped value changes after a rep's edit, the profile flags "source changed since your edit".
- **Concurrency:** Notes and activities are append-only, so they can't conflict. Edits to shared fields use optimistic locking: the client sends the `version` it read of the company or contact, and a stale write is rejected with the current value and who changed it. An override write supersedes the field's current override and checks that version in the same transaction; at most one active override exists per field.

### Lead State

- **Checked (per rep):** The rep marked the lead reviewed after its last material change (tier, certifications, rating, contact info, website). A material change makes it unchecked again.
- **Serviced (per rep):** The rep logged a call, email or visit.
- **Team level:** Checked or serviced by any rep. The CRM Write Service updates `companies.team_last_checked_at` / `team_last_serviced_at` in the same transaction as the per-rep `lead_rep_state` write.
- **Updated in last poll:** New, or materially changed, in the most recent complete pipeline run.
- **Account status:** `prospect`, `existing_customer`, `lapsed_customer` or `do_not_contact`, from the distributor's CRM import.

### Permissions

|             | Allocated to me                                                   | Unallocated                 | Allocated to another rep |
| ----------- | ----------------------------------------------------------------- | --------------------------- | ------------------------ |
| **Rep**     | View, notes, checked/serviced, activities, overrides, custom tags | View only (including notes) | No access                |
| **Manager** | Everything                                                        | Everything + allocate       | Everything + reassign    |

- Notes, overrides, custom tags and activity history stay with the lead when it is reassigned.
- Allocate and reassign write the `lead_allocations` history row and `companies.assigned_rep_id` in the same transaction, so the two never drift.
- One visibility rule is applied on every read path: lists, profiles, search, exports, cache and AI tools.

### Shared Filter Definition

One `LeadFilter` schema is used by the list API, saved views, bulk allocation and the AI filter tool:

```ts
type LeadFilter = {
  scope?: "mine" | "unallocated" | "all" | { repId: string }; // "all" and repId: managers only
  tagsAll?: string[];
  tagsAny?: string[];
  customTags?: string[];
  customFields?: {
    key: string;
    op: "eq" | "gte" | "lte" | "contains" | "exists";
    value?: string | number | boolean;
  }[];
  certifications?: string[]; // source-namespaced, e.g. "gaf:master_elite", "gaf:certified_plus", "gaf:certified", "gaf:none"
  size?: ("small" | "medium" | "large")[];
  segment?: ("strategic" | "growth" | "emerging" | "long_tail")[];
  accountStatus?: (
    | "prospect"
    | "existing_customer"
    | "lapsed_customer"
    | "do_not_contact"
  )[];
  materials?: string[];
  services?: string[];
  minRating?: number;
  minYearsInBusiness?: number;
  near?: { zip: string; radiusMiles: number };
  unchecked?: "me" | "team";
  unserviced?: "me" | "team";
  updatedSince?: string; // ISO date
  text?: string;
  sort?: {
    by:
      | "priority_score"
      | "distance"
      | "rating"
      | "review_count"
      | "years_in_business"
      | "last_change";
    dir: "asc" | "desc";
  };
  cursor?: string;
  limit?: number;
};
```

### Core Schema

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'rep' CHECK (role IN ('rep', 'manager'))
);

-- One row per real business, whichever source found it (industry-agnostic)
CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    industry VARCHAR(50) NOT NULL DEFAULT 'roofing',
    business_name VARCHAR(255) NOT NULL,
    website_url TEXT,
    location GEOGRAPHY(Point, 4326) NOT NULL,
    county_fips CHAR(5),                                     -- joins to regional_signals
    assigned_rep_id UUID REFERENCES users(id),               -- copy of the open lead_allocations row; NULL = unallocated pool
    account_status VARCHAR(30) NOT NULL DEFAULT 'prospect',
    scraped_attributes JSONB NOT NULL DEFAULT '{}',          -- written only by the pipeline
    system_tags JSONB NOT NULL DEFAULT '[]',                 -- [{key, value, label, category, reason, source}]
    custom_fields JSONB NOT NULL DEFAULT '{}',               -- rep-entered data slots; written only by the CRM Write Service
    segment VARCHAR(20),
    priority_score NUMERIC(4,1),                             -- 0-100
    updated_in_last_poll BOOLEAN NOT NULL DEFAULT TRUE,
    last_material_change_at TIMESTAMPTZ,
    team_last_checked_at TIMESTAMPTZ,
    team_last_serviced_at TIMESTAMPTZ,
    content_hash VARCHAR(64) NOT NULL,
    version INT NOT NULL DEFAULT 1
);
CREATE INDEX ON companies USING GIST (location);
CREATE INDEX ON companies USING GIN (system_tags jsonb_path_ops);
CREATE INDEX ON companies USING GIN (custom_fields jsonb_path_ops);
CREATE INDEX ON companies (assigned_rep_id, priority_score DESC);

-- Maps each source's ID (GAF, FMCSA, NY DOS, ...) to the internal company ID
CREATE TABLE company_source_ids (
    source VARCHAR(50) NOT NULL,
    external_id VARCHAR(100) NOT NULL,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    PRIMARY KEY (source, external_id)
);

CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255),
    title VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    source VARCHAR(50) NOT NULL,
    confidence REAL,
    email_verified_at TIMESTAMPTZ,
    do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
    version INT NOT NULL DEFAULT 1
);

-- Rep edits; the pipeline never writes here
CREATE TABLE field_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE, -- NULL = company field
    field VARCHAR(100) NOT NULL,
    value JSONB NOT NULL,
    scraped_value_at_edit JSONB,                             -- detects "source changed since your edit"
    user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ON field_overrides (company_id, contact_id, field) NULLS NOT DISTINCT
    WHERE superseded_at IS NULL;                             -- one active override per field

CREATE TABLE lead_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    rep_id UUID NOT NULL REFERENCES users(id),
    allocated_by UUID NOT NULL REFERENCES users(id),
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX ON lead_allocations (company_id) WHERE ended_at IS NULL;

CREATE TABLE lead_rep_state (
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    checked_at TIMESTAMPTZ,
    serviced_at TIMESTAMPTZ,
    PRIMARY KEY (company_id, user_id)
);

CREATE TABLE custom_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE company_custom_tags (
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES custom_tags(id) ON DELETE CASCADE,
    added_by UUID NOT NULL REFERENCES users(id),
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, tag_id)
);

-- Stable insights: regenerated only when input_hash changes
CREATE TABLE company_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    business_summary TEXT NOT NULL,
    sales_recommendation TEXT NOT NULL,
    model VARCHAR(100) NOT NULL,
    prompt_version VARCHAR(20) NOT NULL,
    input_hash VARCHAR(64) NOT NULL,                         -- hash of facts, notes, custom fields, prompt version, model
    generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Weather/storm timing layer: per county, rules-based, joined at read time
CREATE TABLE regional_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    county_fips CHAR(5) NOT NULL,
    kind VARCHAR(30) NOT NULL,                               -- active_alert | storm_history | news
    payload JSONB NOT NULL,
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON regional_signals (county_fips, kind, valid_to);

CREATE TABLE activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    actor_type VARCHAR(20) NOT NULL,                         -- user | pipeline | system
    user_id UUID REFERENCES users(id),                       -- NULL for pipeline events
    action_type VARCHAR(50) NOT NULL,                        -- note | call | email | visit | checked | override | allocation | scraped_change
    note_text TEXT,
    field_diff JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Written in the same transaction as each change; relayed to Redis Streams
CREATE TABLE outbox_events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,                         -- lead.updated | lead.allocated | note.added | ...
    company_id UUID,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

-- Team/manager roll-up: REFRESH MATERIALIZED VIEW CONCURRENTLY on the Primary every few minutes;
-- replicas serve the replicated result.
-- Per-rep counters: COUNT over companies WHERE assigned_rep_id = :me LEFT JOIN lead_rep_state (company_id, :me);
-- unchecked = checked_at IS NULL OR checked_at < last_material_change_at; unserviced = serviced_at IS NULL.
-- Cached in Redis per user.
CREATE MATERIALIZED VIEW team_dashboard_kpis AS
SELECT
    assigned_rep_id,                                         -- NULL row = unallocated pool
    COUNT(*) AS lead_count,
    COUNT(*) FILTER (WHERE team_last_serviced_at IS NULL) AS unserviced_count,
    COUNT(*) FILTER (WHERE team_last_checked_at IS NULL
                        OR team_last_checked_at < last_material_change_at) AS unchecked_count,
    COUNT(*) FILTER (WHERE updated_in_last_poll) AS recent_updates_count
FROM companies GROUP BY assigned_rep_id;
CREATE UNIQUE INDEX ON team_dashboard_kpis (assigned_rep_id);  -- required for CONCURRENTLY

-- The ingestion tables already built in the Python pipeline (scrape_runs, search_hits, reviews,
-- enrichments, jobs, schedules, audit_events, accounts) are not repeated here; they move to company_id
-- with this schema. The existing contractors table becomes companies + company_source_ids (source = 'gaf'),
-- and existing contacts rows migrate into the new contacts table.
```

---

## 6. Frontend UI Workflow

- **Dashboard View:** Displays top-level KPI counters (served from Read Replicas/Materialized Views and Redis), a map of assigned leads, local weather/news, and a daily AI territory briefing.
- **CRM List View:** Sortable table (priority score by default) showing each lead's top ranking reasons, with toggleable tag visibility so custom tags do not clutter the screen, and a My Leads / Unallocated switch.
- **Lead Profile View:** Shows merged contact info (with badges indicating rep-edited fields and "source changed since your edit"), pre-generated AI insights, weather demand impact, custom slots, and the multi-user notes feed.
- **Allocation View (Managers):** The unallocated queue, bulk assignment of a filtered list, and suggestions to approve.
- **Persistent AI Widget:** Floating bottom-right chat drawer accessible across all views.

---

## 7. AI Engine

- **Batch Pre-Generation (Pipeline):**
  - Extracts structured tags and custom slot values from unstructured website text (custom slots are experimental and will be dropped if extraction quality is poor). LLM-extracted slot values are stored under `scraped_attributes`; a rep's correction goes through `field_overrides`.
  - Generates a business summary and sales pitch from the stored company facts, rep notes and custom fields. These are regenerated only when `input_hash` (those inputs + prompt version + model) changes.
- **Weather Timing Layer (separate and cheap):**
  - Per county, rules combine active alerts and storm history with each lead's specialties into a timing badge and a one-line reason (e.g., pitching emergency repair stock to storm-restoration roofers before a storm, while flagging weather delays for new-build contractors).
  - Computed on a schedule per county and joined at read time, so weather changes never regenerate summaries.
- **Model Providers:** One model interface over multiple providers (e.g., Anthropic Claude, Google Gemini), selected by configuration and API key, so the batch pipeline and the assistant can switch models without code changes.
- **On-Demand Assistant (UI):**
  - **Profile Q&A:** Answers rep questions by reading only the active lead's profile and notes through the Query service, which rejects leads the user can't view.
  - **UI Filter Control:** Uses LLM tool calling (`applyListFilters`) to convert natural language requests into a `LeadFilter`. The Query service applies the user's visibility rule, so the assistant can never show leads the user can't see.

---

## 8. Deployment

- **Production:** Built to be hosted. Every service and worker is a container; Postgres (primary + replicas) and Redis are managed services; secrets live in a secrets manager.
- **Security (production):** Single sign-on via OIDC, with Postgres row-level security as defence in depth behind the visibility rule.
- **Local:** `docker compose up` runs Postgres, Redis, the services, the web app and the pipeline worker, seeded from `data/leadmaker.db`.
- **Prototype swaps (approved):** BBB profile scraping (production: BBB API); Google Places keyless map link (production: Places API key); a single Postgres primary (production: primary + replicas + PgBouncer); Gemini API free tier for all AI features (production: Anthropic Claude, Haiku 5.5 for batch work, via the same model interface). Any other paid-to-free swap needs approval.

---

## 9. Open Questions

- Which local news source to use.
