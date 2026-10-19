"""Load a Section 1 SQLite database (contractors keyed by GAF id) into the companies schema.

    leadmaker --db postgresql+psycopg://... import-sqlite data/leadmaker.db

The source file is never written: it is copied (with any -wal/-shm) to a temp dir and read there.
Everything lands in one transaction, so a failed import leaves the target as it was.

  * Each contractor becomes a company with a new UUID and a company_source_ids row (source 'gaf');
    enrichments, contacts, reviews, search hits and accounts follow it by company_id.
  * Run, search-hit, schedule, job and audit ids are kept, so the audit history still points at its
    runs; the Postgres identity sequences are moved past them afterwards.
  * Audit entity ids move to the new keys: company id, company_id:source, and the contact's source_key.
    Each imported company also gets a 'created' audit event for the import itself.
  * last_material_change_at is rebuilt from the listing change time and the contact history, and
    updated_in_last_poll from the area's last two complete reads, by the rule the pipeline uses.
  * The import is a scrape_runs row (kind 'sqlite_import') and publishes lead.updated per company plus
    pipeline.run_completed.

Re-running is safe: a contractor whose GAF id already maps to a company is left alone (newer pipeline
data is never overwritten), rows that already exist are skipped, and nothing is written when there is
nothing new. A target whose run ids are taken by different runs is refused.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.engine import Connection

from .repository import GAF, MAX_EVENT_COMPANY_IDS, Repository, _chunks, _insert_for, as_utc, contact_key, fit, utcnow
from .schema import (
    accounts,
    audit_events,
    companies,
    company_source_ids,
    contacts,
    enrichments,
    jobs,
    new_id,
    new_ordered_id,
    regional_signals,
    reviews,
    schedules,
    scrape_runs,
    search_hits,
    users,
)

LEGACY_TABLES = ("scrape_runs", "contractors", "search_hits", "reviews", "enrichments", "contacts", "audit_events",
                 "regional_signals", "jobs", "schedules", "accounts")
JSON_COLUMNS = {
    "scrape_runs": ("params", "stats"),
    "contractors": ("certifications", "designation_codes", "specialties", "distinctions", "profile_details", "tags", "raw"),
    "enrichments": ("data", "source_urls"),
    "audit_events": ("changes",),
    "regional_signals": ("payload",),
    "jobs": ("params", "result"),
    "schedules": ("params",),
    "accounts": ("extra",),
}
TIME_COLUMNS = {
    "scrape_runs": ("started_at", "finished_at"),
    "contractors": ("profile_scraped_at", "tagged_at", "first_seen_at", "last_seen_at", "listing_updated_at"),
    "search_hits": ("seen_at",),
    "reviews": ("published_at", "first_seen_at"),
    "enrichments": ("fetched_at",),
    "contacts": ("first_seen_at", "last_seen_at"),
    "audit_events": ("at",),
    "regional_signals": ("valid_from", "valid_to", "fetched_at"),
    "jobs": ("run_after", "locked_at", "created_at", "finished_at"),
    "schedules": ("next_run_at", "last_enqueued_at", "created_at"),
    "accounts": ("last_order_at", "imported_at"),
}
BOOL_COLUMNS = {"contractors": ("gaf_leads_enrolled",), "search_hits": ("gaf_recommended",), "schedules": ("enabled",)}
# contractors column -> companies column, for the columns that kept their meaning.
COMPANY_COPY = (
    "dba", "legal_name", "contractor_type", "address", "street", "city", "state", "postal_code", "country", "phone",
    "latitude", "longitude", "rating", "review_count", "profile_url", "image_url", "tier", "tier_rank",
    "certifications", "designation_codes", "specialties", "presidents_club_stars", "gaf_leads_enrolled",
    "google_place_id", "description", "in_business_since", "employees_range", "distinctions", "profile_details",
    "profile_scraped_at", "profile_error", "website_source", "segment", "tagged_at", "county_fips", "raw",
    "content_hash", "first_seen_at", "last_seen_at", "listing_updated_at",
)
ID_TABLES = ("scrape_runs", "search_hits", "schedules", "jobs", "audit_events")  # explicit ids kept
COMPANY_ENTITIES = ("company", "profile", "tags", "reviews", "area")
LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('leadmaker.company_source_ids'))"


class SqliteImportError(Exception):
    """The source is not a Section 1 database, or the target cannot take it."""


# ----------------------------------------------------------------------------- read the source
def _copy(src: Path, into: Path) -> Path:
    dst = into / src.name
    shutil.copy2(src, dst)
    for suffix in ("-wal", "-shm"):
        side = src.with_name(src.name + suffix)
        if side.exists():
            shutil.copy2(side, dst.with_name(dst.name + suffix))
    return dst


def _parse_time(v: Any) -> datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return as_utc(v)
    return as_utc(datetime.fromisoformat(str(v)))


def _parse_json(v: Any) -> Any:
    if v is None or not isinstance(v, (str, bytes)):
        return v
    return json.loads(v)


def read_legacy(path: str | Path) -> dict[str, list[dict[str, Any]]]:
    """Every Section 1 table as dict rows with JSON, timestamps (UTC) and booleans decoded."""
    src = Path(path)
    if not src.is_file():
        raise SqliteImportError(f"no such file: {src}")
    with tempfile.TemporaryDirectory() as tmp:
        conn = sqlite3.connect(_copy(src, Path(tmp)))
        try:
            conn.row_factory = sqlite3.Row
            try:
                have = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            except sqlite3.DatabaseError as e:
                raise SqliteImportError(f"{src} is not a SQLite database: {e}") from None
            if "contractors" not in have:
                raise SqliteImportError(f"{src} has no contractors table: not a Section 1 database")
            out: dict[str, list[dict[str, Any]]] = {}
            for table in LEGACY_TABLES:
                # rowid order is insertion order: contacts keep the order their source reported them in
                rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")] if table in have else []
                for r in rows:
                    for c in JSON_COLUMNS.get(table, ()):
                        if c in r:
                            r[c] = _parse_json(r[c])
                    for c in TIME_COLUMNS.get(table, ()):
                        if c in r:
                            r[c] = _parse_time(r[c])
                    for c in BOOL_COLUMNS.get(table, ()):
                        if c in r and r[c] is not None:
                            r[c] = bool(r[c])
                out[table] = rows
        finally:
            conn.close()
    return out


# ------------------------------------------------------------------------------------- helpers
def _insert_new(conn: Connection, table: Any, rows: list[dict[str, Any]]) -> int:
    """Insert rows, skipping any that collide with an existing key. Returns rows written."""
    n = 0
    insert = _insert_for(conn)
    for chunk in _chunks(rows):
        res = conn.execution_options(preserve_rowcount=True).execute(
            insert(table).values(list(chunk)).on_conflict_do_nothing())
        n += max(res.rowcount or 0, 0)
    return n


def _check_runs(conn: Connection, legacy_runs: list[dict[str, Any]]) -> None:
    ids = [r["id"] for r in legacy_runs]
    if not ids:
        return
    clash = []
    for part in _chunks(ids, 500):
        for r in conn.execute(select(scrape_runs.c.id, scrape_runs.c.kind, scrape_runs.c.started_at)
                              .where(scrape_runs.c.id.in_(list(part)))):
            mine = next(x for x in legacy_runs if x["id"] == r.id)
            if r.kind != mine["kind"] or as_utc(r.started_at) != mine["started_at"]:
                clash.append(r.id)
    if clash:
        raise SqliteImportError(
            f"the target already has different runs with ids {clash[:10]}; import Section 1 data into a database "
            "before the pipeline writes runs to it (run ids are kept so audit history stays linked)")


def _complete_areas(legacy: dict[str, list[dict[str, Any]]]) -> dict[tuple[str, float], list[dict[str, Any]]]:
    """Complete GAF reads per area, oldest first (the scrape guard's own rule decides 'complete')."""
    from ..pipeline.scrape import _complete_count  # local import: the pipeline depends on this package

    runs = {r["id"]: r for r in legacy["scrape_runs"]}
    areas: dict[tuple[str, float], set[int]] = defaultdict(set)
    for h in legacy["search_hits"]:
        areas[(str(h["postal_code"]), float(h["radius_miles"]))].add(h["run_id"])
    out: dict[tuple[str, float], list[dict[str, Any]]] = {}
    for area, run_ids in areas.items():
        done = [runs[i] for i in sorted(run_ids) if i in runs and runs[i]["kind"] == "gaf_ingest"
                and runs[i]["status"] != "failed" and _complete_count(runs[i].get("stats")) is not None]
        if done:
            out[area] = done
    return out


def _poll_flags(legacy: dict[str, list[dict[str, Any]]], material_at: dict[str, datetime | None]) -> dict[str, bool]:
    """updated_in_last_poll per GAF id: changed after the previous complete read of the area finished."""
    hits_by_run: dict[int, set[str]] = defaultdict(set)
    for h in legacy["search_hits"]:
        hits_by_run[h["run_id"]].add(str(h["gaf_id"]))
    flags: dict[str, bool] = {}
    latest: dict[str, int] = {}
    for done in _complete_areas(legacy).values():
        last = done[-1]
        prev = done[-2] if len(done) > 1 else None
        since = (prev.get("finished_at") or prev["started_at"]) if prev else None
        for gid in hits_by_run[last["id"]]:
            if latest.get(gid, -1) > last["id"]:
                continue  # a newer complete read of another area covers this company
            latest[gid] = last["id"]
            at = material_at.get(gid)
            flags[gid] = since is None or (at is not None and at > since)
    return flags


def _changed_name(changes: dict[str, Any], key: str) -> str | None:
    pair = changes.get(key) or [None, None]
    return next((v for v in pair if v), None) if isinstance(pair, list) else None


def _user_ids(conn: Connection) -> set[str]:
    return set(conn.execute(select(users.c.id)).scalars())


# -------------------------------------------------------------------------------------- import
def import_sqlite(path: str | Path, repo: Repository, *, now: datetime | None = None) -> dict[str, Any]:
    """Import a Section 1 SQLite file into the repository's database. Returns counts."""
    from ..accounts import account_status
    from ..jobs import area_dedupe_key

    src = Path(path)
    url = repo.engine.url
    if url.get_backend_name() == "sqlite" and url.database and Path(url.database).resolve() == src.resolve():
        raise SqliteImportError("the target database is the source file; import into a different database")
    legacy = read_legacy(src)
    started = as_utc(now) or utcnow()
    stats: dict[str, Any] = {"source": str(src), "target": url.render_as_string(hide_password=True)}

    with repo.engine.begin() as conn:
        if repo.is_postgres:
            conn.execute(text(LOCK_SQL))
        _check_runs(conn, legacy["scrape_runs"])
        known = Repository._resolve(conn, GAF, [str(c["gaf_id"]) for c in legacy["contractors"]])

        # Contact history and listing changes rebuild last_material_change_at.
        material_at: dict[str, datetime | None] = {}
        for c in legacy["contractors"]:
            material_at[str(c["gaf_id"])] = c.get("listing_updated_at") or c.get("first_seen_at")
        for e in legacy["audit_events"]:
            gid = e.get("gaf_id")
            if gid and e["entity_type"] == "contact" and e["action"] in ("created", "removed") and e.get("at"):
                material_at[gid] = max(filter(None, (material_at.get(gid), e["at"])))
        flags = _poll_flags(legacy, material_at)
        best_account: dict[str, dict[str, Any]] = {}
        for a in legacy["accounts"]:
            gid = a.get("gaf_id")
            if gid and (gid not in best_account or (a.get("match_confidence") or 0) > (best_account[gid].get("match_confidence") or 0)):
                best_account[gid] = a

        fresh: dict[str, str] = {}
        rows, links, skipped = [], [], []
        for c in legacy["contractors"]:
            gid = str(c["gaf_id"])
            if gid in known:
                continue
            if c.get("latitude") is None or c.get("longitude") is None:
                skipped.append(gid)
                continue
            cid = fresh[gid] = new_id()
            row = {k: c.get(k) for k in COMPANY_COPY}
            row.update(
                id=cid, business_name=c["name"], website_url=c.get("website"), system_tags=c.get("tags") or [],
                priority_score=round(float(c["priority_score"]), 1) if c.get("priority_score") is not None else None,
                certifications=c.get("certifications") or [], designation_codes=c.get("designation_codes") or [],
                specialties=c.get("specialties") or [], distinctions=c.get("distinctions") or [],
                profile_details=c.get("profile_details") or {}, raw=c.get("raw") or {},
                review_count=c.get("review_count") or 0, tier_rank=c.get("tier_rank") or 0,
                presidents_club_stars=c.get("presidents_club_stars") or 0,
                gaf_leads_enrolled=bool(c.get("gaf_leads_enrolled")),
                last_material_change_at=material_at.get(gid), updated_in_last_poll=flags.get(gid, True),
                account_status=account_status(best_account.get(gid), started), updated_at=started,
            )
            for k in ("first_seen_at", "last_seen_at", "listing_updated_at"):
                row[k] = row[k] or started
            rows.append(fit(companies, row))
            links.append({"source": GAF, "external_id": gid, "company_id": cid, "created_at": started})
        mapping = known | fresh

        n: dict[str, int] = {}
        n["scrape_runs"] = _insert_new(conn, scrape_runs, [
            {k: r.get(k) for k in ("id", "kind", "status", "error", "started_at", "finished_at")}
            | {"params": r.get("params") or {}, "stats": r.get("stats") or {}}
            for r in legacy["scrape_runs"]])
        n["schedules"] = _insert_new(conn, schedules, [
            {k: r.get(k) for k in ("id", "name", "kind", "every_hours", "next_run_at", "last_enqueued_at")}
            | {"params": r.get("params") or {}, "enabled": r.get("enabled", True), "created_at": r.get("created_at") or started}
            for r in legacy["schedules"]])
        for chunk in _chunks(rows):
            conn.execute(companies.insert(), list(chunk))
        for chunk in _chunks(links):
            conn.execute(company_source_ids.insert(), list(chunk))

        def child(table: str) -> list[dict[str, Any]]:
            return [r for r in legacy[table] if str(r.get("gaf_id")) in fresh]

        n["search_hits"] = _insert_new(conn, search_hits, [
            {k: h.get(k) for k in ("id", "run_id", "postal_code", "radius_miles", "distance_miles", "rank",
                                   "gaf_recommended_rank")}
            | {"company_id": fresh[str(h["gaf_id"])], "gaf_recommended": bool(h.get("gaf_recommended")),
               "seen_at": h.get("seen_at") or started}
            for h in child("search_hits")])
        n["reviews"] = _insert_new(conn, reviews, [
            {k: r.get(k) for k in ("id", "author", "rating", "text", "published_at", "source")}
            | {"company_id": fresh[str(r["gaf_id"])], "first_seen_at": r.get("first_seen_at") or started}
            for r in child("reviews")])
        n["enrichments"] = _insert_new(conn, enrichments, [
            {k: r.get(k) for k in ("source", "status", "website", "error", "run_id", "input_hash")}
            | {"company_id": fresh[str(r["gaf_id"])], "match_confidence": r.get("confidence") or 0.0,
               "data": r.get("data") or {}, "source_urls": r.get("source_urls") or [],
               "fetched_at": r.get("fetched_at") or started}
            for r in child("enrichments")])
        contact_rows, contact_keys = [], {}
        for r in child("contacts"):
            cid = fresh[str(r["gaf_id"])]
            key = contact_keys[r["id"]] = contact_key(cid, r["name"], r["source"])
            contact_rows.append(fit(contacts,
                {k: r.get(k) for k in ("name", "title", "email", "phone", "source", "source_url")}
                | {"id": new_ordered_id(), "company_id": cid, "source_key": key, "confidence": r.get("confidence") or 0.5,
                   "first_seen_at": r.get("first_seen_at") or started, "last_seen_at": r.get("last_seen_at") or started,
                   "updated_at": r.get("last_seen_at") or started}))
        n["contacts"] = _insert_new(conn, contacts, contact_rows)

        audit_rows = []
        for e in legacy["audit_events"]:
            cid = mapping.get(str(e["gaf_id"])) if e.get("gaf_id") else None
            et = "company" if e["entity_type"] == "contractor" else e["entity_type"]
            eid = str(e["entity_id"])
            if cid and et in COMPANY_ENTITIES:
                eid = cid
            elif cid and et == "enrichment" and ":" in eid:
                eid = f"{cid}:{eid.split(':', 1)[1]}"
            elif cid and et == "contact":
                changes = e.get("changes") or {}
                name, source = _changed_name(changes, "name"), _changed_name(changes, "source")
                eid = contact_key(cid, name, source) if name and source else contact_keys.get(eid, eid)
            audit_rows.append({"id": e["id"], "run_id": e.get("run_id"), "entity_type": et, "entity_id": eid[:160],
                               "company_id": cid, "action": e["action"], "changes": e.get("changes") or {},
                               "actor_type": "pipeline", "actor_id": None, "at": e.get("at") or started})
        n["audit_events"] = _insert_new(conn, audit_events, audit_rows)

        n["regional_signals"] = _insert_new(conn, regional_signals, [
            {k: r.get(k) for k in ("county_fips", "kind", "source", "external_id", "valid_from", "valid_to")}
            | {"id": new_id(), "payload": r.get("payload") or {}, "fetched_at": r.get("fetched_at") or started}
            for r in legacy["regional_signals"]])

        user_ids = _user_ids(conn)
        cleared = 0
        job_rows = []
        for j in legacy["jobs"]:
            requested = j.get("requested_by")
            try:
                requested = str(uuid.UUID(str(requested))) if requested else None
            except ValueError:
                requested = None
            if requested and requested not in user_ids:
                requested = None
            cleared += bool(j.get("requested_by")) and requested is None
            params = j.get("params") or {}
            key = j.get("dedupe_key")
            old_key = f"{j['kind']}:{params.get('postal_code', '*')}:{params.get('radius_miles', '*')}:{params.get('sources') or '*'}"
            if key == old_key:  # Section 1 wrote 25.0 and Python list reprs; use the shared canonical key
                key = area_dedupe_key(j["kind"], params)
            job_rows.append(
                {k: j.get(k) for k in ("id", "kind", "status", "priority", "attempts", "max_attempts", "run_after",
                                       "locked_by", "locked_at", "result", "error", "schedule_id", "finished_at")}
                | {"params": params, "dedupe_key": key, "requested_by": requested,
                   "created_at": j.get("created_at") or started, "run_after": j.get("run_after") or started})
        n["jobs"] = _insert_new(conn, jobs, job_rows)
        n["accounts"] = _insert_new(conn, accounts, [
            {k: a.get(k) for k in ("account_id", "name", "phone", "postal_code", "city", "state", "status", "owner_rep",
                                   "annual_spend", "last_order_at", "match_confidence", "match_method")}
            | {"extra": a.get("extra") or {}, "company_id": mapping.get(str(a["gaf_id"])) if a.get("gaf_id") else None,
               "imported_at": a.get("imported_at") or started}
            for a in legacy["accounts"]])

        if repo.is_postgres:
            for table in ID_TABLES:
                conn.execute(text(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                    f"COALESCE((SELECT MAX(id) FROM {table}), 0) + 1, false)"))

        stats.update(
            companies={"imported": len(fresh), "already_present": len(known), "skipped_no_location": len(skipped)},
            **n, jobs_requested_by_cleared=cleared,
            updated_in_last_poll=sum(1 for r in rows if r["updated_in_last_poll"]),
        )
        if skipped:
            stats["skipped_gaf_ids"] = skipped[:50]
        if not fresh:
            stats["run_id"] = None
            return stats
        run_id = int(conn.execute(scrape_runs.insert().values(
            kind="sqlite_import", status="succeeded", params={"path": str(src)}, stats=stats, started_at=started,
            finished_at=utcnow())).inserted_primary_key[0])
        stats["run_id"] = run_id
        Repository._audit(conn, [
            {"entity_type": "company", "entity_id": cid, "company_id": cid, "action": "created",
             "changes": {"gaf_id": [None, gid], "imported_from": [None, f"section1:{src.name}"]}}
            for gid, cid in fresh.items()], run_id)
        Repository._lead_updated(conn, {cid: {"fields": {"imported"}, "material": True} for cid in fresh.values()}, run_id)
        ids = sorted(fresh.values())
        Repository._emit(conn, "pipeline.run_completed", {
            "run_id": run_id, "kind": "sqlite_import", "status": "succeeded", "complete": True,
            "changed_companies": len(ids), "company_ids": ids[:MAX_EVENT_COMPANY_IDS],
            "company_ids_truncated": len(ids) > MAX_EVENT_COMPANY_IDS,
        })
    return stats
