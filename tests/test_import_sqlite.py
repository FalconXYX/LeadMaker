"""`leadmaker import-sqlite`: a Section 1 SQLite file (contractors keyed by GAF id) lands in the companies schema.

The source is built from the real Section 1 DDL (tests/fixtures/section1_schema.sql) with a few rows of each
table; the target is a fresh SQLite file of the new schema (tests/pg/ runs the same import on Postgres).
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from leadmaker.cli import main
from leadmaker.db import Repository
from leadmaker.db.import_sqlite import SqliteImportError, import_sqlite
from leadmaker.db.repository import contact_key, stable_hash
from leadmaker.db.schema import audit_events, contacts, enrichments, jobs, reviews, scrape_runs, search_hits

from dbutil import cid

FIX = Path(__file__).parent / "fixtures"
T0 = datetime(2026, 10, 18, 6, 0, tzinfo=timezone.utc)


def _ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(tzinfo=None).isoformat(sep=" ")


def _contractor(gaf_id: str, name: str, lat: float | None, lng: float | None, **kw: Any) -> dict[str, Any]:
    row = {
        "gaf_id": gaf_id, "name": name, "dba": None, "legal_name": None, "contractor_type": "Residential",
        "address": "1 Main St, Garfield, NJ 07026", "street": "1 Main St", "city": "Garfield", "state": "NJ",
        "postal_code": "07026", "country": "US", "phone": "(201) 555-0100", "latitude": lat, "longitude": lng,
        "rating": 4.8, "review_count": 12, "profile_url": f"https://www.gaf.com/{gaf_id}", "image_url": None,
        "tier": "master_elite", "tier_rank": 3, "certifications": json.dumps(["GAF Master Elite"]),
        "designation_codes": "[]", "specialties": json.dumps(["METAL"]), "presidents_club_stars": 1,
        "gaf_leads_enrolled": 1, "google_place_id": None, "description": "Roofs", "in_business_since": 2001,
        "employees_range": "6-20", "distinctions": "[]", "profile_details": "{}", "profile_scraped_at": _ts(T0),
        "profile_error": None, "website": "https://roof.example", "website_source": "website_discovery",
        "tags": json.dumps([{"key": "gaf_tier", "value": "master_elite", "reason": "listing", "source": "gaf"}]),
        "segment": "strategic", "priority_score": 72.35, "tagged_at": _ts(T0 + timedelta(hours=9)),
        "raw": json.dumps({"gaf_contractor_id": gaf_id}), "content_hash": "h" + gaf_id,
        "first_seen_at": _ts(T0), "last_seen_at": _ts(T0 + timedelta(hours=12)), "listing_updated_at": _ts(T0),
        "county_fips": "34003",
    }
    row.update(kw)
    return row


def _insert(con: sqlite3.Connection, table: str, rows: list[dict[str, Any]]) -> None:
    for r in rows:
        cols = ", ".join(r)
        con.execute(f"INSERT INTO {table} ({cols}) VALUES ({', '.join('?' * len(r))})", list(r.values()))


def _old_contact_id(gaf_id: str, name: str, source: str) -> str:
    return stable_hash(gaf_id, " ".join(name.lower().split()), source)


def build_legacy(path: Path) -> sqlite3.Connection:
    """A small Section 1 database: two complete reads of 07026, enrichment, contacts, audit, signals, a job."""
    con = sqlite3.connect(path)
    con.executescript((FIX / "section1_schema.sql").read_text())
    complete = json.dumps({"completeness": {"complete": True, "results": 2, "total": 2}, "coveo_total": 2, "results": 2})
    _insert(con, "scrape_runs", [
        {"id": 1, "kind": "gaf_ingest", "status": "succeeded", "params": json.dumps({"postal_code": "07026", "radius_miles": 25.0}),
         "stats": complete, "started_at": _ts(T0), "finished_at": _ts(T0 + timedelta(minutes=10))},
        {"id": 2, "kind": "enrich", "status": "succeeded", "params": "{}", "stats": "{}",
         "started_at": _ts(T0 + timedelta(hours=1)), "finished_at": _ts(T0 + timedelta(hours=2))},
        {"id": 3, "kind": "gaf_ingest", "status": "succeeded", "params": json.dumps({"postal_code": "07026", "radius_miles": 25.0}),
         "stats": complete, "started_at": _ts(T0 + timedelta(hours=12)), "finished_at": _ts(T0 + timedelta(hours=12, minutes=5))},
    ])
    _insert(con, "contractors", [
        _contractor("1001", "Jersey Roofing LLC", 40.88, -74.11),
        _contractor("1002", "Bergen Exteriors", 40.89, -74.12, phone="(201) 555-0199", website=None,
                    website_source=None, priority_score=40.0, segment="growth"),
        _contractor("1003", "No Location Roofing", None, None),
    ])
    for run in (1, 3):
        _insert(con, "search_hits", [
            {"id": run * 10 + i, "run_id": run, "gaf_id": g, "postal_code": "07026", "radius_miles": 25.0,
             "distance_miles": 1.5 + i, "rank": i + 1, "gaf_recommended": int(i == 0), "gaf_recommended_rank": 1 if i == 0 else None,
             "seen_at": _ts(T0)} for i, g in enumerate(("1001", "1002", "1003"))])
    _insert(con, "reviews", [{"id": "rv1", "gaf_id": "1001", "author": "Ann", "rating": 5.0, "text": "Great",
                              "published_at": _ts(T0 - timedelta(days=30)), "source": "gaf", "first_seen_at": _ts(T0)}])
    _insert(con, "enrichments", [
        {"gaf_id": "1001", "source": "bbb", "status": "ok", "confidence": 0.93, "data": json.dumps({"bbb_id": "B1"}),
         "website": "https://roof.example", "source_urls": json.dumps(["https://bbb.example/1"]), "error": None,
         "run_id": 2, "fetched_at": _ts(T0 + timedelta(hours=1)), "input_hash": "ih1"},
        {"gaf_id": "1002", "source": "osm", "status": "no_match", "confidence": 0.0, "data": "{}", "website": None,
         "source_urls": "[]", "error": None, "run_id": 2, "fetched_at": _ts(T0 + timedelta(hours=1)), "input_hash": "ih2"},
    ])
    pat = _old_contact_id("1001", "Pat  Owner", "bbb")
    _insert(con, "contacts", [{"id": pat, "gaf_id": "1001", "name": "Pat  Owner", "title": "Owner", "email": None,
                               "phone": None, "source": "bbb", "source_url": "https://bbb.example/1", "confidence": 0.8,
                               "first_seen_at": _ts(T0 + timedelta(hours=1)), "last_seen_at": _ts(T0 + timedelta(hours=1))}])
    _insert(con, "audit_events", [
        {"id": 1, "run_id": 2, "entity_type": "enrichment", "entity_id": "1001:bbb", "gaf_id": "1001", "action": "created",
         "changes": json.dumps({"status": [None, "ok"]}), "at": _ts(T0 + timedelta(hours=1))},
        {"id": 2, "run_id": 2, "entity_type": "contact", "entity_id": pat, "gaf_id": "1001", "action": "created",
         "changes": json.dumps({"name": [None, "Pat  Owner"], "title": [None, "Owner"], "source": [None, "bbb"]}),
         "at": _ts(T0 + timedelta(hours=1))},
        {"id": 3, "run_id": 2, "entity_type": "contact", "entity_id": _old_contact_id("1002", "Old Person", "osm"),
         "gaf_id": "1002", "action": "removed",
         "changes": json.dumps({"name": ["Old Person", None], "title": [None, None], "source": ["osm", None]}),
         "at": _ts(T0 + timedelta(minutes=5))},
        {"id": 4, "run_id": 3, "entity_type": "contractor", "entity_id": "1002", "gaf_id": "1002", "action": "updated",
         "changes": json.dumps({"review_count": [11, 12]}), "at": _ts(T0 + timedelta(hours=12))},
        {"id": 5, "run_id": None, "entity_type": "area", "entity_id": "9999", "gaf_id": "9999", "action": "delisted",
         "changes": "{}", "at": _ts(T0)},
        {"id": 6, "run_id": 2, "entity_type": "enrichment", "entity_id": "1002:osm", "gaf_id": "1002", "action": "created",
         "changes": json.dumps({"status": [None, "no_match"]}), "at": _ts(T0 + timedelta(hours=1))},
    ])
    _insert(con, "regional_signals", [{"id": 1, "county_fips": "34003", "kind": "storm_history", "source": "noaa_storm_events",
                                       "external_id": "summary_24m", "payload": json.dumps({"events_24m": 3}),
                                       "valid_from": None, "valid_to": None, "fetched_at": _ts(T0)}])
    _insert(con, "schedules", [{"id": 1, "name": "weekly-07026", "kind": "pipeline",
                                "params": json.dumps({"postal_code": "07026", "radius_miles": 25.0}), "every_hours": 168,
                                "enabled": 1, "next_run_at": _ts(T0 + timedelta(days=7)), "last_enqueued_at": None,
                                "created_at": _ts(T0)}])
    _insert(con, "jobs", [{"id": 7, "kind": "scrape", "params": json.dumps({"postal_code": "07026", "radius_miles": 25.0}),
                           "dedupe_key": "scrape:07026:25.0:*", "status": "queued", "priority": 100, "attempts": 0,
                           "max_attempts": 3, "run_after": _ts(T0), "locked_by": None, "locked_at": None,
                           "result": None, "error": None, "schedule_id": 1, "requested_by": "rep42",
                           "created_at": _ts(T0), "finished_at": None}])
    _insert(con, "accounts", [{"account_id": "A1", "name": "Bergen Exteriors", "phone": "(201) 555-0199",
                               "postal_code": "07026", "city": "Garfield", "state": "NJ", "status": "inactive",
                               "owner_rep": "Dana", "annual_spend": 120000.0, "last_order_at": _ts(T0 - timedelta(days=500)),
                               "extra": "{}", "gaf_id": "1002", "match_confidence": 0.97, "match_method": "phone",
                               "imported_at": _ts(T0)}])
    con.commit()
    return con


def _md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


@pytest.fixture
def legacy(tmp_path) -> Path:
    path = tmp_path / "section1.db"
    build_legacy(path).close()
    return path


@pytest.fixture
def target(tmp_path) -> Repository:
    return Repository(f"sqlite:///{tmp_path / 'companies.db'}")


def test_import_moves_every_table_onto_company_ids(legacy, target):
    before = _md5(legacy)
    stats = import_sqlite(legacy, target)
    assert _md5(legacy) == before  # the source is only ever read from a copy
    assert stats["companies"] == {"imported": 2, "already_present": 0, "skipped_no_location": 1}
    assert stats["skipped_gaf_ids"] == ["1003"]
    assert {k: stats[k] for k in ("scrape_runs", "search_hits", "reviews", "enrichments", "contacts", "audit_events",
                                  "regional_signals", "jobs", "schedules", "accounts")} == {
        "scrape_runs": 3, "search_hits": 4, "reviews": 1, "enrichments": 2, "contacts": 1, "audit_events": 6,
        "regional_signals": 1, "jobs": 1, "schedules": 1, "accounts": 1}
    assert stats["jobs_requested_by_cleared"] == 1 and stats["run_id"] == 4

    jersey, bergen = cid(target, "1001"), cid(target, "1002")
    row = target.get_companies([jersey])[0]
    assert (row["name"], row["website"], row["gaf_id"], row["priority_score"]) == (
        "Jersey Roofing LLC", "https://roof.example", "1001", 72.3)  # NUMERIC(4,1); 72.35 is 72.3499... as a float
    assert row["tags"][0]["key"] == "gaf_tier" and row["certifications"] == ["GAF Master Elite"]
    assert row["gaf_leads_enrolled"] is True and row["first_seen_at"].replace(tzinfo=timezone.utc) == T0
    with target.engine.connect() as conn:
        assert conn.execute(select(enrichments.c.match_confidence).where(
            enrichments.c.company_id == jersey, enrichments.c.source == "bbb")).scalar() == 0.93
        assert conn.execute(select(reviews.c.company_id).where(reviews.c.id == "rv1")).scalar() == jersey
        hits = conn.execute(select(search_hits.c.id, search_hits.c.run_id, search_hits.c.company_id)).all()
        assert sorted(hits) == sorted([(10, 1, jersey), (11, 1, bergen), (30, 3, jersey), (31, 3, bergen)])
        (pat,) = conn.execute(select(contacts)).all()
        runs = [tuple(r) for r in conn.execute(select(scrape_runs.c.id, scrape_runs.c.kind).order_by(scrape_runs.c.id))]
        audit = {r.id: r for r in conn.execute(select(audit_events))}
        job = conn.execute(select(jobs)).one()
    assert pat.company_id == jersey and pat.source_key == contact_key(jersey, "Pat Owner", "bbb")
    assert runs == [(1, "gaf_ingest"), (2, "enrich"), (3, "gaf_ingest"), (4, "sqlite_import")]
    # Audit history keeps its ids and runs and moves to the new keys.
    assert (audit[1].entity_id, audit[1].company_id) == (f"{jersey}:bbb", jersey)
    assert audit[2].entity_id == pat.source_key
    assert audit[3].entity_id == contact_key(bergen, "Old Person", "osm")  # removed contact: key from its name
    assert (audit[4].entity_type, audit[4].entity_id) == ("company", bergen)
    assert (audit[5].entity_id, audit[5].company_id) == ("9999", None)  # never a company here: kept as it was
    assert all(a.actor_type == "pipeline" for a in audit.values())
    imported = [a for a in audit.values() if a.run_id == 4]
    assert {a.entity_id for a in imported} == {jersey, bergen} and {a.action for a in imported} == {"created"}
    # Section 1's free-text requester cannot be a users.id; its area key moves to the shared canonical form.
    assert (job.id, job.requested_by, job.dedupe_key, job.schedule_id) == (7, None, "scrape:07026:25:*", 1)


def test_lead_state_is_rebuilt_by_the_pipeline_rules(legacy, target):
    stats = import_sqlite(legacy, target)
    jersey = target.get_companies([cid(target, "1001")])[0]
    bergen = target.get_companies([cid(target, "1002")])[0]
    # Jersey gained a contact after the previous complete read (run 1) finished; Bergen did not change.
    assert jersey["last_material_change_at"].replace(tzinfo=timezone.utc) == T0 + timedelta(hours=1)
    assert (jersey["updated_in_last_poll"], bergen["updated_in_last_poll"]) == (True, False)
    assert stats["updated_in_last_poll"] == 1
    assert (jersey["account_status"], bergen["account_status"]) == ("prospect", "lapsed_customer")
    events = target.outbox()
    assert [e["event_type"] for e in events] == ["lead.updated", "lead.updated", "pipeline.run_completed"]
    assert events[-1]["payload"]["company_ids"] == sorted([jersey["company_id"], bergen["company_id"]])
    assert all(e["payload"]["actor_type"] == "pipeline" for e in events)


def test_reimport_is_a_no_op_and_never_overwrites_newer_data(legacy, target):
    import_sqlite(legacy, target)
    jersey = cid(target, "1001")
    target.set_website(jersey, "https://newer.example", "osm")
    n_events = len(target.outbox())
    again = import_sqlite(legacy, target)
    assert again["companies"] == {"imported": 0, "already_present": 2, "skipped_no_location": 1}
    assert again["run_id"] is None and again["audit_events"] == 0 and again["scrape_runs"] == 0
    assert target.get_companies([jersey])[0]["website"] == "https://newer.example"
    assert len(target.outbox()) == n_events
    assert cid(target, "1001") == jersey  # ids are stable across imports


def test_uncheckpointed_wal_content_is_imported(tmp_path, target):
    path = tmp_path / "wal.db"
    con = build_legacy(path)
    con.execute("PRAGMA journal_mode=WAL")
    _insert(con, "contractors", [_contractor("1004", "Late Roofing", 40.9, -74.2)])
    con.commit()  # the row is in section1.db-wal until the last connection closes
    assert path.with_name("wal.db-wal").stat().st_size > 0
    stats = import_sqlite(path, target)
    con.close()
    assert stats["companies"]["imported"] == 3 and target.company_id("1004") is not None


def test_target_with_different_run_ids_is_refused(legacy, target):
    target.start_run("tag", {})  # run 1 exists and is not Section 1's run 1
    with pytest.raises(SqliteImportError, match="different runs"):
        import_sqlite(legacy, target)
    assert target.company_id("1001") is None  # nothing was written


def test_non_section1_sources_are_refused(tmp_path, target):
    other = tmp_path / "other.db"
    sqlite3.connect(other).execute("CREATE TABLE things (id INTEGER)").connection.close()
    with pytest.raises(SqliteImportError, match="not a Section 1 database"):
        import_sqlite(other, target)
    with pytest.raises(SqliteImportError, match="no such file"):
        import_sqlite(tmp_path / "missing.db", target)
    (tmp_path / "junk.db").write_text("not sqlite")
    with pytest.raises(SqliteImportError, match="not a SQLite database"):
        import_sqlite(tmp_path / "junk.db", target)


def test_cli_import_then_validate_and_export(legacy, tmp_path, capsys):
    db = f"sqlite:///{tmp_path / 'cli.db'}"
    assert main(["--db", db, "import-sqlite", str(legacy)]) == 0
    assert json.loads(capsys.readouterr().out)["companies"]["imported"] == 2
    out = tmp_path / "leads.csv"
    assert main(["--db", db, "export", "--zip", "07026", "--radius", "25", "--format", "csv", "--out", str(out)]) == 0
    lines = out.read_text().splitlines()
    assert lines[0].startswith("rank,company_id,gaf_id,name") and len(lines) == 3
    capsys.readouterr()
    main(["--db", db, "validate", "--zip", "07026", "--radius", "25"])
    report = capsys.readouterr().out
    assert "integrity.unique_gaf_id" in report and "audit.contacts" in report
    assert main(["--db", db, "import-sqlite", str(tmp_path / "missing.db")]) == 2


def test_tied_contacts_keep_their_section1_order(tmp_path, target):
    """Section 1 returned equally confident people in insertion (rowid) order and picked the first as the target
    contact; the import keeps that order so the choice does not flip on the next re-tag."""
    path = tmp_path / "order.db"
    con = build_legacy(path)
    _insert(con, "contacts", [
        {"id": _old_contact_id("1002", n, "fmcsa"), "gaf_id": "1002", "name": n, "title": "Company officer",
         "email": None, "phone": None, "source": "fmcsa", "source_url": "https://dot.example", "confidence": 0.89,
         "first_seen_at": _ts(T0), "last_seen_at": _ts(T0)} for n in ("Zed First", "Amy Second", "Mia Third")])
    con.commit()
    con.close()
    import_sqlite(path, target)
    (lead,) = [l for l in target.lead_records("07026", 25) if l["gaf_id"] == "1002"]
    assert [c["name"] for c in lead["contacts"]] == ["Zed First", "Amy Second", "Mia Third"]
