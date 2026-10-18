"""Relational schema (SQLAlchemy Core). Portable across SQLite (dev) and Postgres (prod).

Design notes
  * `contractors` holds the canonical, de-duplicated entity keyed by GAF's stable
    contractor id. Listing data is overwritten on each run; `content_hash` +
    `listing_updated_at` record when GAF-side data actually changed.
  * Distance is *query-relative*, so it lives in `search_hits` (one row per
    contractor per run), not on the contractor. This lets the same contractor
    appear in many ZIP searches without duplication.
  * Secondary sources land in `enrichments` (one row per contractor x source,
    raw JSON + match confidence + provenance) and people in `contacts`.
    Merging/prioritising happens at read time, so a better source can be added
    later without migrating stored facts.
"""

from __future__ import annotations

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB

# JSON on SQLite (dev), JSONB on Postgres: binary storage, containment operators, GIN-indexable.
JSONType = JSON().with_variant(JSONB(), "postgresql")

metadata = MetaData()

scrape_runs = Table(
    "scrape_runs",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("kind", String(32), nullable=False),  # gaf_ingest | enrich
    Column("status", String(16), nullable=False),  # running | succeeded | partial | failed
    Column("params", JSONType, nullable=False, default=dict),
    Column("stats", JSONType, nullable=False, default=dict),
    Column("error", Text),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("finished_at", DateTime(timezone=True)),
)

contractors = Table(
    "contractors",
    metadata,
    Column("gaf_id", String(32), primary_key=True),
    Column("name", String(255), nullable=False),
    Column("dba", String(255)),
    Column("legal_name", String(255)),
    Column("contractor_type", String(32)),
    Column("address", String(512)),
    Column("street", String(255)),
    Column("city", String(128)),
    Column("state", String(8)),
    Column("postal_code", String(16)),
    Column("country", String(8)),
    Column("phone", String(32)),
    Column("latitude", Float),
    Column("longitude", Float),
    Column("rating", Float),
    Column("review_count", Integer, nullable=False, default=0),
    Column("profile_url", String(512), nullable=False),
    Column("image_url", String(512)),
    Column("tier", String(32), nullable=False),
    Column("tier_rank", Integer, nullable=False, default=0),
    Column("certifications", JSONType, nullable=False, default=list),
    Column("designation_codes", JSONType, nullable=False, default=list),
    Column("specialties", JSONType, nullable=False, default=list),
    Column("presidents_club_stars", Integer, nullable=False, default=0),
    Column("gaf_leads_enrolled", Boolean, nullable=False, default=False),
    Column("google_place_id", String(128)),
    # From the profile page:
    Column("description", Text),
    Column("in_business_since", Integer),
    Column("employees_range", String(64)),
    Column("distinctions", JSONType, nullable=False, default=list),
    Column("profile_details", JSONType, nullable=False, default=dict),
    Column("profile_scraped_at", DateTime(timezone=True)),
    Column("profile_error", Text),
    # Best-known company website (resolved from enrichment sources).
    Column("website", String(512)),
    Column("website_source", String(32)),
    # Derived by leadmaker.tagging (recomputed, never hand-edited):
    Column("tags", JSONType, nullable=False, default=list),
    Column("segment", String(64)),
    Column("priority_score", Float),
    Column("tagged_at", DateTime(timezone=True)),
    Column("county_fips", String(5)),  # 5-digit county FIPS from ZIP; joins to regional_signals
    # Bookkeeping:
    Column("raw", JSONType, nullable=False, default=dict),
    Column("content_hash", String(64), nullable=False),
    Column("first_seen_at", DateTime(timezone=True), nullable=False),
    Column("last_seen_at", DateTime(timezone=True), nullable=False),
    Column("listing_updated_at", DateTime(timezone=True), nullable=False),
)
Index("ix_contractors_state_city", contractors.c.state, contractors.c.city)
Index("ix_contractors_tier_rank", contractors.c.tier_rank)
Index("ix_contractors_postal_code", contractors.c.postal_code)
# Tag filters (`tags @> '[{"key": "gaf_tier", "value": "master_elite"}]'`); Postgres only.
Index("ix_contractors_tags_gin", contractors.c.tags, postgresql_using="gin",
      postgresql_ops={"tags": "jsonb_path_ops"}).ddl_if(dialect="postgresql")

