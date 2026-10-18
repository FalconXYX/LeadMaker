"""Persistence: idempotent upserts and read models over the schema."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import case, create_engine, event, func, inspect, select, text, update
from sqlalchemy.engine import Connection, Engine

from ..models import (
    TIER_RANK,
    Contact,
    Contractor,
    ContractorProfile,
    EnrichmentResult,
    SearchArea,
    SearchHit,
)
from .schema import (
    audit_events,
    contacts,
    contractors,
    enrichments,
    metadata,
    reviews,
    scrape_runs,
    search_hits,
)

CHUNK = 200

# Listing fields worth an audit entry when they change (raw/hash/timestamps excluded).
AUDITED_LISTING_FIELDS = (
    "name", "dba", "address", "phone", "latitude", "longitude", "rating", "review_count", "tier",
    "certifications", "specialties", "presidents_club_stars", "gaf_leads_enrolled", "google_place_id",
    "image_url", "profile_url",
)
AUDITED_PROFILE_FIELDS = ("legal_name", "description", "in_business_since", "employees_range", "distinctions")


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


def _insert_for(conn: Connection):
    if conn.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif conn.dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:  # pragma: no cover
        raise NotImplementedError(f"upsert not implemented for {conn.dialect.name}")
    return insert


def _chunks(rows: Sequence[dict], n: int = CHUNK) -> Iterable[Sequence[dict]]:
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


class Repository:
    def __init__(self, database_url: str):
        if database_url.startswith("sqlite:///"):
            path = database_url.removeprefix("sqlite:///")
            if path and path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.engine: Engine = create_engine(database_url, future=True)
        if self.engine.dialect.name == "sqlite":

            @event.listens_for(self.engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.execute("PRAGMA busy_timeout=5000")
                cur.close()

        # Every entry point (incl. read-only commands on older DB files) sees the current schema.
        self.create_schema()

    def create_schema(self) -> None:
        """Create missing tables, then add any missing columns (additive-only migration).

        Production would use Alembic; this keeps older SQLite files and copies
        working when a nullable column is added to the schema.
        """
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
                have = {i["name"] for i in insp.get_indexes(table.name)}
                for idx in table.indexes:
                    if idx.name not in have:
                        idx.create(conn, checkfirst=True)


    # ----------------------------------------------------------------- audit
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
                "gaf_id": e.get("gaf_id"),
                "action": e["action"],
                "changes": e.get("changes") or {},
                "at": now,
            }
            for e in events
        ]
        for chunk in _chunks(rows):
            conn.execute(audit_events.insert(), list(chunk))

    def audit_log(
        self, gaf_id: str | None = None, run_id: int | None = None, since: datetime | None = None, limit: int = 200
    ) -> list[dict[str, Any]]:
        q = select(audit_events).order_by(audit_events.c.id.desc()).limit(limit)
        if gaf_id:
            q = q.where(audit_events.c.gaf_id == gaf_id)
        if run_id is not None:
            q = q.where(audit_events.c.run_id == run_id)
        if since is not None:
            q = q.where(audit_events.c.at >= since)
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

    def finish_run(self, run_id: int, status: str, stats: dict[str, Any], error: str | None = None) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                update(scrape_runs)
                .where(scrape_runs.c.id == run_id)
                .values(status=status, stats=stats, error=error, finished_at=utcnow())
            )

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(select(scrape_runs).order_by(scrape_runs.c.id.desc()).limit(limit))
            return [dict(r._mapping) for r in rows]

    # ----------------------------------------------------------- contractors
    def upsert_contractors(
        self, items: Sequence[Contractor], seen_at: datetime | None = None, run_id: int | None = None
    ) -> dict[str, int]:
        """Insert or refresh listing data. Returns counts of new / changed / unchanged.

        Every new contractor and every changed audited field is written to audit_events.
        """
        seen_at = seen_at or utcnow()
        rows = []
        for c in items:
            listing = c.model_dump(mode="json", exclude={"raw"})
            h = stable_hash(listing)
            rows.append(
                {
                    **{k: v for k, v in listing.items()},
                    "tier": c.tier.value,
                    "tier_rank": TIER_RANK[c.tier],
                    "raw": c.raw,
                    "content_hash": h,
                    "first_seen_at": seen_at,
                    "last_seen_at": seen_at,
                    "listing_updated_at": seen_at,
                }
            )
        counts = {"new": 0, "changed": 0, "unchanged": 0}
        if not rows:
            return counts
        with self.engine.begin() as conn:
            cols = [contractors.c.gaf_id, contractors.c.content_hash] + [
                contractors.c[f] for f in AUDITED_LISTING_FIELDS
            ]
            existing: dict[str, dict[str, Any]] = {}
            ids = [r["gaf_id"] for r in rows]
            for i in range(0, len(ids), 500):
                for r in conn.execute(select(*cols).where(contractors.c.gaf_id.in_(ids[i : i + 500]))):
                    existing[r.gaf_id] = dict(r._mapping)
            events: list[dict[str, Any]] = []
            for r in rows:
                prev = existing.get(r["gaf_id"])
                if prev is None:
                    counts["new"] += 1
                    events.append({"entity_type": "contractor", "entity_id": r["gaf_id"], "gaf_id": r["gaf_id"],
                                   "action": "created", "changes": {"name": [None, r["name"]],
                                                                    "tier": [None, r["tier"]]}})
                elif prev["content_hash"] != r["content_hash"]:
                    counts["changed"] += 1
                    changes = diff_fields(prev, r, AUDITED_LISTING_FIELDS)
                    if changes:
                        events.append({"entity_type": "contractor", "entity_id": r["gaf_id"],
                                       "gaf_id": r["gaf_id"], "action": "updated", "changes": changes})
                else:
                    counts["unchanged"] += 1
            insert = _insert_for(conn)
            listing_cols = [
                k for k in rows[0] if k not in {"gaf_id", "first_seen_at", "listing_updated_at"}
            ]
            for chunk in _chunks(rows):
                stmt = insert(contractors).values(list(chunk))
                ex = stmt.excluded
                set_ = {k: ex[k] for k in listing_cols}
                set_["listing_updated_at"] = case(
                    (contractors.c.content_hash != ex.content_hash, ex.listing_updated_at),
                    else_=contractors.c.listing_updated_at,
                )
                conn.execute(stmt.on_conflict_do_update(index_elements=["gaf_id"], set_=set_))
            self._audit(conn, events, run_id)
        return counts

    def record_delisted(self, run_id: int, area: SearchArea, current_ids: Sequence[str]) -> list[str]:
        """Contractors present in this area's previous run but missing now (left GAF or moved)."""
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
            prev_ids = {r.gaf_id for r in conn.execute(select(search_hits.c.gaf_id).where(search_hits.c.run_id == prev_run))}
            gone = sorted(prev_ids - set(current_ids))
            self._audit(conn, [
                {"entity_type": "area", "entity_id": g, "gaf_id": g, "action": "delisted",
                 "changes": {"area": [f"{area.postal_code}@{area.radius_miles}mi", None], "previous_run": [prev_run, None]}}
                for g in gone
            ], run_id)
            return gone

    def record_search_hits(self, run_id: int, area: SearchArea, hits: Sequence[SearchHit]) -> None:
        if not hits:
            return
        now = utcnow()
        rows = [
            {
                "run_id": run_id,
                "gaf_id": h.gaf_id,
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
                conn.execute(stmt.on_conflict_do_nothing(index_elements=["run_id", "gaf_id"]))

    # --------------------------------------------------------------- profiles
    def profiles_due(self, gaf_ids: Sequence[str], ttl_hours: float, force: bool = False) -> list[str]:
        if force:
            return list(gaf_ids)
        cutoff = utcnow() - timedelta(hours=ttl_hours)
        with self.engine.connect() as conn:
            fresh = {
                r.gaf_id
                for r in conn.execute(
                    select(contractors.c.gaf_id, contractors.c.profile_scraped_at).where(
                        contractors.c.gaf_id.in_(list(gaf_ids))
                    )
                )
                if r.profile_scraped_at is not None and as_utc(r.profile_scraped_at) >= cutoff
            }
        return [g for g in gaf_ids if g not in fresh]

    def save_profile(
        self, profile: ContractorProfile, scraped_at: datetime | None = None, run_id: int | None = None
    ) -> None:
        scraped_at = scraped_at or utcnow()
        new_vals = {
            "legal_name": profile.legal_name,
            "description": profile.description,
            "in_business_since": profile.in_business_since,
            "employees_range": profile.employees_range,
            "distinctions": profile.distinctions,
        }
        with self.engine.begin() as conn:
            prev = conn.execute(
                select(contractors.c.profile_scraped_at, *[contractors.c[f] for f in AUDITED_PROFILE_FIELDS]).where(
                    contractors.c.gaf_id == profile.gaf_id
                )
            ).first()
            events: list[dict[str, Any]] = []
            if prev is not None:
                prevd = dict(prev._mapping)
                changes = diff_fields(prevd, new_vals, AUDITED_PROFILE_FIELDS)
                first = prevd["profile_scraped_at"] is None
                if first or changes:
                    events.append({"entity_type": "profile", "entity_id": profile.gaf_id, "gaf_id": profile.gaf_id,
                                   "action": "created" if first else "updated", "changes": changes})
            conn.execute(
                update(contractors)
                .where(contractors.c.gaf_id == profile.gaf_id)
                .values(
                    legal_name=profile.legal_name,
                    description=profile.description,
                    in_business_since=profile.in_business_since,
                    employees_range=profile.employees_range,
                    distinctions=profile.distinctions,
                    profile_details=profile.details,
                    profile_scraped_at=scraped_at,
                    profile_error=None,
                )
            )
            if profile.reviews:
                insert = _insert_for(conn)
                rows = [
                    {
                        "id": stable_hash(profile.gaf_id, rv.author, rv.published_at, (rv.text or "")[:200]),
                        "gaf_id": profile.gaf_id,
                        "author": rv.author,
                        "rating": rv.rating,
                        "text": rv.text,
                        "published_at": rv.published_at,
                        "source": rv.source,
                        "first_seen_at": scraped_at,
                    }
                    for rv in profile.reviews
                ]
                res = conn.execute(insert(reviews).values(rows).on_conflict_do_nothing(index_elements=["id"]))
                if res.rowcount and res.rowcount > 0 and events is not None:
                    events.append({"entity_type": "reviews", "entity_id": profile.gaf_id, "gaf_id": profile.gaf_id,
                                   "action": "created", "changes": {"new_reviews": [0, res.rowcount]}})
            self._audit(conn, events, run_id)

    def save_profile_error(self, gaf_id: str, error: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(update(contractors).where(contractors.c.gaf_id == gaf_id).values(profile_error=error[:2000]))

    # ------------------------------------------------------------ enrichment
    def enrichments_due(
        self, gaf_ids: Sequence[str], source: str, ttl_hours: float, force: bool = False
    ) -> list[str]:
        if force:
            return list(gaf_ids)
        cutoff = utcnow() - timedelta(hours=ttl_hours)
        with self.engine.connect() as conn:
            fresh = {
                r.gaf_id
                for r in conn.execute(
                    select(enrichments.c.gaf_id, enrichments.c.fetched_at, enrichments.c.status).where(
                        enrichments.c.source == source, enrichments.c.gaf_id.in_(list(gaf_ids))
                    )
                )
                # Errors are always retried; ok/no_match/skipped respect the TTL.
                if r.status != "error" and as_utc(r.fetched_at) >= cutoff
            }
        return [g for g in gaf_ids if g not in fresh]

    def save_enrichment(
        self, gaf_id: str, result: EnrichmentResult, run_id: int | None = None, input_hash: str | None = None
    ) -> None:
        now = result.fetched_at or utcnow()
        row = {
            "gaf_id": gaf_id,
            "source": result.source,
            "status": result.status.value,
            "confidence": result.confidence,
            "data": result.data,
            "website": result.website,
            "source_urls": result.source_urls,
            "error": result.error,
            "run_id": run_id,
            "fetched_at": now,
            "input_hash": input_hash,
        }
        with self.engine.begin() as conn:
            prev = conn.execute(
                select(enrichments.c.status, enrichments.c.website, enrichments.c.confidence, enrichments.c.data).where(
                    enrichments.c.gaf_id == gaf_id, enrichments.c.source == result.source
                )
            ).first()
            events: list[dict[str, Any]] = []
            eid = f"{gaf_id}:{result.source}"
            if prev is None:
                events.append({"entity_type": "enrichment", "entity_id": eid, "gaf_id": gaf_id, "action": "created",
                               "changes": {"status": [None, row["status"]], "website": [None, row["website"]]}})
            else:
                changes = diff_fields(dict(prev._mapping), row, ("status", "website"))
                if abs((prev.confidence or 0) - (row["confidence"] or 0)) >= 0.05:
                    changes["confidence"] = [prev.confidence, row["confidence"]]
                old_data = prev.data or {}
                changed_keys = sorted(k for k in set(old_data) | set(row["data"] or {})
                                      if old_data.get(k) != (row["data"] or {}).get(k))
                if changed_keys:
                    changes["data_keys_changed"] = [None, changed_keys]
                if changes:
                    events.append({"entity_type": "enrichment", "entity_id": eid, "gaf_id": gaf_id,
                                   "action": "updated", "changes": changes})
            insert = _insert_for(conn)
            stmt = insert(enrichments).values(row)
            conn.execute(
                stmt.on_conflict_do_update(
                    index_elements=["gaf_id", "source"],
                    set_={k: stmt.excluded[k] for k in row if k not in {"gaf_id", "source"}},
                )
            )
            if result.contacts:
                events += self._upsert_contacts(conn, gaf_id, result.contacts, now)
            self._audit(conn, events, run_id)

    def _upsert_contacts(
        self, conn: Connection, gaf_id: str, items: Sequence[Contact], now: datetime
    ) -> list[dict[str, Any]]:
        """Upsert people; returns audit events for newly discovered contacts."""
        insert = _insert_for(conn)
        rows = []
        for c in items:
            key = " ".join(c.name.lower().split())
            rows.append(
                {
                    "id": stable_hash(gaf_id, key, c.source),
                    "gaf_id": gaf_id,
                    "name": c.name,
                    "title": c.title,
                    "email": c.email,
                    "phone": c.phone,
                    "source": c.source,
                    "source_url": c.source_url,
                    "confidence": c.confidence,
                    "first_seen_at": now,
                    "last_seen_at": now,
                }
            )
        # De-dupe within the batch (same person mentioned twice by one source).
        rows = list({r["id"]: r for r in rows}.values())
        known = {r.id for r in conn.execute(select(contacts.c.id).where(contacts.c.id.in_([r["id"] for r in rows])))}
        events = [
            {"entity_type": "contact", "entity_id": r["id"], "gaf_id": gaf_id, "action": "created",
             "changes": {"name": [None, r["name"]], "title": [None, r["title"]], "source": [None, r["source"]]}}
            for r in rows if r["id"] not in known
        ]
        stmt = insert(contacts).values(rows)
        conn.execute(
            stmt.on_conflict_do_update(
                index_elements=["id"],
                set_={
                    k: stmt.excluded[k]
                    for k in ("name", "title", "email", "phone", "source_url", "confidence", "last_seen_at")
                },
            )
        )
        return events

    def save_tags(
        self,
        gaf_id: str,
        tags: list[dict[str, Any]],
        segment: str | None,
        priority_score: float | None,
        run_id: int | None = None,
    ) -> None:
        with self.engine.begin() as conn:
            prev = conn.execute(
                select(contractors.c.tags, contractors.c.segment, contractors.c.priority_score, contractors.c.tagged_at)
                .where(contractors.c.gaf_id == gaf_id)
            ).first()
            if prev is not None:
                def keyset(ts: Any) -> set[str]:
                    return {f"{t.get('key')}={t.get('value')}" for t in (ts or []) if isinstance(t, dict)}

                old, new = keyset(prev.tags), keyset(tags)
                changes: dict[str, Any] = {}
                if new - old:
                    changes["tags_added"] = [None, sorted(new - old)]
                if old - new:
                    changes["tags_removed"] = [sorted(old - new), None]
                if prev.segment != segment:
                    changes["segment"] = [prev.segment, segment]
                if priority_score is not None and (prev.priority_score is None or abs(prev.priority_score - priority_score) >= 1):
                    changes["priority_score"] = [prev.priority_score, priority_score]
                if changes:
                    self._audit(conn, [{"entity_type": "tags", "entity_id": gaf_id, "gaf_id": gaf_id,
                                        "action": "created" if prev.tagged_at is None else "updated",
                                        "changes": changes}], run_id)
            conn.execute(
                update(contractors)
                .where(contractors.c.gaf_id == gaf_id)
                .values(tags=tags, segment=segment, priority_score=priority_score, tagged_at=utcnow())
            )

    def set_website(self, gaf_id: str, url: str | None, source: str | None) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                update(contractors)
                .where(contractors.c.gaf_id == gaf_id)
                .values(website=url, website_source=source)
            )

    # ------------------------------------------------------------------ reads
    def latest_area_run(self, postal_code: str, radius_miles: float) -> int | None:
        with self.engine.connect() as conn:
            return conn.execute(
                select(func.max(search_hits.c.run_id)).where(
                    search_hits.c.postal_code == postal_code, search_hits.c.radius_miles == radius_miles
                )
            ).scalar()

    def get_contractors(self, gaf_ids: Sequence[str] | None = None) -> list[dict[str, Any]]:
        q = select(contractors)
        if gaf_ids is not None:
            q = q.where(contractors.c.gaf_id.in_(list(gaf_ids)))
        with self.engine.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(q)]

    def area_gaf_ids(self, postal_code: str, radius_miles: float) -> list[str]:
        run_id = self.latest_area_run(postal_code, radius_miles)
        if run_id is None:
            return []
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(search_hits.c.gaf_id).where(search_hits.c.run_id == run_id).order_by(search_hits.c.rank)
            )
            return [r.gaf_id for r in rows]

    def get_enrichments(self, gaf_ids: Sequence[str]) -> dict[str, dict[str, dict[str, Any]]]:
        out: dict[str, dict[str, dict[str, Any]]] = {}
        with self.engine.connect() as conn:
            for r in conn.execute(select(enrichments).where(enrichments.c.gaf_id.in_(list(gaf_ids)))):
                out.setdefault(r.gaf_id, {})[r.source] = dict(r._mapping)
        return out

    def lead_records(self, postal_code: str | None = None, radius_miles: float | None = None) -> list[dict[str, Any]]:
        """Denormalised lead view (contractor + latest distance + reviews + enrichment + contacts)."""
        run_id = self.latest_area_run(postal_code, radius_miles) if postal_code and radius_miles else None
        with self.engine.connect() as conn:
            if run_id is not None:
                q = (
                    select(contractors, search_hits.c.distance_miles, search_hits.c.rank,
                           search_hits.c.gaf_recommended, search_hits.c.gaf_recommended_rank)
                    .join(search_hits, search_hits.c.gaf_id == contractors.c.gaf_id)
                    .where(search_hits.c.run_id == run_id)
                    .order_by(search_hits.c.rank)
                )
            else:
                q = select(contractors).order_by(contractors.c.tier_rank.desc(), contractors.c.review_count.desc())
            leads = [dict(r._mapping) for r in conn.execute(q)]
            ids = [l["gaf_id"] for l in leads]
            revs: dict[str, list[dict[str, Any]]] = {}
            cons: dict[str, list[dict[str, Any]]] = {}
            enr: dict[str, dict[str, dict[str, Any]]] = {}
            for i in range(0, len(ids), 500):
                part = ids[i : i + 500]
                for r in conn.execute(select(reviews).where(reviews.c.gaf_id.in_(part))):
                    revs.setdefault(r.gaf_id, []).append(dict(r._mapping))
                for r in conn.execute(
                    select(contacts).where(contacts.c.gaf_id.in_(part)).order_by(contacts.c.confidence.desc())
                ):
                    cons.setdefault(r.gaf_id, []).append(dict(r._mapping))
                for r in conn.execute(select(enrichments).where(enrichments.c.gaf_id.in_(part))):
                    enr.setdefault(r.gaf_id, {})[r.source] = dict(r._mapping)
        from ..accounts import accounts_by_gaf_id  # local import: accounts depends on this module

        accts = accounts_by_gaf_id(self)
        for l in leads:
            l.pop("raw", None)
            l["account"] = accts.get(l["gaf_id"])
            l["reviews"] = revs.get(l["gaf_id"], [])
            l["contacts"] = cons.get(l["gaf_id"], [])
            l["enrichment"] = enr.get(l["gaf_id"], {})
        from ..pipeline.signals import lead_timing_badges  # local import: signals depends on this module

        badges = lead_timing_badges(self, leads)
        for l in leads:
            l["timing"] = badges.get(l["gaf_id"], [])
        return leads

    def summary(self) -> dict[str, Any]:
        with self.engine.connect() as conn:
            total = conn.execute(select(func.count()).select_from(contractors)).scalar() or 0
            by_tier = dict(conn.execute(select(contractors.c.tier, func.count()).group_by(contractors.c.tier)).all())
            profiled = conn.execute(
                select(func.count()).select_from(contractors).where(contractors.c.profile_scraped_at.is_not(None))
            ).scalar()
            with_site = conn.execute(
                select(func.count()).select_from(contractors).where(contractors.c.website.is_not(None))
            ).scalar()
            enr = conn.execute(
                select(enrichments.c.source, enrichments.c.status, func.count()).group_by(
                    enrichments.c.source, enrichments.c.status
                )
            ).all()
            n_contacts = conn.execute(select(func.count()).select_from(contacts)).scalar()
            n_reviews = conn.execute(select(func.count()).select_from(reviews)).scalar()
        by_source: dict[str, dict[str, int]] = {}
        for src, st, n in enr:
            by_source.setdefault(src, {})[st] = n
        return {
            "contractors": total,
            "by_tier": by_tier,
            "profiles_scraped": profiled,
            "with_website": with_site,
            "contacts": n_contacts,
            "reviews": n_reviews,
            "enrichment": by_source,
        }
