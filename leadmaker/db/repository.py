"""Persistence: idempotent upserts and read models over the companies schema (db/migrations).

Identity: a lead is a `companies` row keyed by a UUID. Source ids (GAF's contractor id today) live
in company_source_ids; a source hands in its own id, the repository resolves or creates the company,
and every write after that is keyed by company_id.

Ownership: the pipeline writes scraped values only. It never writes field_overrides, custom_fields,
lead_allocations, lead_rep_state, assigned_rep_id or team_last_* (the CRM Write Service owns those),
keeps a contact a rep has edited even when its source stops reporting it, and never touches a contact a
rep created (source 'rep').

Lead state and events, in the same transaction as each change:
  * audit_events (actor_type 'pipeline') for every created / changed / removed fact;
  * activity_logs 'scraped_change' rows (the lead's timeline) for material changes and delistings;
  * outbox_events 'lead.updated' for every company whose visible data changed, and
    'pipeline.run_completed' when a run finishes (a delisting is a 'lead.updated' with delisted=true);
  * last_material_change_at when a material field changes (MATERIAL_FIELDS, the website, contacts);
  * updated_in_last_poll at the end of a complete area read, for the companies that read covered:
    true when new or materially changed since the previous complete read of the area finished.
On Postgres a trigger bumps companies.version when a visible column changes; contact changes are
child rows and a delisting changes no column, so for those the repository bumps the company's version itself.

Read model: lead records keep the pipeline's field names (`name`, `website`, `tags`, and enrichment
rows' `confidence`) for the columns business_name, website_url, system_tags and match_confidence;
`company_id` is the identity and `gaf_id` the GAF source id.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import urllib.parse
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, delete, event, func, inspect, select, text, update
from sqlalchemy.engine import Connection, Engine, make_url

from ..models import (
    TIER_RANK,
    Contact,
    Contractor,
    ContractorProfile,
    EnrichmentResult,
    EnrichmentStatus,
    SearchArea,
    SearchHit,
)
from .schema import (
    REQUIRED_TABLES,
    activity_logs,
    audit_events,
    companies,
    company_source_ids,
    contacts,
    enrichments,
    field_overrides,
    metadata,
    new_id,
    new_ordered_id,
    outbox_events,
    reviews,
    scrape_runs,
    search_hits,
)

log = logging.getLogger(__name__)

CHUNK = 200
GAF = "gaf"

# Contact.source values each enricher writes (default: the enricher's own name).
CONTACT_SOURCES = {"website_crawl": ("website",), "llm_extract": ("llm", "llm_extract")}

# Pipeline field name -> companies column (everything else has the same name).
COMPANY_COLUMNS = {"name": "business_name", "website": "website_url", "tags": "system_tags"}
LEAD_KEYS = {col: key for key, col in COMPANY_COLUMNS.items()}

# Listing fields worth an audit entry when they change (raw/hash/timestamps excluded).
AUDITED_LISTING_FIELDS = (
    "name", "dba", "address", "phone", "latitude", "longitude", "rating", "review_count", "tier",
    "certifications", "specialties", "presidents_club_stars", "gaf_leads_enrolled", "google_place_id",
    "image_url", "profile_url",
)
AUDITED_PROFILE_FIELDS = ("legal_name", "description", "in_business_since", "employees_range", "distinctions")
# A change to one of these makes the lead unchecked again (SystemDesign §5: tier, certifications,
# rating, contact info, website). Contact changes count too.
MATERIAL_FIELDS = frozenset({"tier", "certifications", "rating", "phone", "address", "street", "city", "state",
                             "postal_code", "website"})
MATERIAL_CONTACT_FIELDS = ("name", "title", "email", "phone")
# contacts.source of the people reps add through the CRM Write Service; the pipeline never writes those rows.
REP_SOURCE = "rep"
# run_completed lists the companies a run touched, up to this many.
MAX_EVENT_COMPANY_IDS = 1000


class SchemaError(RuntimeError):
    """The database does not have the schema this pipeline writes (migrations missing, or a Section 1 file)."""


@dataclass(frozen=True)
class PollBaseline:
    """Passed to finish_run for a complete area read. `since` is when the previous complete read of the
    area finished (None for the first one): companies changed after it are 'updated in last poll'."""

    since: datetime | None


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime | None) -> datetime | None:
    """SQLite returns naive datetimes; treat them as UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def stable_hash(*parts: Any) -> str:
    blob = json.dumps(parts, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


def contact_key(company_id: str, name: str, source: str) -> str:
    """contacts.source_key: one row per (company, person, source)."""
    return stable_hash(company_id, " ".join(name.lower().split()), source)


def normalize_url(url: str) -> str:
    """postgres:// and postgresql:// (as the TS services and Prisma write them) -> SQLAlchemy + psycopg."""
    u = make_url(url)
    if u.drivername in ("postgres", "postgresql"):
        u = u.set(drivername="postgresql+psycopg")
    if u.drivername.startswith("postgresql"):
        u = u.difference_update_query(["schema"])  # Prisma-only parameter
    return u.render_as_string(hide_password=False)


def _insert_for(conn: Connection):
    if conn.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif conn.dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:  # pragma: no cover
        raise NotImplementedError(f"upsert not implemented for {conn.dialect.name}")
    return insert


def _chunks(rows: Sequence[Any], n: int = CHUNK) -> Iterable[Sequence[Any]]:
    for i in range(0, len(rows), n):
        yield rows[i : i + n]


def _jsonable(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def diff_fields(old: dict[str, Any], new: dict[str, Any], fields: Iterable[str]) -> dict[str, list[Any]]:
    """{field: [old, new]} for fields whose value changed."""
    out: dict[str, list[Any]] = {}
    for f in fields:
        a, b = old.get(f), new.get(f)
        if a != b:
            out[f] = [_jsonable(a), _jsonable(b)]
    return out


def _col(field: str) -> str:
    return COMPANY_COLUMNS.get(field, field)


def material_change(company_id: str, diff: dict[str, list[Any]]) -> dict[str, Any] | None:
    """A timeline entry for the MATERIAL_FIELDS part of a diff ({field: [old, new]}), keyed by column name."""
    m = {_col(f): v for f, v in sorted(diff.items()) if f in MATERIAL_FIELDS}
    if not m:
        return None
    return {"company_id": company_id, "fields": sorted(m), "from": {f: v[0] for f, v in m.items()},
            "to": {f: v[1] for f, v in m.items()}}


def _contact_brief(c: Any) -> dict[str, Any]:
    return {f: c[f] for f in MATERIAL_CONTACT_FIELDS if c.get(f)}


def fit(table: Any, row: dict[str, Any]) -> dict[str, Any]:
    """Cut scraped strings to their VARCHAR length: Postgres refuses longer ones (SQLite never checks)."""
    for k, v in row.items():
        if isinstance(v, str) and k in table.c:
            n = getattr(table.c[k].type, "length", None)
            if n and len(v) > n:
                row[k] = v[:n]
    return row


def lead_row(row: Any) -> dict[str, Any]:
    """A companies row (plus extra selected columns) as a lead record."""
    d = dict(row._mapping)
    if "id" in d:
        d["company_id"] = d.pop("id")
    for col, key in LEAD_KEYS.items():
        if col in d:
            d[key] = d.pop(col)
    return d


def enrichment_row(row: Any) -> dict[str, Any]:
    d = dict(row._mapping)
    d["confidence"] = d.pop("match_confidence", None)
    return d


def gaf_id_column():
    """The company's GAF id as a correlated subquery (NULL for companies from other sources)."""
    return (
        select(func.min(company_source_ids.c.external_id))
        .where(company_source_ids.c.company_id == companies.c.id, company_source_ids.c.source == GAF)
        .scalar_subquery()
        .label("gaf_id")
    )


def _sqlite_tables(path: str) -> set[str]:
    """Tables of an existing SQLite file, read through an immutable read-only handle (writes nothing at all)."""
    con = sqlite3.connect(f"file:{urllib.parse.quote(path)}?mode=ro&immutable=1", uri=True)
    try:
        return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    finally:
        con.close()


def _legacy_error(where: str) -> SchemaError:
    return SchemaError(
        f"{where} is a Section 1 database (contractors keyed by GAF id). Load it into the companies "
        "schema with `leadmaker import-sqlite <path>`; this file is left unchanged."
    )


class Repository:
    def __init__(self, database_url: str):
        database_url = normalize_url(database_url)
        if database_url.startswith("sqlite:///"):
            path = database_url.removeprefix("sqlite:///")
            if path and path != ":memory:":
                if Path(path).is_file():
                    # Before any connection: connecting would switch a Section 1 file to WAL mode.
                    tables = _sqlite_tables(path)
                    if "contractors" in tables and "companies" not in tables:
                        raise _legacy_error(f"sqlite:///{path}")
                Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.engine: Engine = create_engine(
            database_url, future=True, pool_pre_ping=not database_url.startswith("sqlite"),
            json_serializer=lambda o: json.dumps(o, default=str),
        )
        if self.engine.dialect.name == "sqlite":

            @event.listens_for(self.engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.execute("PRAGMA busy_timeout=5000")
                cur.close()

        self.ensure_schema()

    @property
    def is_postgres(self) -> bool:
        return self.engine.dialect.name == "postgresql"

    def ensure_schema(self) -> None:
        """Postgres: check the dbmate migrations ran (never creates anything). SQLite: create the mirror.

        On SQLite, missing tables are created and missing nullable columns added, so older local files of
        this schema keep working. A Section 1 file (contractors keyed by GAF id) is refused untouched:
        `leadmaker import-sqlite` loads it into this schema instead.
        """
        have = set(inspect(self.engine).get_table_names())
        url = self.engine.url.render_as_string(hide_password=True)
        if self.is_postgres:
            missing = [t for t in REQUIRED_TABLES if t not in have]
            if missing:
                raise SchemaError(
                    f"{url} is missing tables {', '.join(missing)}. The database schema is owned by the dbmate "
                    "migrations in db/migrations: run `npm run db:up` (or scripts/dbmate.sh up) first."
                )
            return
        if "contractors" in have and "companies" not in have:
            raise _legacy_error(url)
        metadata.create_all(self.engine)
        insp = inspect(self.engine)
        with self.engine.begin() as conn:
            for table in metadata.sorted_tables:
                existing = {c["name"] for c in insp.get_columns(table.name)}
                for col in table.columns:
                    if col.name in existing:
                        continue
                    ddl_type = col.type.compile(dialect=self.engine.dialect)
                    conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{col.name}" {ddl_type}'))
            insp = inspect(conn)
            for table in metadata.sorted_tables:
                indexes = {i["name"] for i in insp.get_indexes(table.name)}
                for idx in table.indexes:
                    if idx.name not in indexes:
                        idx.create(conn, checkfirst=True)

    # --------------------------------------------------------------- identity
    def company_ids(self, external_ids: Sequence[str], source: str = GAF) -> dict[str, str]:
        """{external id: company id} for the source ids that map to a company."""
        with self.engine.connect() as conn:
            return self._resolve(conn, source, external_ids)

    def company_id(self, external_id: str, source: str = GAF) -> str | None:
        return self.company_ids([external_id], source).get(external_id)

    @staticmethod
    def _resolve(conn: Connection, source: str, external_ids: Sequence[str]) -> dict[str, str]:
        ids = sorted({str(e) for e in external_ids})
        out: dict[str, str] = {}
        for part in _chunks(ids, 500):
            for r in conn.execute(
                select(company_source_ids.c.external_id, company_source_ids.c.company_id).where(
                    company_source_ids.c.source == source, company_source_ids.c.external_id.in_(list(part))
                )
            ):
                out[r.external_id] = r.company_id
        return out

    # ----------------------------------------------------------- audit/events
    @staticmethod
    def _audit(conn: Connection, events: list[dict[str, Any]], run_id: int | None) -> None:
        if not events:
            return
        now = utcnow()
        rows = [
            {
                "run_id": run_id,
                "entity_type": e["entity_type"],
                "entity_id": e["entity_id"],
                "company_id": e.get("company_id"),
                "action": e["action"],
                "changes": e.get("changes") or {},
                "actor_type": "pipeline",
                "actor_id": None,
                "at": now,
            }
            for e in events
        ]
        for chunk in _chunks(rows):
            conn.execute(audit_events.insert(), list(chunk))

    @staticmethod
    def _activity(conn: Connection, entries: list[dict[str, Any]], run_id: int | None) -> None:
        """activity_logs 'scraped_change' rows: field_diff is the entry without company_id, plus run_id
        ({fields, from, to, run_id} with column names, like the CRM Write Service's rows)."""
        if not entries:
            return
        now = utcnow()
        rows = [
            {
                "company_id": e["company_id"],
                "actor_type": "pipeline",
                "user_id": None,
                "action_type": "scraped_change",
                "field_diff": {**{k: v for k, v in e.items() if k != "company_id"}, "run_id": run_id},
                "created_at": now,
            }
            for e in entries
        ]
        for chunk in _chunks(rows):
            conn.execute(activity_logs.insert(), list(chunk))

    @staticmethod
    def _lead_updated(conn: Connection, changed: dict[str, dict[str, Any]], run_id: int | None, **extra: Any) -> None:
        """One 'lead.updated' outbox event per changed company, carrying its version after the change.

        changed: {company_id: {"fields": set[str], "material": bool}}; extra goes into every payload.
        """
        if not changed:
            return
        ids = sorted(changed)
        versions: dict[str, int] = {}
        for part in _chunks(ids, 500):
            for r in conn.execute(select(companies.c.id, companies.c.version).where(companies.c.id.in_(list(part)))):
                versions[r.id] = int(r.version)
        now = utcnow()
        rows = [
            {
                "event_type": "lead.updated",
                "company_id": cid,
                "payload": {
                    "company_id": cid, "actor_type": "pipeline", "actor_id": None, "version": versions[cid],
                    "run_id": run_id, "fields": sorted(changed[cid]["fields"]),
                    "material": bool(changed[cid]["material"]), **extra,
                },
                "created_at": now,
            }
            for cid in ids if cid in versions
        ]
        for chunk in _chunks(rows):
            conn.execute(outbox_events.insert(), list(chunk))

    @staticmethod
    def _emit(conn: Connection, event_type: str, payload: dict[str, Any], company_id: str | None = None) -> None:
        conn.execute(outbox_events.insert().values(
            event_type=event_type, company_id=company_id, created_at=utcnow(),
            payload={"actor_type": "pipeline", "actor_id": None, **payload},
        ))

    def audit_log(
        self, company_id: str | None = None, run_id: int | None = None, since: datetime | None = None,
        limit: int = 200, *, gaf_id: str | None = None,
    ) -> list[dict[str, Any]]:
        if gaf_id is not None:
            company_id = self.company_id(gaf_id)
            if company_id is None:
                return []
        q = select(audit_events).order_by(audit_events.c.id.desc()).limit(limit)
        if company_id:
            q = q.where(audit_events.c.company_id == company_id)
        if run_id is not None:
            q = q.where(audit_events.c.run_id == run_id)
        if since is not None:
            q = q.where(audit_events.c.at >= since)
        with self.engine.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(q)]

    def outbox(self, event_type: str | None = None, limit: int = 10_000) -> list[dict[str, Any]]:
        """Outbox rows, oldest first (published or not)."""
        q = select(outbox_events).order_by(outbox_events.c.id).limit(limit)
        if event_type:
            q = q.where(outbox_events.c.event_type == event_type)
        with self.engine.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(q)]

    # ------------------------------------------------------------------ runs
    def start_run(self, kind: str, params: dict[str, Any]) -> int:
        with self.engine.begin() as conn:
            res = conn.execute(
                scrape_runs.insert().values(
                    kind=kind, status="running", params=params, stats={}, started_at=utcnow()
                )
            )
            return int(res.inserted_primary_key[0])

    def finish_run(
        self, run_id: int, status: str, stats: dict[str, Any], error: str | None = None,
        *, poll: PollBaseline | None = None, emit: bool = True,
    ) -> None:
        """Close the run and emit pipeline.run_completed. With `poll` (a complete area read), first set
        updated_in_last_poll for the companies the run's search hits cover; stats['poll'] gets the counts.
        emit=False closes the run without the event (the insights run: its per-lead lead.updated events
        already drive cache invalidation, and a run_completed would make clients refetch everything)."""
        complete = poll is not None and status != "failed"
        with self.engine.begin() as conn:
            flipped: list[str] = []
            if complete:
                stats["poll"], flipped = self._mark_poll(conn, run_id, poll)
            conn.execute(
                update(scrape_runs)
                .where(scrape_runs.c.id == run_id)
                .values(status=status, stats=stats, error=error, finished_at=utcnow())
            )
            if not emit:
                return
            kind = conn.execute(select(scrape_runs.c.kind).where(scrape_runs.c.id == run_id)).scalar()
            touched = sorted(set(flipped) | set(conn.execute(
                select(audit_events.c.company_id).where(audit_events.c.run_id == run_id,
                                                        audit_events.c.company_id.is_not(None)).distinct()
            ).scalars()))
            self._emit(conn, "pipeline.run_completed", {
                "run_id": run_id, "kind": kind, "status": status, "complete": complete,
                "changed_companies": len(touched), "company_ids": touched[:MAX_EVENT_COMPANY_IDS],
                "company_ids_truncated": len(touched) > MAX_EVENT_COMPANY_IDS,
            })

    @staticmethod
    def _mark_poll(conn: Connection, run_id: int, poll: PollBaseline) -> tuple[dict[str, int], list[str]]:
        rows = conn.execute(
            select(companies.c.id, companies.c.updated_in_last_poll, companies.c.last_material_change_at)
            .where(companies.c.id.in_(select(search_hits.c.company_id).where(search_hits.c.run_id == run_id)))
        ).all()
        since = as_utc(poll.since)
        want = {
            r.id: since is None or (r.last_material_change_at is not None and as_utc(r.last_material_change_at) > since)
            for r in rows
        }
        flipped = [r.id for r in rows if bool(r.updated_in_last_poll) != want[r.id]]
        for value in (True, False):
            ids = [cid for cid in flipped if want[cid] is value]
            for part in _chunks(ids, 500):
                conn.execute(update(companies).where(companies.c.id.in_(list(part))).values(updated_in_last_poll=value))
        return {"covered": len(rows), "updated_in_last_poll": sum(want.values()), "flag_changed": len(flipped)}, flipped

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(select(scrape_runs).order_by(scrape_runs.c.id.desc()).limit(limit))
            return [dict(r._mapping) for r in rows]

    # ------------------------------------------------------------- companies
    def upsert_contractors(
        self, items: Sequence[Contractor], seen_at: datetime | None = None, run_id: int | None = None
    ) -> dict[str, int]:
        """Insert or refresh GAF listings. Returns counts of new / changed / unchanged.

        A GAF id seen for the first time creates a company and its company_source_ids row. Every new
        company and every changed audited field is written to audit_events and the outbox. A new listing
        without coordinates cannot become a company (location is required) and is counted as no_location.
        """
        seen_at = seen_at or utcnow()
        by_gaf_id = {}
        for c in items:  # one row per GAF id (the last listing wins)
            listing = c.model_dump(mode="json", exclude={"raw"})
            by_gaf_id[c.gaf_id] = (c, listing, stable_hash(listing))
        listings = list(by_gaf_id.values())
        counts = {"new": 0, "changed": 0, "unchanged": 0}
        if not listings:
            return counts
        prev_cols = [companies.c.id, companies.c.content_hash, companies.c.listing_updated_at,
                     companies.c.last_material_change_at] + [companies.c[_col(f)] for f in AUDITED_LISTING_FIELDS]
        with self.engine.begin() as conn:
            if self.is_postgres:  # concurrent scrapes of overlapping areas must not both create a GAF id
                conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('leadmaker.company_source_ids'))"))
            ids = self._resolve(conn, GAF, [c.gaf_id for c in items])
            existing: dict[str, dict[str, Any]] = {}
            for part in _chunks(sorted(set(ids.values())), 500):
                for r in conn.execute(select(*prev_cols).where(companies.c.id.in_(list(part)))):
                    existing[r.id] = lead_row(r)
            rows: list[dict[str, Any]] = []
            links: list[dict[str, Any]] = []
            events: list[dict[str, Any]] = []
            timeline: list[dict[str, Any]] = []
            changed: dict[str, dict[str, Any]] = {}
            no_location: list[str] = []
            for c, listing, h in listings:
                cid = ids.get(c.gaf_id)
                prev = existing.get(cid) if cid else None
                row = fit(companies, {_col(k): v for k, v in listing.items() if k != "gaf_id"})
                row.update(tier=c.tier.value, tier_rank=TIER_RANK[c.tier], raw=c.raw, content_hash=h,
                           first_seen_at=seen_at, last_seen_at=seen_at)
                if prev is None:
                    if c.latitude is None or c.longitude is None:
                        no_location.append(c.gaf_id)
                        continue
                    cid = new_id()
                    ids[c.gaf_id] = cid
                    links.append({"source": GAF, "external_id": c.gaf_id, "company_id": cid, "created_at": seen_at})
                    row.update(id=cid, listing_updated_at=seen_at, last_material_change_at=seen_at)
                    counts["new"] += 1
                    events.append({"entity_type": "company", "entity_id": cid, "company_id": cid, "action": "created",
                                   "changes": {"name": [None, c.name], "tier": [None, row["tier"]],
                                               "gaf_id": [None, c.gaf_id]}})
                    changed[cid] = {"fields": {"created"}, "material": True}
                else:
                    if c.latitude is None or c.longitude is None:  # keep the stored location
                        row.update(latitude=prev["latitude"], longitude=prev["longitude"])
                    row.update(id=cid, listing_updated_at=prev["listing_updated_at"],
                               last_material_change_at=prev["last_material_change_at"])
                    if prev["content_hash"] != h:
                        counts["changed"] += 1
                        diff = diff_fields(prev, {k: listing.get(k) for k in AUDITED_LISTING_FIELDS} | {
                            "latitude": row["latitude"], "longitude": row["longitude"], "tier": row["tier"]},
                            AUDITED_LISTING_FIELDS)
                        material = bool(MATERIAL_FIELDS & set(diff))
                        row["listing_updated_at"] = seen_at
                        if material:
                            row["last_material_change_at"] = seen_at
                            timeline.append(material_change(cid, diff))
                        if diff:
                            events.append({"entity_type": "company", "entity_id": cid, "company_id": cid,
                                           "action": "updated", "changes": diff})
                        changed[cid] = {"fields": set(diff) or {"listing"}, "material": material}
                    else:
                        counts["unchanged"] += 1
                rows.append(row)
            if no_location:
                counts["no_location"] = len(no_location)
                log.warning("%d new GAF listings have no coordinates and were not stored: %s",
                            len(no_location), ", ".join(no_location[:10]))
            insert = _insert_for(conn)
            keep = {"id", "first_seen_at"}
            rows.sort(key=lambda r: r["id"])  # lock rows in id order, as the CRM Write Service does: no deadlocks
            for chunk in _chunks(rows):
                stmt = insert(companies).values(list(chunk))
                conn.execute(stmt.on_conflict_do_update(
                    index_elements=["id"], set_={k: stmt.excluded[k] for k in chunk[0] if k not in keep}))
            for chunk in _chunks(links):
                conn.execute(company_source_ids.insert(), list(chunk))
            self._audit(conn, events, run_id)
            self._activity(conn, timeline, run_id)
            self._lead_updated(conn, changed, run_id)
        return counts

    def record_delisted(self, run_id: int, area: SearchArea, current_gaf_ids: Sequence[str]) -> list[str]:
        """Company ids present in this area's previous run but missing now (left GAF or moved)."""
        with self.engine.begin() as conn:
            prev_run = conn.execute(
                select(func.max(search_hits.c.run_id)).where(
                    search_hits.c.postal_code == area.postal_code,
                    search_hits.c.radius_miles == area.radius_miles,
                    search_hits.c.run_id < run_id,
                )
            ).scalar()
            if prev_run is None:
                return []
            current = set(self._resolve(conn, GAF, current_gaf_ids).values())
            prev_ids = {r.company_id for r in conn.execute(
                select(search_hits.c.company_id).where(search_hits.c.run_id == prev_run))}
            gone = sorted(prev_ids - current)
            where = f"{area.postal_code}@{area.radius_miles}mi"
            self._audit(conn, [
                {"entity_type": "area", "entity_id": g, "company_id": g, "action": "delisted",
                 "changes": {"area": [where, None], "previous_run": [prev_run, None]}}
                for g in gone
            ], run_id)
            self._activity(conn, [{"company_id": g, "fields": ["delisted"], "from": {"delisted": False},
                                   "to": {"delisted": True}, "area": where} for g in gone], run_id)
            # no company column changes, but the profile cached as lead:{id}:v{version} embeds the timeline
            for part in _chunks(gone, 500):
                conn.execute(update(companies).where(companies.c.id.in_(list(part)))
                             .values(version=companies.c.version + 1))
            self._lead_updated(conn, {g: {"fields": {"delisted"}, "material": False} for g in gone}, run_id,
                               delisted=True, area=where)
            return gone

    def record_search_hits(self, run_id: int, area: SearchArea, hits: Sequence[SearchHit]) -> None:
        if not hits:
            return
        now = utcnow()
        rows = [
            {
                "run_id": run_id,
                "company_id": h.company_id,
                "postal_code": area.postal_code,
                "radius_miles": area.radius_miles,
                "distance_miles": h.distance_miles,
                "rank": h.rank,
                "gaf_recommended": h.gaf_recommended,
                "gaf_recommended_rank": h.gaf_recommended_rank,
                "seen_at": now,
            }
            for h in hits
        ]
        with self.engine.begin() as conn:
            insert = _insert_for(conn)
            for chunk in _chunks(rows):
                stmt = insert(search_hits).values(list(chunk))
                conn.execute(stmt.on_conflict_do_nothing(index_elements=["run_id", "company_id"]))

    # --------------------------------------------------------------- profiles
    def profiles_due(self, company_ids: Sequence[str], ttl_hours: float, force: bool = False) -> list[str]:
        if force:
            return list(company_ids)
        cutoff = utcnow() - timedelta(hours=ttl_hours)
        fresh: set[str] = set()
        with self.engine.connect() as conn:
            for part in _chunks(list(company_ids), 500):
                fresh |= {
                    r.id
                    for r in conn.execute(
                        select(companies.c.id, companies.c.profile_scraped_at).where(companies.c.id.in_(list(part)))
                    )
                    if r.profile_scraped_at is not None and as_utc(r.profile_scraped_at) >= cutoff
                }
        return [c for c in company_ids if c not in fresh]

    def save_profile(
        self, company_id: str, profile: ContractorProfile, scraped_at: datetime | None = None,
        run_id: int | None = None,
    ) -> None:
        scraped_at = scraped_at or utcnow()
        new_vals = {
            "legal_name": profile.legal_name,
            "description": profile.description,
            "in_business_since": profile.in_business_since,
            "employees_range": profile.employees_range,
            "distinctions": profile.distinctions,
            "profile_details": profile.details,
        }
        with self.engine.begin() as conn:
            prev = conn.execute(
                select(companies.c.profile_scraped_at, *[companies.c[f] for f in new_vals]).where(
                    companies.c.id == company_id
                )
            ).first()
            if prev is None:
                raise KeyError(f"no company {company_id}")
            prevd = dict(prev._mapping)
            events: list[dict[str, Any]] = []
            changes = diff_fields(prevd, new_vals, AUDITED_PROFILE_FIELDS)
            first = prevd["profile_scraped_at"] is None
            if first or changes:
                events.append({"entity_type": "profile", "entity_id": company_id, "company_id": company_id,
                               "action": "created" if first else "updated", "changes": changes})
            conn.execute(
                update(companies)
                .where(companies.c.id == company_id)
                .values(**fit(companies, dict(new_vals)), profile_scraped_at=scraped_at, profile_error=None)
            )
            if profile.reviews:
                insert = _insert_for(conn)
                rows = [
                    fit(reviews, {
                        # GAF's review identity: hashing the GAF id keeps ids stable across the Section 1 import.
                        "id": stable_hash(profile.gaf_id, rv.author, rv.published_at, (rv.text or "")[:200]),
                        "company_id": company_id,
                        "author": rv.author,
                        "rating": rv.rating,
                        "text": rv.text,
                        "published_at": rv.published_at,
                        "source": rv.source,
                        "first_seen_at": scraped_at,
                    })
                    for rv in profile.reviews
                ]
                # rowcount of an INSERT is only kept on request (SQLAlchemy 2.1, psycopg)
                res = conn.execution_options(preserve_rowcount=True).execute(
                    insert(reviews).values(rows).on_conflict_do_nothing(index_elements=["id"]))
                if res.rowcount and res.rowcount > 0:
                    events.append({"entity_type": "reviews", "entity_id": company_id, "company_id": company_id,
                                   "action": "created", "changes": {"new_reviews": [0, res.rowcount]}})
            self._audit(conn, events, run_id)
            visible = diff_fields(prevd, new_vals, new_vals)
            if visible:
                self._lead_updated(conn, {company_id: {"fields": set(visible), "material": False}}, run_id)

    def save_profile_error(self, company_id: str, error: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(update(companies).where(companies.c.id == company_id).values(profile_error=error[:2000]))

    # ------------------------------------------------------------ enrichment
    def enrichments_due(
        self, company_ids: Sequence[str], source: str, ttl_hours: float, force: bool = False
    ) -> list[str]:
        if force:
            return list(company_ids)
        cutoff = utcnow() - timedelta(hours=ttl_hours)
        fresh: set[str] = set()
        with self.engine.connect() as conn:
            for part in _chunks(list(company_ids), 500):
                fresh |= {
                    r.company_id
                    for r in conn.execute(
                        select(enrichments.c.company_id, enrichments.c.fetched_at, enrichments.c.status).where(
                            enrichments.c.source == source, enrichments.c.company_id.in_(list(part))
                        )
                    )
                    # Errors are always retried; ok/no_match/skipped respect the TTL.
                    if r.status != "error" and as_utc(r.fetched_at) >= cutoff
                }
        return [c for c in company_ids if c not in fresh]

    def save_enrichment(
        self, company_id: str, result: EnrichmentResult, run_id: int | None = None, input_hash: str | None = None
    ) -> None:
        now = result.fetched_at or utcnow()
        row = fit(enrichments, {
            "company_id": company_id,
            "source": result.source,
            "status": result.status.value,
            "match_confidence": result.confidence,
            "data": result.data,
            "website": result.website,
            "source_urls": result.source_urls,
            "error": result.error,
            "run_id": run_id,
            "fetched_at": now,
            "input_hash": input_hash,
        })
        with self.engine.begin() as conn:
            prev = conn.execute(
                select(enrichments.c.status, enrichments.c.website, enrichments.c.match_confidence,
                       enrichments.c.data).where(
                    enrichments.c.company_id == company_id, enrichments.c.source == result.source
                )
            ).first()
            events: list[dict[str, Any]] = []
            eid = f"{company_id}:{result.source}"
            if prev is None:
                events.append({"entity_type": "enrichment", "entity_id": eid, "company_id": company_id,
                               "action": "created",
                               "changes": {"status": [None, row["status"]], "website": [None, row["website"]]}})
            else:
                changes = diff_fields(dict(prev._mapping), row, ("status", "website"))
                if abs((prev.match_confidence or 0) - (row["match_confidence"] or 0)) >= 0.05:
                    changes["confidence"] = [prev.match_confidence, row["match_confidence"]]
                old_data = prev.data or {}
                changed_keys = sorted(k for k in set(old_data) | set(row["data"] or {})
                                      if old_data.get(k) != (row["data"] or {}).get(k))
                if changed_keys:
                    changes["data_keys_changed"] = [None, changed_keys]
                if changes:
                    events.append({"entity_type": "enrichment", "entity_id": eid, "company_id": company_id,
                                   "action": "updated", "changes": changes})
            insert = _insert_for(conn)
            stmt = insert(enrichments).values(row)
            conn.execute(
                stmt.on_conflict_do_update(
                    index_elements=["company_id", "source"],
                    set_={k: stmt.excluded[k] for k in row if k not in {"company_id", "source"}},
                )
            )
            touched = False
            before: list[dict[str, Any]] = []
            after: list[dict[str, Any]] = []
            if result.contacts:
                evs, touched, before, after = self._upsert_contacts(conn, company_id, result.contacts, now)
                events += evs
            if result.status in (EnrichmentStatus.OK, EnrichmentStatus.NO_MATCH):
                evs, removed = self._prune_contacts(conn, company_id, result)
                events += evs
                before += removed
                touched = touched or bool(removed)
            material = bool(before or after)
            if touched:
                # contacts are child rows: bump the company's version here (the trigger only sees company columns),
                # so the cached profile never shows a contact version the CRM Write Service will reject
                values: dict[str, Any] = {"version": companies.c.version + 1}
                if material:
                    values["last_material_change_at"] = utcnow()
                conn.execute(update(companies).where(companies.c.id == company_id).values(**values))
                self._lead_updated(conn, {company_id: {"fields": {"contacts"}, "material": material}}, run_id)
            if material:
                self._activity(conn, [{"company_id": company_id, "fields": ["contacts"], "from": {"contacts": before},
                                       "to": {"contacts": after}}], run_id)
            self._audit(conn, events, run_id)

    def _prune_contacts(
        self, conn: Connection, company_id: str, result: EnrichmentResult
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """A successful read is the source's full answer: drop its people it no longer reports.
        Returns (audit events, the removed contacts as {name, title, email, phone}).

        A contact a rep has edited (any field_overrides row) is kept and logged as 'retained', so a
        re-scrape never deletes a rep's edits; a contact a rep created is never a candidate.
        """
        sources = CONTACT_SOURCES.get(result.source, (result.source,))
        keep = {contact_key(company_id, c.name, c.source) for c in result.contacts}
        gone = [r for r in conn.execute(
            select(contacts.c.id, contacts.c.source_key, contacts.c.source, *[contacts.c[f] for f in MATERIAL_CONTACT_FIELDS])
            .where(contacts.c.company_id == company_id, contacts.c.source.in_(sources),
                   contacts.c.source != REP_SOURCE, contacts.c.source_key.is_not(None)))
                if r.source_key not in keep]
        if not gone:
            return [], []
        edited = set(conn.execute(
            select(field_overrides.c.contact_id).where(field_overrides.c.contact_id.in_([r.id for r in gone]))
        ).scalars())
        removed = [r for r in gone if r.id not in edited]
        if removed:
            conn.execute(delete(contacts).where(contacts.c.id.in_([r.id for r in removed])))
        events = [{"entity_type": "contact", "entity_id": r.source_key, "company_id": company_id,
                   "action": "retained" if r.id in edited else "removed",
                   "changes": ({"reason": [None, "rep edits"]} if r.id in edited else
                               {"name": [r.name, None], "title": [r.title, None], "source": [r.source, None]})}
                  for r in gone]
        return events, [_contact_brief(r._mapping) for r in removed]

    def _upsert_contacts(
        self, conn: Connection, company_id: str, items: Sequence[Contact], now: datetime
    ) -> tuple[list[dict[str, Any]], bool, list[dict[str, Any]], list[dict[str, Any]]]:
        """Upsert people; returns (audit events, whether any contact row changed, and the contact info before
        and after for the people whose info changed, as {name, title, email, phone}).

        A confidence or source_url change is not material, but it bumps the contact's version (trigger) and can
        move the target contact, so the company's version must follow it. Rep-created contacts are never written."""
        insert = _insert_for(conn)
        rows = []
        for c in items:
            if c.source == REP_SOURCE:
                continue
            rows.append(fit(contacts,
                {
                    "id": new_ordered_id(),  # in the source's order: ties in confidence keep it
                    "company_id": company_id,
                    "source_key": contact_key(company_id, c.name, c.source),
                    "name": c.name,
                    "title": c.title,
                    "email": c.email,
                    "phone": c.phone,
                    "source": c.source,
                    "source_url": c.source_url,
                    "confidence": c.confidence,
                    "first_seen_at": now,
                    "last_seen_at": now,
                    "updated_at": now,
                }
            ))
        # De-dupe within the batch (same person mentioned twice by one source).
        rows = list({r["source_key"]: r for r in rows}.values())
        known = {r.source_key: dict(r._mapping) for r in conn.execute(
            select(contacts.c.source_key, contacts.c.source, contacts.c.source_url, contacts.c.confidence,
                   *[contacts.c[f] for f in MATERIAL_CONTACT_FIELDS])
            .where(contacts.c.source_key.in_([r["source_key"] for r in rows])))}
        rows = [r for r in rows if (known.get(r["source_key"]) or {}).get("source") != REP_SOURCE]
        events: list[dict[str, Any]] = []
        before: list[dict[str, Any]] = []
        after: list[dict[str, Any]] = []
        touched = False
        for r in rows:
            prev = known.get(r["source_key"])
            if prev is None:
                events.append({"entity_type": "contact", "entity_id": r["source_key"], "company_id": company_id,
                               "action": "created",
                               "changes": {"name": [None, r["name"]], "title": [None, r["title"]],
                                           "source": [None, r["source"]]}})
                after.append(_contact_brief(r))
            elif (diff := diff_fields(prev, r, MATERIAL_CONTACT_FIELDS)):
                events.append({"entity_type": "contact", "entity_id": r["source_key"], "company_id": company_id,
                               "action": "updated", "changes": diff})
                before.append(_contact_brief(prev))
                after.append(_contact_brief(r))
            elif prev["source_url"] != r["source_url"] or abs(prev["confidence"] - r["confidence"]) > 1e-6:  # REAL
                touched = True
        if not rows:
            return events, False, before, after
        stmt = insert(contacts).values(rows)
        conn.execute(
            stmt.on_conflict_do_update(
                index_elements=["source_key"],
                set_={
                    k: stmt.excluded[k]
                    for k in ("name", "title", "email", "phone", "source_url", "confidence", "last_seen_at")
                },
                where=contacts.c.source != REP_SOURCE,
            )
        )
        return events, touched or bool(events), before, after

    # ------------------------------------------------------------ derived fields
    def save_tags(
        self,
        company_id: str,
        tags: list[dict[str, Any]],
        segment: str | None,
        priority_score: float | None,
        run_id: int | None = None,
        account_status: str | None = None,
    ) -> None:
        if priority_score is not None:
            priority_score = round(float(priority_score), 1)  # NUMERIC(4,1)
        with self.engine.begin() as conn:
            prev = conn.execute(
                select(companies.c.system_tags, companies.c.segment, companies.c.priority_score,
                       companies.c.tagged_at, companies.c.account_status)
                .where(companies.c.id == company_id)
            ).first()
            values: dict[str, Any] = {"system_tags": tags, "segment": segment, "priority_score": priority_score,
                                      "tagged_at": utcnow()}
            if account_status is not None:
                values["account_status"] = account_status
            # before the event, so lead.updated carries the version after the change
            conn.execute(update(companies).where(companies.c.id == company_id).values(**values))
            if prev is not None:
                def keyset(ts: Any) -> set[str]:
                    return {f"{t.get('key')}={t.get('value')}" for t in (ts or []) if isinstance(t, dict)}

                old, new = keyset(prev.system_tags), keyset(tags)
                changes: dict[str, Any] = {}
                if new - old:
                    changes["tags_added"] = [None, sorted(new - old)]
                if old - new:
                    changes["tags_removed"] = [sorted(old - new), None]
                if prev.segment != segment:
                    changes["segment"] = [prev.segment, segment]
                if priority_score is not None and (prev.priority_score is None or abs(prev.priority_score - priority_score) >= 1):
                    changes["priority_score"] = [prev.priority_score, priority_score]
                if account_status is not None and prev.account_status != account_status:
                    changes["account_status"] = [prev.account_status, account_status]
                if changes:
                    self._audit(conn, [{"entity_type": "tags", "entity_id": company_id, "company_id": company_id,
                                        "action": "created" if prev.tagged_at is None else "updated",
                                        "changes": changes}], run_id)
                visible = {k for k, v in (("tags", prev.system_tags != json.loads(json.dumps(tags, default=str))),
                                          ("segment", prev.segment != segment),
                                          ("priority_score", prev.priority_score != priority_score),
                                          ("account_status", "account_status" in changes)) if v}
                if visible:
                    self._lead_updated(conn, {company_id: {"fields": visible, "material": False}}, run_id)

    def set_website(self, company_id: str, url: str | None, source: str | None, run_id: int | None = None) -> None:
        self.update_companies({company_id: {"website": url, "website_source": source}}, run_id=run_id)

    def update_companies(self, updates: dict[str, dict[str, Any]], run_id: int | None = None) -> int:
        """Write pipeline-owned company fields ({company_id: {field: value}}, lead-record field names).

        Only real changes are written, each with an audit event and a lead.updated event; a change to a
        MATERIAL_FIELDS field also sets last_material_change_at and adds a timeline entry. Returns how many
        companies changed.
        """
        if not updates:
            return 0
        fields = sorted({f for vals in updates.values() for f in vals})
        cols = [companies.c[_col(f)] for f in fields]
        now = utcnow()
        with self.engine.begin() as conn:
            prev: dict[str, dict[str, Any]] = {}
            for part in _chunks(sorted(updates), 500):
                for r in conn.execute(select(companies.c.id, *cols).where(companies.c.id.in_(list(part)))):
                    prev[r.id] = lead_row(r)
            events: list[dict[str, Any]] = []
            timeline: list[dict[str, Any]] = []
            changed: dict[str, dict[str, Any]] = {}
            for cid, vals in sorted(updates.items()):  # id order: see upsert_contractors
                if cid not in prev:
                    continue
                diff = diff_fields(prev[cid], vals, vals)
                if not diff:
                    continue
                material = bool(MATERIAL_FIELDS & set(diff))
                values = fit(companies, {_col(f): v for f, v in vals.items()})
                if material:
                    values["last_material_change_at"] = now
                    timeline.append(material_change(cid, diff))
                conn.execute(update(companies).where(companies.c.id == cid).values(**values))
                events.append({"entity_type": "company", "entity_id": cid, "company_id": cid, "action": "updated",
                               "changes": diff})
                changed[cid] = {"fields": set(diff), "material": material}
            self._audit(conn, events, run_id)
            self._activity(conn, timeline, run_id)
            self._lead_updated(conn, changed, run_id)
        return len(changed)

    # ------------------------------------------------------------------ reads
    def latest_area_run(self, postal_code: str, radius_miles: float) -> int | None:
        with self.engine.connect() as conn:
            return conn.execute(
                select(func.max(search_hits.c.run_id)).where(
                    search_hits.c.postal_code == postal_code, search_hits.c.radius_miles == radius_miles
                )
            ).scalar()

    def get_companies(self, company_ids: Sequence[str] | None = None) -> list[dict[str, Any]]:
        """Lead records (companies rows + gaf_id), in the order of company_ids when given."""
        q = select(companies, gaf_id_column())
        with self.engine.connect() as conn:
            if company_ids is None:
                return [lead_row(r) for r in conn.execute(q.order_by(companies.c.first_seen_at, "gaf_id", companies.c.id))]
            by_id: dict[str, dict[str, Any]] = {}
            for part in _chunks(list(company_ids), 500):
                for r in conn.execute(q.where(companies.c.id.in_(list(part)))):
                    d = lead_row(r)
                    by_id[d["company_id"]] = d
        return [by_id[c] for c in company_ids if c in by_id]

    def area_company_ids(self, postal_code: str, radius_miles: float) -> list[str]:
        run_id = self.latest_area_run(postal_code, radius_miles)
        if run_id is None:
            return []
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(search_hits.c.company_id).where(search_hits.c.run_id == run_id).order_by(search_hits.c.rank)
            )
            return [r.company_id for r in rows]

    def get_enrichments(self, company_ids: Sequence[str]) -> dict[str, dict[str, dict[str, Any]]]:
        out: dict[str, dict[str, dict[str, Any]]] = {}
        with self.engine.connect() as conn:
            for part in _chunks(list(company_ids), 500):
                for r in conn.execute(select(enrichments).where(enrichments.c.company_id.in_(list(part)))):
                    out.setdefault(r.company_id, {})[r.source] = enrichment_row(r)
        return out

    def lead_records(self, postal_code: str | None = None, radius_miles: float | None = None) -> list[dict[str, Any]]:
        """Denormalised lead view (company + latest distance + reviews + enrichment + contacts + timing)."""
        run_id = self.latest_area_run(postal_code, radius_miles) if postal_code and radius_miles else None
        if postal_code and radius_miles and run_id is None:
            return []  # area never read: don't fall back to leads from other areas
        with self.engine.connect() as conn:
            if run_id is not None:
                q = (
                    select(companies, gaf_id_column(), search_hits.c.distance_miles, search_hits.c.rank,
                           search_hits.c.gaf_recommended, search_hits.c.gaf_recommended_rank)
                    .join(search_hits, search_hits.c.company_id == companies.c.id)
                    .where(search_hits.c.run_id == run_id)
                    .order_by(search_hits.c.rank)
                )
            else:
                q = select(companies, gaf_id_column()).order_by(
                    companies.c.tier_rank.desc(), companies.c.review_count.desc(), companies.c.id)
            leads = [lead_row(r) for r in conn.execute(q)]
            ids = [l["company_id"] for l in leads]
            revs: dict[str, list[dict[str, Any]]] = {}
            cons: dict[str, list[dict[str, Any]]] = {}
            enr: dict[str, dict[str, dict[str, Any]]] = {}
            for part in _chunks(ids, 500):
                part = list(part)
                for r in conn.execute(select(reviews).where(reviews.c.company_id.in_(part))):
                    revs.setdefault(r.company_id, []).append(dict(r._mapping))
                for r in conn.execute(
                    select(contacts).where(contacts.c.company_id.in_(part))
                    .order_by(contacts.c.confidence.desc(), contacts.c.id)  # ids are time-ordered
                ):
                    cons.setdefault(r.company_id, []).append(dict(r._mapping))
                for r in conn.execute(select(enrichments).where(enrichments.c.company_id.in_(part))):
                    enr.setdefault(r.company_id, {})[r.source] = enrichment_row(r)
        from ..accounts import accounts_by_company_id  # local import: accounts depends on this module

        accts = accounts_by_company_id(self)
        for l in leads:
            cid = l["company_id"]
            l.pop("raw", None)
            l["account"] = accts.get(cid)
            l["reviews"] = revs.get(cid, [])
            l["contacts"] = cons.get(cid, [])
            l["enrichment"] = enr.get(cid, {})
        from ..pipeline.signals import lead_timing_badges  # local import: signals depends on this module

        badges = lead_timing_badges(self, leads)
        for l in leads:
            l["timing"] = badges.get(l["company_id"], [])
        return leads

    def summary(self) -> dict[str, Any]:
        with self.engine.connect() as conn:
            total = conn.execute(select(func.count()).select_from(companies)).scalar() or 0
            by_tier = dict(conn.execute(select(companies.c.tier, func.count()).group_by(companies.c.tier)).all())
            profiled = conn.execute(
                select(func.count()).select_from(companies).where(companies.c.profile_scraped_at.is_not(None))
            ).scalar()
            with_site = conn.execute(
                select(func.count()).select_from(companies).where(companies.c.website_url.is_not(None))
            ).scalar()
            enr = conn.execute(
                select(enrichments.c.source, enrichments.c.status, func.count()).group_by(
                    enrichments.c.source, enrichments.c.status
                )
            ).all()
            n_contacts = conn.execute(select(func.count()).select_from(contacts)).scalar()
            n_reviews = conn.execute(select(func.count()).select_from(reviews)).scalar()
            updated = conn.execute(
                select(func.count()).select_from(companies).where(companies.c.updated_in_last_poll.is_(True))
            ).scalar()
            unpublished = conn.execute(
                select(func.count()).select_from(outbox_events).where(outbox_events.c.published_at.is_(None))
            ).scalar()
        by_source: dict[str, dict[str, int]] = {}
        for src, st, n in enr:
            by_source.setdefault(src, {})[st] = n
        return {
            "companies": total,
            "by_tier": by_tier,
            "profiles_scraped": profiled,
            "with_website": with_site,
            "contacts": n_contacts,
            "reviews": n_reviews,
            "updated_in_last_poll": updated,
            "outbox_unpublished": unpublished,
            "enrichment": by_source,
        }


def company_label(lead: dict[str, Any]) -> str:
    """'<gaf id or short company id> <name>' for logs and reports."""
    ident = lead.get("gaf_id") or str(lead.get("company_id") or "?")[:8]
    return f"{ident} {lead.get('name') or '?'}"
