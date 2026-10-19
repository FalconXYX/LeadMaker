"""SQLAlchemy Core mirror of db/migrations (the dbmate SQL files own the Postgres schema).

The pipeline queries Postgres through these Table objects, and `metadata.create_all` builds the same
tables on SQLite for offline tests and local runs. On Postgres nothing here ever creates a table:
the repository checks that the migrations ran and stops if they did not.

Keep it in step with the migrations: tests/test_schema_mirror.py compares every table and column
with db/migrations offline, and tests/pg/test_pg_schema.py compares them with a migrated database.

Deliberate differences from the migrations:
  * GENERATED ... STORED columns are left out (the pipeline never writes them, Postgres keeps them
    current, and SQLite has no equivalent): companies.location (geography from latitude/longitude) and
    the LeadFilter search columns companies.founded_year and companies.tag_facets (TEXT[]). Both schema
    tests list exactly these and check that they are the migrations' generated columns.
  * Postgres-only DDL (triggers, GIN/GiST/trigram indexes, NULLS NOT DISTINCT, the
    team_dashboard_kpis materialized view) is not repeated; SQLite gets plain equivalents where
    one exists.
  * Integer identities become SQLite rowids, and UUID columns are CHAR(32) on SQLite. Python-side
    defaults fill ids and timestamps so both databases behave the same.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    Integer,
    MetaData,
    Numeric,
    PrimaryKeyConstraint,
    String,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB

# JSON on SQLite, JSONB on Postgres.
JSONType = JSON().with_variant(JSONB(), "postgresql")
# UUIDs travel as strings ("8c1e...-...") on both databases.
UUID = Uuid(as_uuid=False)
# BIGINT identities on Postgres; SQLite only auto-numbers an INTEGER PRIMARY KEY.
BigId = BigInteger().with_variant(Integer, "sqlite")


def new_id() -> str:
    return str(uuid.uuid4())


_ordered = threading.Lock()
_last = [0, 0]  # [unix ms, counter] of the newest ordered id


def new_ordered_id() -> str:
    """A UUIDv7 (RFC 9562, counter in rand_a): ids made later sort higher, also within one millisecond.

    contacts use it so ORDER BY id is discovery order, the tie-break the target-contact choice relies on
    (e.g. FMCSA's first officer before the second)."""
    with _ordered:
        ms = time.time_ns() // 1_000_000
        if ms <= _last[0]:
            ms, counter = _last[0], _last[1] + 1
            if counter > 0xFFF:
                ms, counter = ms + 1, 0
        else:
            counter = 0
        _last[0], _last[1] = ms, counter
    rand = int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    return str(uuid.UUID(int=(ms << 80) | (0x7 << 76) | (counter << 64) | (0b10 << 62) | rand))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


ROLES = ("rep", "manager")
ACCOUNT_STATUSES = ("prospect", "existing_customer", "lapsed_customer", "do_not_contact")
SALES_STAGES = ("new", "contacted", "interested", "quoting", "won", "lost")
TASK_TYPES = ("call", "email", "visit", "todo")
ACTOR_TYPES = ("user", "pipeline", "system")
SIGNAL_KINDS = ("active_alert", "storm_history", "news")
RUN_STATUSES = ("running", "succeeded", "partial", "failed")
ENRICHMENT_STATUSES = ("ok", "no_match", "skipped", "error")
JOB_STATUSES = ("queued", "running", "succeeded", "failed", "dead")
EVENT_TYPES = ("lead.updated", "lead.allocated", "note.added", "state.changed", "override.set", "tags.changed",
               "pipeline.run_completed")

metadata = MetaData()

# ------------------------------------------------------------------ 20261018200100_companies
users = Table(
    "users",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("name", String(255), nullable=False),
    Column("email", String(255), nullable=False, unique=True),
    Column("role", String(20), nullable=False, default="rep"),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    CheckConstraint(_in("role", ROLES), name="users_role_check"),
)

# One row per real business, whichever source found it. The pipeline writes the listing, profile,
# tag and lead-state columns; the CRM Write Service writes assigned_rep_id, custom_fields, team_last_*.
companies = Table(
    "companies",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("industry", String(50), nullable=False, default="roofing"),
    Column("business_name", String(255), nullable=False),
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
    Column("website_url", Text),
    Column("website_source", String(32)),
    Column("latitude", Float, nullable=False),
    Column("longitude", Float, nullable=False),
    Column("county_fips", String(5)),
    Column("rating", Float),
    Column("review_count", Integer, nullable=False, default=0),
    Column("profile_url", Text),
    Column("image_url", Text),
    Column("tier", String(32)),
    Column("tier_rank", Integer, nullable=False, default=0),
    Column("certifications", JSONType, nullable=False, default=list),
    Column("designation_codes", JSONType, nullable=False, default=list),
    Column("specialties", JSONType, nullable=False, default=list),
    Column("presidents_club_stars", Integer, nullable=False, default=0),
    Column("gaf_leads_enrolled", Boolean, nullable=False, default=False),
    Column("google_place_id", String(128)),
    Column("description", Text),
    Column("in_business_since", Integer),
    Column("employees_range", String(64)),
    Column("distinctions", JSONType, nullable=False, default=list),
    Column("profile_details", JSONType, nullable=False, default=dict),
    Column("profile_scraped_at", DateTime(timezone=True)),
    Column("profile_error", Text),
    Column("raw", JSONType, nullable=False, default=dict),
    Column("scraped_attributes", JSONType, nullable=False, default=dict),
    Column("system_tags", JSONType, nullable=False, default=list),
    Column("segment", String(20)),
    Column("priority_score", Numeric(4, 1, asdecimal=False)),
    Column("tagged_at", DateTime(timezone=True)),
    Column("assigned_rep_id", UUID, ForeignKey("users.id")),
    Column("account_status", String(30), nullable=False, default="prospect"),
    Column("custom_fields", JSONType, nullable=False, default=dict),
    Column("updated_in_last_poll", Boolean, nullable=False, default=True),
    Column("last_material_change_at", DateTime(timezone=True)),
    Column("team_last_checked_at", DateTime(timezone=True)),
    Column("team_last_serviced_at", DateTime(timezone=True)),
    Column("content_hash", String(64), nullable=False),
    Column("first_seen_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("last_seen_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("listing_updated_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("version", Integer, nullable=False, default=1),
    # 20261018233000_sales_stages_tasks: written by the CRM Write Service only
    Column("sales_stage", String(20), nullable=False, default="new"),
    Column("stage_changed_at", DateTime(timezone=True)),
    Column("last_contacted_at", DateTime(timezone=True)),
    CheckConstraint("latitude BETWEEN -90 AND 90", name="companies_latitude_check"),
    CheckConstraint("longitude BETWEEN -180 AND 180", name="companies_longitude_check"),
    CheckConstraint("priority_score BETWEEN 0 AND 100", name="companies_priority_score_check"),
    CheckConstraint(_in("account_status", ACCOUNT_STATUSES), name="companies_account_status_check"),
    CheckConstraint(_in("sales_stage", SALES_STAGES), name="companies_sales_stage_check"),
)
Index("companies_county_fips_idx", companies.c.county_fips)
Index("companies_postal_code_idx", companies.c.postal_code)
Index("companies_state_city_idx", companies.c.state, companies.c.city)
Index("companies_assigned_rep_priority_idx", companies.c.assigned_rep_id, companies.c.priority_score)
Index("companies_rep_sales_cover_idx", companies.c.assigned_rep_id, companies.c.sales_stage)

# Each source's id (GAF, FMCSA, NY DOS, ...) -> the internal company id
company_source_ids = Table(
    "company_source_ids",
    metadata,
    Column("source", String(50), nullable=False),
    Column("external_id", String(100), nullable=False),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    PrimaryKeyConstraint("source", "external_id"),
)
Index("company_source_ids_company_idx", company_source_ids.c.company_id)

contacts = Table(
    "contacts",
    metadata,
    Column("id", UUID, primary_key=True, default=new_ordered_id),  # time-ordered: ORDER BY id = discovery order
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    # stable hash(company id, normalised name, source): the pipeline's upsert key
    Column("source_key", String(64), unique=True),
    Column("name", String(255)),
    Column("title", String(255)),
    Column("email", String(255)),
    Column("phone", String(64)),
    Column("source", String(50), nullable=False),
    Column("source_url", Text),
    Column("confidence", Float, nullable=False, default=0.5),
    Column("email_verified_at", DateTime(timezone=True)),
    Column("do_not_contact", Boolean, nullable=False, default=False),
    Column("first_seen_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("last_seen_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("version", Integer, nullable=False, default=1),
)
Index("contacts_company_idx", contacts.c.company_id)

# ------------------------------------------------------------------------ 20261018200200_crm
# Written only by the CRM Write Service; mirrored so SQLite tests can prove the pipeline leaves them alone.
field_overrides = Table(
    "field_overrides",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("contact_id", UUID, ForeignKey("contacts.id", ondelete="CASCADE")),
    Column("field", String(100), nullable=False),
    Column("value", JSONType, nullable=False),
    Column("scraped_value_at_edit", JSONType),
    Column("user_id", UUID, ForeignKey("users.id"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("superseded_at", DateTime(timezone=True)),
    Column("superseded_by", UUID, ForeignKey("users.id")),
)
Index("field_overrides_history_idx", field_overrides.c.company_id, field_overrides.c.created_at)

lead_allocations = Table(
    "lead_allocations",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("rep_id", UUID, ForeignKey("users.id"), nullable=False),
    Column("allocated_by", UUID, ForeignKey("users.id"), nullable=False),
    Column("allocated_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("ended_at", DateTime(timezone=True)),
    Column("ended_by", UUID, ForeignKey("users.id")),
    CheckConstraint("ended_at IS NULL OR ended_at >= allocated_at", name="lead_allocations_check"),
)
Index("lead_allocations_one_open", lead_allocations.c.company_id, unique=True,
      sqlite_where=lead_allocations.c.ended_at.is_(None), postgresql_where=lead_allocations.c.ended_at.is_(None))

lead_rep_state = Table(
    "lead_rep_state",
    metadata,
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("user_id", UUID, ForeignKey("users.id"), nullable=False),
    Column("checked_at", DateTime(timezone=True)),
    Column("serviced_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
    PrimaryKeyConstraint("company_id", "user_id"),
)

custom_tags = Table(
    "custom_tags",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("name", String(100), nullable=False, unique=True),
    Column("created_by", UUID, ForeignKey("users.id"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
)

company_custom_tags = Table(
    "company_custom_tags",
    metadata,
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("tag_id", UUID, ForeignKey("custom_tags.id", ondelete="CASCADE"), nullable=False),
    Column("added_by", UUID, ForeignKey("users.id"), nullable=False),
    Column("added_at", DateTime(timezone=True), nullable=False, default=_now),
    PrimaryKeyConstraint("company_id", "tag_id"),
)

company_insights = Table(
    "company_insights",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("business_summary", Text, nullable=False),
    Column("sales_recommendation", Text, nullable=False),
    Column("model", String(100), nullable=False),
    Column("prompt_version", String(20), nullable=False),
    Column("input_hash", String(64), nullable=False),
    Column("generated_at", DateTime(timezone=True), nullable=False, default=_now),
    UniqueConstraint("company_id", "input_hash"),
    # 20261019100000_company_insights_v2 (Section 4 batch insights, leadmaker.insights)
    Column("status", String(16), nullable=False, default="ok"),
    Column("error", Text),
    Column("attempts", Integer, nullable=False, default=1),
    Column("talking_points", JSONType, nullable=False, default=list),
    Column("target_contact", JSONType),
    Column("product_focus", JSONType, nullable=False, default=list),
    Column("cited_facts", JSONType, nullable=False, default=list),
    Column("token_usage", JSONType, nullable=False, default=dict),
    CheckConstraint(_in("status", ("ok", "error")), name="company_insights_status_check"),
)
Index("company_insights_ok_latest_idx", company_insights.c.company_id, company_insights.c.generated_at,
      sqlite_where=company_insights.c.status == "ok", postgresql_where=company_insights.c.status == "ok")

activity_logs = Table(
    "activity_logs",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("actor_type", String(20), nullable=False),
    Column("user_id", UUID, ForeignKey("users.id")),
    Column("action_type", String(50), nullable=False),
    Column("outcome", String(50)),
    Column("note_text", Text),
    Column("field_diff", JSONType),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    CheckConstraint(_in("actor_type", ACTOR_TYPES), name="activity_logs_actor_type_check"),
    CheckConstraint("actor_type <> 'user' OR user_id IS NOT NULL", name="activity_logs_check"),
)

# ---------------------------------------------------------- 20261018200300_signals_and_outbox
# County-level context (NWS alerts, storm history, local news), joined on companies.county_fips at read time.
regional_signals = Table(
    "regional_signals",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("county_fips", String(5), nullable=False),
    Column("kind", String(30), nullable=False),
    Column("source", String(64), nullable=False),
    Column("external_id", String(512), nullable=False),
    Column("payload", JSONType, nullable=False, default=dict),
    Column("valid_from", DateTime(timezone=True)),
    Column("valid_to", DateTime(timezone=True)),
    Column("fetched_at", DateTime(timezone=True), nullable=False, default=_now),
    UniqueConstraint("source", "external_id", "county_fips"),
    CheckConstraint(_in("kind", SIGNAL_KINDS), name="regional_signals_kind_check"),
)
Index("regional_signals_county_kind_idx", regional_signals.c.county_fips, regional_signals.c.kind,
      regional_signals.c.valid_to)

# Written in the same transaction as each change; the relay publishes rows to the Redis Stream 'events'.
outbox_events = Table(
    "outbox_events",
    metadata,
    Column("id", BigId, Identity(always=True), primary_key=True),
    Column("event_type", String(50), nullable=False),
    Column("company_id", UUID),
    Column("payload", JSONType, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("published_at", DateTime(timezone=True)),
    CheckConstraint(_in("event_type", EVENT_TYPES), name="outbox_events_event_type_check"),
    # Postgres checks payload->>'actor_type' in the migration; the same rule for SQLite:
    CheckConstraint(f"COALESCE(json_extract(payload, '$.actor_type'), '') IN ({', '.join(repr(a) for a in ACTOR_TYPES)})",
                    name="outbox_events_payload_check").ddl_if(dialect="sqlite"),
)

# ------------------------------------------------------------------- 20261018200400_pipeline
scrape_runs = Table(
    "scrape_runs",
    metadata,
    Column("id", Integer, Identity(), primary_key=True),
    Column("kind", String(32), nullable=False),  # gaf_ingest | enrich | tag | signals | crm_import | sqlite_import
    Column("status", String(16), nullable=False),
    Column("params", JSONType, nullable=False, default=dict),
    Column("stats", JSONType, nullable=False, default=dict),
    Column("error", Text),
    Column("started_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("finished_at", DateTime(timezone=True)),
    CheckConstraint(_in("status", RUN_STATUSES), name="scrape_runs_status_check"),
)

# Distance is query-relative, so it lives here (one row per company per run), not on the company.
search_hits = Table(
    "search_hits",
    metadata,
    Column("id", Integer, Identity(), primary_key=True),
    Column("run_id", Integer, ForeignKey("scrape_runs.id", ondelete="CASCADE"), nullable=False),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("postal_code", String(16), nullable=False),
    Column("radius_miles", Float, nullable=False),
    Column("distance_miles", Float),
    Column("rank", Integer, nullable=False),
    Column("gaf_recommended", Boolean, nullable=False, default=False),
    Column("gaf_recommended_rank", Integer),
    Column("seen_at", DateTime(timezone=True), nullable=False, default=_now),
    UniqueConstraint("run_id", "company_id"),
)
Index("search_hits_company_idx", search_hits.c.company_id)
Index("search_hits_area_idx", search_hits.c.postal_code, search_hits.c.radius_miles, search_hits.c.run_id)

reviews = Table(
    "reviews",
    metadata,
    Column("id", String(64), primary_key=True),  # content hash -> idempotent re-inserts
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("author", String(255)),
    Column("rating", Float),
    Column("text", Text),
    Column("published_at", DateTime(timezone=True)),
    Column("source", String(64)),
    Column("first_seen_at", DateTime(timezone=True), nullable=False, default=_now),
)
Index("reviews_company_idx", reviews.c.company_id)

# One row per company x secondary source: raw result, match confidence and provenance.
enrichments = Table(
    "enrichments",
    metadata,
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("source", String(32), nullable=False),
    Column("status", String(16), nullable=False),
    Column("match_confidence", Float, nullable=False, default=0.0),
    Column("data", JSONType, nullable=False, default=dict),
    Column("website", Text),
    Column("source_urls", JSONType, nullable=False, default=list),
    Column("error", Text),
    Column("run_id", Integer, ForeignKey("scrape_runs.id", ondelete="SET NULL")),
    Column("fetched_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("input_hash", String(64)),  # inputs the enricher saw; a change forces a re-run inside the TTL
    PrimaryKeyConstraint("company_id", "source"),
    CheckConstraint(_in("status", ENRICHMENT_STATUSES), name="enrichments_status_check"),
)
Index("enrichments_source_status_idx", enrichments.c.source, enrichments.c.status)

# Append-only pipeline change log with field-level diffs. run_id and company_id are not FKs:
# the log outlives pruned runs and deleted companies.
audit_events = Table(
    "audit_events",
    metadata,
    Column("id", BigId, Identity(), primary_key=True),
    Column("run_id", Integer),
    Column("entity_type", String(32), nullable=False),  # company|profile|reviews|enrichment|contact|tags|area|accounts
    Column("entity_id", String(160), nullable=False),  # company id, company_id:source, or a contact's source_key
    Column("company_id", UUID),
    Column("action", String(16), nullable=False),  # created|updated|removed|retained|delisted
    Column("changes", JSONType, nullable=False, default=dict),  # {field: [old, new]}
    Column("actor_type", String(20), nullable=False, default="pipeline"),
    Column("actor_id", UUID),
    Column("at", DateTime(timezone=True), nullable=False, default=_now),
    CheckConstraint(_in("actor_type", ACTOR_TYPES), name="audit_events_actor_type_check"),
)
Index("audit_events_company_at_idx", audit_events.c.company_id, audit_events.c.at)
Index("audit_events_run_idx", audit_events.c.run_id)
Index("audit_events_at_idx", audit_events.c.at)

schedules = Table(
    "schedules",
    metadata,
    Column("id", Integer, Identity(), primary_key=True),
    Column("name", String(128), nullable=False, unique=True),
    Column("kind", String(32), nullable=False),
    Column("params", JSONType, nullable=False, default=dict),
    Column("every_hours", Float, nullable=False),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("next_run_at", DateTime(timezone=True), nullable=False),
    Column("last_enqueued_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    CheckConstraint("every_hours > 0", name="schedules_every_hours_check"),
)

# DB-backed job queue: workers claim with FOR UPDATE SKIP LOCKED on Postgres.
jobs = Table(
    "jobs",
    metadata,
    Column("id", Integer, Identity(), primary_key=True),
    Column("kind", String(32), nullable=False),  # scrape | enrich | tag | pipeline | signals | insights | briefing
    Column("params", JSONType, nullable=False, default=dict),
    Column("dedupe_key", String(200)),  # at most one queued/running job per key
    Column("status", String(16), nullable=False, default="queued"),
    Column("priority", Integer, nullable=False, default=100),  # lower runs first
    Column("attempts", Integer, nullable=False, default=0),
    Column("max_attempts", Integer, nullable=False, default=3),
    Column("run_after", DateTime(timezone=True), nullable=False, default=_now),
    Column("locked_by", String(64)),
    Column("locked_at", DateTime(timezone=True)),
    Column("result", JSONType),
    Column("error", Text),
    Column("schedule_id", Integer, ForeignKey("schedules.id", ondelete="SET NULL")),
    Column("requested_by", UUID, ForeignKey("users.id")),  # user for on-demand jobs; NULL for schedules/CLI
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("finished_at", DateTime(timezone=True)),
    CheckConstraint(_in("status", JOB_STATUSES), name="jobs_status_check"),
)
Index("jobs_claim_idx", jobs.c.status, jobs.c.run_after, jobs.c.priority)
Index("jobs_open_dedupe_key", jobs.c.dedupe_key, unique=True,
      sqlite_where=jobs.c.status.in_(["queued", "running"]),
      postgresql_where=jobs.c.status.in_(["queued", "running"]))
Index("jobs_requested_by_idx", jobs.c.requested_by, jobs.c.created_at,
      sqlite_where=jobs.c.requested_by.is_not(None), postgresql_where=jobs.c.requested_by.is_not(None))

# The distributor's customer list (CRM import); matching it to companies sets companies.account_status.
accounts = Table(
    "accounts",
    metadata,
    Column("account_id", String(64), primary_key=True),
    Column("name", String(255), nullable=False),
    Column("phone", String(64)),
    Column("postal_code", String(16)),
    Column("city", String(128)),
    Column("state", String(8)),
    Column("status", String(32)),  # active | inactive | prospect | do_not_contact
    Column("owner_rep", String(128)),
    Column("annual_spend", Float),
    Column("last_order_at", DateTime(timezone=True)),
    Column("extra", JSONType, nullable=False, default=dict),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="SET NULL")),
    Column("match_confidence", Float),
    Column("match_method", String(32)),
    Column("imported_at", DateTime(timezone=True), nullable=False, default=_now),
)
Index("accounts_company_idx", accounts.c.company_id)

# ------------------------------------------------------------- 20261018230100_notifications
# Written by services/notifier only; mirrored so both schema tests see every migrated table.
notifications = Table(
    "notifications",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("user_id", UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("type", String(40), nullable=False),
    Column("title", String(255), nullable=False),
    Column("body", Text, nullable=False, default=""),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="SET NULL")),
    Column("county_fips", String(5)),
    Column("data", JSONType, nullable=False, default=dict),
    Column("dedupe_key", String(255), nullable=False),
    Column("count", Integer, nullable=False, default=1),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("read_at", DateTime(timezone=True)),
)

notification_preferences = Table(
    "notification_preferences",
    metadata,
    Column("user_id", UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("type", String(40), nullable=False),
    Column("enabled", Boolean, nullable=False, default=True),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
    PrimaryKeyConstraint("user_id", "type"),
)

notifier_processed_events = Table(
    "notifier_processed_events",
    metadata,
    Column("outbox_id", BigId, primary_key=True, autoincrement=False),
    Column("processed_at", DateTime(timezone=True), nullable=False, default=_now),
)

notifier_state = Table(
    "notifier_state",
    metadata,
    Column("key", String(200), primary_key=True),
    Column("value", JSONType, nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
)

# ------------------------------------------------------------- 20261018230200_saved_views_preferences
# Written by services/crm-write only; mirrored so both schema tests see every migrated table.
saved_views = Table(
    "saved_views",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("user_id", UUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("name", String(100), nullable=False),
    Column("filter", JSONType, nullable=False, default=dict),
    Column("sort", JSONType),
    Column("is_shared", Boolean, nullable=False, default=False),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
    UniqueConstraint("user_id", "name"),
)

user_preferences = Table(
    "user_preferences",
    metadata,
    Column("user_id", UUID, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("prefs", JSONType, nullable=False, default=dict),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("version", Integer, nullable=False, default=1),
)

# ------------------------------------------------------------- 20261018233000_sales_stages_tasks
# Follow-up tasks, written by services/crm-write only; mirrored so both schema tests see every migrated table.
tasks = Table(
    "tasks",
    metadata,
    Column("id", UUID, primary_key=True, default=new_id),
    Column("company_id", UUID, ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
    Column("title", String(200), nullable=False),
    Column("type", String(10), nullable=False, default="todo"),
    Column("due_at", DateTime(timezone=True), nullable=False),
    Column("done_at", DateTime(timezone=True)),
    Column("note", Text),
    Column("assignee_id", UUID, ForeignKey("users.id"), nullable=False),
    Column("created_by", UUID, ForeignKey("users.id"), nullable=False),
    Column("source", String(20), nullable=False, default="user"),
    Column("created_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("updated_at", DateTime(timezone=True), nullable=False, default=_now),
    Column("version", Integer, nullable=False, default=1),
    CheckConstraint("trim(title) <> ''", name="tasks_title_check"),
    CheckConstraint(_in("type", TASK_TYPES), name="tasks_type_check"),
    CheckConstraint("version > 0", name="tasks_version_check"),
)
Index("tasks_assignee_idx", tasks.c.assignee_id, tasks.c.done_at, tasks.c.due_at)
Index("tasks_company_idx", tasks.c.company_id, tasks.c.done_at, tasks.c.due_at)

# ------------------------------------------------------------ 20261019100100_territory_briefs (BRIEFING's tables)
# Written by leadmaker.briefing: the deterministic digest per scope and its cached AI rewrites.
territory_briefs = Table(
    "territory_briefs",
    metadata,
    Column("scope", String(64), primary_key=True),
    Column("digest", JSONType, nullable=False),
    Column("digest_text", Text, nullable=False),
    Column("digest_hash", String(64), nullable=False),
    Column("quiet", Boolean, nullable=False, default=False),
    Column("poll_run_id", Integer, ForeignKey("scrape_runs.id", ondelete="SET NULL")),
    Column("computed_at", DateTime(timezone=True), nullable=False, default=_now),
)
territory_brief_rewrites = Table(
    "territory_brief_rewrites",
    metadata,
    Column("scope", String(64), nullable=False),
    Column("digest_hash", String(64), nullable=False),
    Column("prompt_version", String(20), nullable=False),
    Column("model", String(100), nullable=False),
    Column("ai_text", Text, nullable=False),
    Column("generated_at", DateTime(timezone=True), nullable=False, default=_now),
    PrimaryKeyConstraint("scope", "digest_hash", "prompt_version", "model"),
)
Index("territory_brief_rewrites_scope_idx", territory_brief_rewrites.c.scope, territory_brief_rewrites.c.generated_at)

# Tables the pipeline needs before it may run against a database.
REQUIRED_TABLES = tuple(t.name for t in metadata.sorted_tables)