search_hits = Table(
    "search_hits",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("run_id", Integer, ForeignKey("scrape_runs.id", ondelete="CASCADE"), nullable=False),
    Column("gaf_id", String(32), ForeignKey("contractors.gaf_id", ondelete="CASCADE"), nullable=False),
    Column("postal_code", String(16), nullable=False),
    Column("radius_miles", Float, nullable=False),
    Column("distance_miles", Float),
    Column("rank", Integer, nullable=False),
    Column("gaf_recommended", Boolean, nullable=False, default=False),
    Column("gaf_recommended_rank", Integer),
    Column("seen_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("run_id", "gaf_id", name="uq_search_hits_run_gaf"),
)
Index("ix_search_hits_gaf_id", search_hits.c.gaf_id)
Index("ix_search_hits_area", search_hits.c.postal_code, search_hits.c.radius_miles, search_hits.c.run_id)

reviews = Table(
    "reviews",
    metadata,
    Column("id", String(64), primary_key=True),  # content hash -> idempotent re-inserts
    Column("gaf_id", String(32), ForeignKey("contractors.gaf_id", ondelete="CASCADE"), nullable=False),
    Column("author", String(255)),
    Column("rating", Float),
    Column("text", Text),
    Column("published_at", DateTime(timezone=True)),
    Column("source", String(64)),
    Column("first_seen_at", DateTime(timezone=True), nullable=False),
)
Index("ix_reviews_gaf_id", reviews.c.gaf_id)

enrichments = Table(
    "enrichments",
    metadata,
    Column("gaf_id", String(32), ForeignKey("contractors.gaf_id", ondelete="CASCADE"), primary_key=True),
    Column("source", String(32), primary_key=True),
    Column("status", String(16), nullable=False),
    Column("confidence", Float, nullable=False, default=0.0),
    Column("data", JSONType, nullable=False, default=dict),
    Column("website", String(512)),
    Column("source_urls", JSONType, nullable=False, default=list),
    Column("error", Text),
    Column("run_id", Integer, ForeignKey("scrape_runs.id", ondelete="SET NULL")),
    Column("fetched_at", DateTime(timezone=True), nullable=False),
    # Hash of the inputs the enricher saw; a change forces a re-run inside the TTL.
    Column("input_hash", String(64)),
)
Index("ix_enrichments_source_status", enrichments.c.source, enrichments.c.status)

contacts = Table(
    "contacts",
    metadata,
    Column("id", String(64), primary_key=True),  # hash(gaf_id, normalized name, source)
    Column("gaf_id", String(32), ForeignKey("contractors.gaf_id", ondelete="CASCADE"), nullable=False),
    Column("name", String(255), nullable=False),
    Column("title", String(255)),
    Column("email", String(255)),
    Column("phone", String(64)),
    Column("source", String(32), nullable=False),
    Column("source_url", String(512)),
    Column("confidence", Float, nullable=False, default=0.5),
    Column("first_seen_at", DateTime(timezone=True), nullable=False),
    Column("last_seen_at", DateTime(timezone=True), nullable=False),
)
Index("ix_contacts_gaf_id", contacts.c.gaf_id)

# --------------------------------------------------------------------------- audit
# Append-only change log: every created/updated contractor, profile, enrichment,
# contact and tag set, with a field-level diff. Answers "what changed, when, and
# which run did it" without diffing snapshots.
audit_events = Table(
    "audit_events",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("run_id", Integer),  # not an FK: the log must outlive pruned runs
    Column("entity_type", String(32), nullable=False),  # contractor|profile|enrichment|contact|tags|area
    Column("entity_id", String(160), nullable=False),  # gaf_id, or gaf_id:source
    Column("gaf_id", String(32)),
    Column("action", String(16), nullable=False),  # created|updated|delisted
    Column("changes", JSONType, nullable=False, default=dict),  # {field: [old, new]}
    Column("at", DateTime(timezone=True), nullable=False),
)
Index("ix_audit_gaf_id_at", audit_events.c.gaf_id, audit_events.c.at)
Index("ix_audit_run_id", audit_events.c.run_id)
Index("ix_audit_at", audit_events.c.at)

# -------------------------------------------------------------- regional signals
# County-level context (NWS alerts, NOAA storm history, local news). Not per lead:
# leads join on contractors.county_fips at read time, so weather never re-runs per-lead work.
regional_signals = Table(
    "regional_signals",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("county_fips", String(5), nullable=False),
    Column("kind", String(32), nullable=False),  # active_alert | storm_history | news
    Column("source", String(64), nullable=False),  # nws | noaa_storm_events | <news source>
    Column("external_id", String(512), nullable=False),  # alert id / event id / article URL
    Column("payload", JSONType, nullable=False, default=dict),
    Column("valid_from", DateTime(timezone=True)),
    Column("valid_to", DateTime(timezone=True)),
    Column("fetched_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("source", "external_id", "county_fips", name="uq_regional_signals_source_ext"),
)
Index("ix_regional_signals_county_kind", regional_signals.c.county_fips, regional_signals.c.kind,
      regional_signals.c.valid_to)

# --------------------------------------------------------------------- job queue
# A small DB-backed queue so scrape/enrich/tag work can be scheduled, retried and
# spread over workers. Claiming uses an atomic conditional UPDATE (and
# FOR UPDATE SKIP LOCKED on Postgres), so many workers can share one table.
jobs = Table(
    "jobs",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("kind", String(32), nullable=False),  # scrape | enrich | tag | pipeline
    Column("params", JSONType, nullable=False, default=dict),
    Column("dedupe_key", String(200)),  # at most one queued/running job per key
    Column("status", String(16), nullable=False),  # queued|running|succeeded|failed|dead
    Column("priority", Integer, nullable=False, default=100),  # lower runs first
    Column("attempts", Integer, nullable=False, default=0),
    Column("max_attempts", Integer, nullable=False, default=3),
    Column("run_after", DateTime(timezone=True), nullable=False),
    Column("locked_by", String(64)),
    Column("locked_at", DateTime(timezone=True)),
    Column("result", JSONType),
    Column("error", Text),
    Column("schedule_id", Integer),
    Column("requested_by", String(128)),  # user id for on-demand jobs; None for schedules/CLI
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("finished_at", DateTime(timezone=True)),
)
Index("ix_jobs_claim", jobs.c.status, jobs.c.run_after, jobs.c.priority)
Index("ix_jobs_dedupe", jobs.c.dedupe_key, jobs.c.status)
Index("uq_jobs_open_dedupe", jobs.c.dedupe_key, unique=True,
      sqlite_where=jobs.c.status.in_(["queued", "running"]),
      postgresql_where=jobs.c.status.in_(["queued", "running"]))

schedules = Table(
    "schedules",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", String(128), nullable=False, unique=True),
    Column("kind", String(32), nullable=False),
    Column("params", JSONType, nullable=False, default=dict),
    Column("every_hours", Float, nullable=False),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("next_run_at", DateTime(timezone=True), nullable=False),
    Column("last_enqueued_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

# ------------------------------------------------------------ distributor accounts
# The distributor's own customer list (CRM export). Matching it to contractors
# turns "lead" into "existing account" vs "net-new prospect".
accounts = Table(
    "accounts",
    metadata,
    Column("account_id", String(64), primary_key=True),
    Column("name", String(255), nullable=False),
    Column("phone", String(64)),
    Column("postal_code", String(16)),
    Column("city", String(128)),
    Column("state", String(8)),
    Column("status", String(32)),  # e.g. active | inactive | prospect | do_not_contact
    Column("owner_rep", String(128)),
    Column("annual_spend", Float),
    Column("last_order_at", DateTime(timezone=True)),
    Column("extra", JSONType, nullable=False, default=dict),
    Column("gaf_id", String(32), ForeignKey("contractors.gaf_id", ondelete="SET NULL")),
    Column("match_confidence", Float),
    Column("match_method", String(32)),
    Column("imported_at", DateTime(timezone=True), nullable=False),
)
Index("ix_accounts_gaf_id", accounts.c.gaf_id)
