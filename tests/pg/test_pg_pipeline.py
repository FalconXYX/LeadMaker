"""The pipeline on Postgres: the version trigger and the repository's own bumps agree, every change publishes
an outbox event the migration's CHECKs accept, complete reads mark updated_in_last_poll, the job queue works
with users.id requesters, a refresh job leaves tagged leads with counties and a timeline, rep-created contacts
are left alone, and a Section 1 import keeps run ids, moves the sequences on and feeds the seed."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
from sqlalchemy import func, insert, select, text, update

from leadmaker.config import Settings
from leadmaker.db.import_sqlite import import_sqlite
from leadmaker.db.repository import PollBaseline, contact_key
from leadmaker.db.schema import activity_logs, audit_events, companies, contacts, jobs, outbox_events, users
from leadmaker.jobs import JobQueue, JobRateLimitError, work
from leadmaker.models import Contact, EnrichmentResult, EnrichmentStatus, SearchArea, SearchHit, Tier
from leadmaker.pipeline import scrape as scrape_mod
from leadmaker.pipeline import signals as signals_mod
from leadmaker.pipeline.tag import run_tagging
from leadmaker.signals import counties

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dbutil import add_user, cid  # noqa: E402
from fakes import FakeGaf, coveo_result, fixture_contractors, gid, offline_settings  # noqa: E402
from test_import_sqlite import build_legacy  # noqa: E402

pytestmark = pytest.mark.pg

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures"
AREA = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7185, longitude=-74.0025)


def _version(repo, company_id) -> int:
    with repo.engine.connect() as conn:
        return conn.execute(select(companies.c.version).where(companies.c.id == company_id)).scalar()


def _poll(repo, cs, since=None):
    run = repo.start_run("gaf_ingest", {"postal_code": "10013", "radius_miles": 25})
    repo.upsert_contractors(cs, run_id=run)
    repo.record_search_hits(run, AREA, [SearchHit(company_id=cid(repo, c.gaf_id), distance_miles=1.0, rank=i + 1)
                                        for i, c in enumerate(cs)])
    repo.finish_run(run, "succeeded", {}, poll=PollBaseline(since=since))
    return run


def test_upsert_creates_companies_with_a_generated_location(pg):
    cs = fixture_contractors()
    assert pg.upsert_contractors(cs) == {"new": len(cs), "changed": 0, "unchanged": 0}
    company = cid(pg, cs[0].gaf_id)
    with pg.engine.connect() as conn:
        lat, lng = conn.execute(text(
            "SELECT ST_Y(location::geometry), ST_X(location::geometry) FROM companies WHERE id = :id"),
            {"id": company}).one()
        near = conn.execute(text(
            "SELECT count(*) FROM companies WHERE ST_DWithin(location, ST_MakePoint(:lng, :lat)::geography, 80467)"),
            {"lat": AREA.latitude, "lng": AREA.longitude}).scalar()
    assert (lat, lng) == (cs[0].latitude, cs[0].longitude) and near == len(cs)


def test_version_bumps_once_per_visible_change(pg):
    cs = fixture_contractors()
    pg.upsert_contractors(cs)
    company = cid(pg, cs[0].gaf_id)
    assert _version(pg, company) == 1
    pg.upsert_contractors(cs)  # same listing (raw, last_seen_at are bookkeeping): no bump
    assert _version(pg, company) == 1
    cs[0].review_count += 1
    pg.upsert_contractors(cs)
    assert _version(pg, company) == 2
    assert pg.outbox("lead.updated")[-1]["payload"]["version"] == 2  # the event carries the post-trigger version

    bbb = EnrichmentResult(source="bbb", status=EnrichmentStatus.OK, confidence=0.9, source_urls=["https://b.example"],
                           contacts=[Contact(name="Pat Owner", title="Owner", source="bbb", confidence=0.8)])
    run = pg.start_run("enrich", {})
    pg.save_enrichment(company, bbb, run_id=run)  # contact = child row: the repository bumps, the trigger doesn't again
    assert _version(pg, company) == 3
    assert pg.outbox("lead.updated")[-1]["payload"] | {"company_id": None} == {
        "company_id": None, "actor_type": "pipeline", "actor_id": None, "version": 3, "run_id": run,
        "fields": ["contacts"], "material": True}
    pg.save_enrichment(company, bbb, run_id=run)
    assert _version(pg, company) == 3

    moved = bbb.model_copy(deep=True)
    moved.contacts[0].confidence = 0.85  # REAL column: the same value read back must not count as a change
    pg.save_enrichment(company, moved, run_id=run)
    pg.save_enrichment(company, moved, run_id=run)
    with pg.engine.connect() as conn:
        assert conn.execute(select(contacts.c.version).where(contacts.c.company_id == company)).scalar() == 2
    assert _version(pg, company) == 4  # the trigger bumped the contact; the repository bumped the company once
    assert pg.outbox("lead.updated")[-1]["payload"]["version"] == 4

    pg.save_tags(company, [{"key": "k", "value": 1, "reason": "r", "source": "s"}], "growth", 55.55)
    assert _version(pg, company) == 5
    assert pg.outbox("lead.updated")[-1]["payload"]["version"] == 5  # written after the update, not before
    pg.save_tags(company, [{"key": "k", "value": 1, "reason": "r", "source": "s"}], "growth", 55.55)  # tagged_at only
    assert _version(pg, company) == 5
    with pg.engine.connect() as conn:
        assert conn.execute(select(companies.c.priority_score).where(companies.c.id == company)).scalar() == 55.5


def test_new_reviews_are_audited_on_postgres(pg):
    from leadmaker.sources.gaf.parse import parse_profile_html

    cs = fixture_contractors()
    pg.upsert_contractors(cs)
    profile = parse_profile_html((FIX / "gaf_profile_master_elite.html").read_text(), cs[0].gaf_id)
    company = cid(pg, cs[0].gaf_id)
    pg.save_profile(company, profile, run_id=7)
    assert {(e["entity_type"], e["action"]) for e in pg.audit_log(run_id=7)} == {("profile", "created"), ("reviews", "created")}
    assert [e["changes"] for e in pg.audit_log(run_id=7) if e["entity_type"] == "reviews"] == [{"new_reviews": [0, 3]}]
    pg.save_profile(company, profile, run_id=8)
    assert pg.audit_log(run_id=8) == []


def test_updated_in_last_poll_and_run_completed_on_postgres(pg):
    cs = fixture_contractors()
    first = _poll(pg, cs)
    assert all(r["updated_in_last_poll"] for r in pg.get_companies())
    finished = next(r for r in pg.list_runs() if r["id"] == first)["finished_at"]
    cs[0].tier = Tier.NONE if cs[0].tier != Tier.NONE else Tier.CERTIFIED
    second = _poll(pg, cs, since=finished)
    flags = {r["gaf_id"]: r["updated_in_last_poll"] for r in pg.get_companies()}
    assert flags == {c.gaf_id: c.gaf_id == cs[0].gaf_id for c in cs}
    done = [e for e in pg.outbox("pipeline.run_completed") if e["payload"]["run_id"] == second]
    assert len(done) == 1 and done[0]["payload"]["complete"] is True
    with pg.engine.connect() as conn:  # the relay reads unpublished rows in id order
        ids = conn.execute(select(outbox_events.c.id).where(outbox_events.c.published_at.is_(None))
                           .order_by(outbox_events.c.id)).scalars().all()
    assert ids == sorted(ids) and len(ids) == len(pg.outbox())


def test_pipeline_keeps_crm_columns_and_kpi_view_refreshes(pg):
    cs = fixture_contractors()
    first = _poll(pg, cs)
    rep = add_user(pg, "Rae Rep")
    company = cid(pg, cs[0].gaf_id)
    with pg.engine.begin() as conn:
        conn.execute(update(companies).where(companies.c.id == company).values(
            assigned_rep_id=rep, custom_fields={"crew": 3}))
    cs[0].review_count += 9
    _poll(pg, cs, since=next(r for r in pg.list_runs() if r["id"] == first)["finished_at"])
    run_tagging(pg, "10013", 25)
    row = pg.get_companies([company])[0]
    assert (row["assigned_rep_id"], row["custom_fields"]) == (rep, {"crew": 3})
    with pg.engine.begin() as conn:
        conn.execute(text("REFRESH MATERIALIZED VIEW CONCURRENTLY team_dashboard_kpis"))
        mine = conn.execute(text("SELECT lead_count, recent_updates_count FROM team_dashboard_kpis "
                                 "WHERE assigned_rep_id = :r"), {"r": rep}).one()
    assert tuple(mine) == (1, 0)  # the second read changed only review_count: not material


def test_job_queue_with_user_requesters(pg):
    rep = add_user(pg)
    q = JobQueue(pg, user_jobs_per_hour=2)
    assert q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25.0}, requested_by=rep)
    assert q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25}, requested_by=rep) is None  # same key
    assert q.enqueue("scrape", {"postal_code": "07030", "radius_miles": 25}, requested_by=rep)
    with pytest.raises(JobRateLimitError):
        q.enqueue("scrape", {"postal_code": "11550", "radius_miles": 25}, requested_by=rep)
    # The CRM Write Service inserts refreshes directly; the open-key index merges them with ours.
    with pytest.raises(Exception, match="jobs_open_dedupe_key"):
        with pg.engine.begin() as conn:
            conn.execute(insert(jobs).values(kind="scrape", params={"postal_code": "10013", "radius_miles": 25},
                                             dedupe_key="scrape:10013:25:*", requested_by=rep))
    claimed = q.claim("w1")
    assert claimed["status"] == "running" and claimed["requested_by"] == rep
    assert q.claim("w2")["id"] != claimed["id"] and q.claim("w3") is None
    # Dead after its last attempt: the requester's failed-job event, in the same transaction (the notifier's refresh_failed).
    with pg.engine.begin() as conn:
        conn.execute(update(jobs).where(jobs.c.id == claimed["id"]).values(attempts=jobs.c.max_attempts))
    assert q.fail(claimed["id"], "boom", run_ids=[7]) == "dead"
    (dead,) = [e for e in pg.outbox("pipeline.run_completed") if e["payload"].get("kind") == "job"]
    assert {k: dead["payload"][k] for k in ("status", "job_id", "job_kind", "job_status", "requested_by", "job_run_ids")} == {
        "status": "failed", "job_id": claimed["id"], "job_kind": "scrape", "job_status": "dead", "requested_by": rep, "job_run_ids": [7]}


async def test_refresh_job_leaves_tagged_leads_with_counties_and_a_timeline(pg, monkeypatch, tmp_path):
    """A rep's refresh ('scrape' job) on Postgres: counties from the cached Census file and tags in the same job
    (the generated search columns follow), then a second refresh writes material changes and a delisting to
    activity_logs with the audit rows, and publishes the delisting as lead.updated with delisted=true."""
    cache = tmp_path / "cache"
    cache.mkdir()
    shutil.copy(FIX / "zcta_county_sample.txt", cache / counties.REL_FILE)
    monkeypatch.setenv("LEADMAKER_CACHE_DIR", str(cache))
    zips = {20: "07010", 21: "07407", 22: "10013", 23: "11550", 24: "10113"}
    fake = FakeGaf({"07030": [coveo_result(i, 1.0 + i, gaf_postal_code=z) for i, z in zips.items()]})
    monkeypatch.setattr(scrape_mod, "HttpClient", lambda s: fake)
    monkeypatch.setattr(signals_mod, "HttpClient", lambda s: fake)
    rep = add_user(pg)
    q = JobQueue(pg)
    params = {"postal_code": "07030", "radius_miles": 10, "fetch_profiles": False}
    q.enqueue("scrape", params, requested_by=rep)
    assert await work(offline_settings(), pg, once=True) == 1

    (job,) = q.list("succeeded")
    assert job["result"]["counties"]["assigned"] == 4 and job["result"]["tag"]["tagged"] == 5
    with pg.engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT s.external_id, c.county_fips, c.segment, c.priority_score, cardinality(c.tag_facets) "
            "FROM companies c JOIN company_source_ids s ON s.company_id = c.id")).all()
    by_gaf = {r[0]: r[1:] for r in rows}
    assert {g: r[0] for g, r in by_gaf.items()} == {gid(20): "34003", gid(21): "34003", gid(22): "36061",
                                                   gid(23): "36059", gid(24): None}
    assert all(seg and score is not None and facets for _, seg, score, facets in by_gaf.values())
    assert [e["payload"]["kind"] for e in pg.outbox("pipeline.run_completed")] == ["gaf_ingest", "counties", "tag"]
    with pg.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(activity_logs)).scalar() == 0  # first sight

    fake.areas["07030"] = [coveo_result(i, 1.0 + i, gaf_postal_code=z, **({"gaf_rating": 3.1, "gaf_number_of_reviews": 12} if i == 20 else {}))
                           for i, z in zips.items() if i != 24]
    n_updated = len(pg.outbox("lead.updated"))
    gone_version = _version(pg, cid(pg, gid(24)))
    q.enqueue("scrape", params, requested_by=rep)
    assert await work(offline_settings(), pg, once=True) == 1
    second = q.list("succeeded")[0]["result"]["scrape"]
    assert second["delisted"] == 1
    with pg.engine.connect() as conn:
        timeline = {r.company_id: r for r in conn.execute(select(activity_logs))}
        audit = {(e.company_id, e.action) for e in conn.execute(
            select(audit_events).where(audit_events.c.run_id == second["run_id"]))}
    changed, gone = cid(pg, gid(20)), cid(pg, gid(24))
    assert set(timeline) == {changed, gone}
    assert all((r.action_type, r.actor_type, r.user_id) == ("scraped_change", "pipeline", None)
               for r in timeline.values())
    assert timeline[changed].field_diff == {"fields": ["rating"], "from": {"rating": None}, "to": {"rating": 3.1},
                                            "run_id": second["run_id"]}  # review_count changed too: not material
    assert timeline[gone].field_diff == {"fields": ["delisted"], "from": {"delisted": False}, "to": {"delisted": True},
                                         "area": "07030@10.0mi", "run_id": second["run_id"]}
    assert {(changed, "updated"), (gone, "delisted")} <= audit
    delisted = [e["payload"] for e in pg.outbox("lead.updated")[n_updated:] if e["payload"].get("delisted")]
    assert delisted == [{"company_id": gone, "actor_type": "pipeline", "actor_id": None, "version": _version(pg, gone),
                         "run_id": second["run_id"], "fields": ["delisted"], "material": False, "delisted": True,
                         "area": "07030@10.0mi"}]
    assert _version(pg, gone) == gone_version + 1  # the cached profile of the old version lacks the timeline row


def test_rep_created_contacts_are_never_touched_on_postgres(pg):
    cs = fixture_contractors()
    pg.upsert_contractors(cs)
    company = cid(pg, cs[0].gaf_id)
    with pg.engine.begin() as conn:
        for name, key in (("Rita Rep-Added", None), ("Sam Manager", contact_key(company, "Sam Manager", "bbb"))):
            conn.execute(insert(contacts).values(company_id=company, name=name, title="Owner", source="rep",
                                                 source_key=key, confidence=1.0))
        before = conn.execute(select(contacts).where(contacts.c.source == "rep").order_by(contacts.c.name)).all()

    def bbb(*names):
        return EnrichmentResult(source="bbb", status=EnrichmentStatus.OK, confidence=0.9, source_urls=["https://b.example"],
                                contacts=[Contact(name=n, title="President", email=f"{n[:3].lower()}@b.example",
                                                  source="bbb", confidence=0.8) for n in names])

    for result in (bbb("Pat Owner", "Sam Manager"), bbb(), bbb("Rita Rep-Added")):
        pg.save_enrichment(company, result, run_id=pg.start_run("enrich", {}))
    with pg.engine.connect() as conn:
        after = conn.execute(select(contacts).where(contacts.c.source == "rep").order_by(contacts.c.name)).all()
        others = conn.execute(select(contacts.c.name, contacts.c.source).where(contacts.c.source != "rep")).all()
    assert after == before  # same values, versions and timestamps
    assert [tuple(r) for r in others] == [("Rita Rep-Added", "bbb")]  # BBB's own row; the rep's stays separate


def test_section1_import_keeps_ids_moves_sequences_and_feeds_the_seed(pg, tmp_path):
    legacy = tmp_path / "section1.db"
    build_legacy(legacy).close()
    stats = import_sqlite(legacy, pg)
    assert stats["companies"]["imported"] == 2 and stats["run_id"] == 4
    assert {k: stats[k] for k in ("scrape_runs", "search_hits", "reviews", "enrichments", "contacts", "audit_events",
                                  "regional_signals", "jobs", "schedules", "accounts")} == {
        "scrape_runs": 3, "search_hits": 4, "reviews": 1, "enrichments": 2, "contacts": 1, "audit_events": 6,
        "regional_signals": 1, "jobs": 1, "schedules": 1, "accounts": 1}  # INSERT rowcounts are real on Postgres
    assert pg.start_run("tag", {}) == 5  # identity sequences moved past the kept ids
    with pg.engine.begin() as conn:
        next_audit = conn.execute(insert(audit_events).values(
            entity_type="company", entity_id="x", action="updated", changes={}).returning(audit_events.c.id)).scalar()
        assert next_audit > stats["audit_events"]
        conn.execute(text("SELECT setval(pg_get_serial_sequence('jobs', 'id'), 7)"))  # no-op check: job 7 exists
        events = conn.execute(select(outbox_events.c.event_type, func.count()).group_by(outbox_events.c.event_type)).all()
    assert dict(events) == {"lead.updated": 2, "pipeline.run_completed": 1}
    again = import_sqlite(legacy, pg)
    assert again["companies"]["imported"] == 0 and again["run_id"] is None
    assert again["audit_events"] == again["scrape_runs"] == again["regional_signals"] == 0

    # The demo seed (db/seed) runs on imported data: users, then allocations by county.
    seed = "SET seed.per_rep = '1';\n" + "".join(p.read_text() for p in sorted((ROOT / "db" / "seed").glob("*.sql")))
    with pg.engine.begin() as conn:
        conn.connection.cursor().execute(seed)  # no parameters: psycopg leaves the seed's '%' alone
        allocated = conn.execute(select(func.count()).select_from(companies)
                                 .where(companies.c.assigned_rep_id.is_not(None))).scalar()
        reps = conn.execute(select(func.count()).select_from(users).where(users.c.role == "rep")).scalar()
    assert reps == 3 and allocated == 1  # both leads share one county; the first rep takes it, 1 per rep
    # A later pipeline write leaves the allocation alone.
    allocated_id = pg.get_companies([r["company_id"] for r in pg.get_companies() if r["assigned_rep_id"]])[0]
    pg.save_tags(allocated_id["company_id"], [{"key": "k", "value": 2, "reason": "r", "source": "s"}], "growth", 10)
    assert pg.get_companies([allocated_id["company_id"]])[0]["assigned_rep_id"] == allocated_id["assigned_rep_id"]


def test_crm_import_and_long_scraped_strings_fit_postgres(pg, tmp_path):
    """SQLite never checks VARCHAR lengths; Postgres does. Auto account ids and long scraped values must fit."""
    from leadmaker.accounts import import_accounts

    cs = fixture_contractors()
    pg.upsert_contractors(cs)
    csv = tmp_path / "accounts.csv"
    csv.write_text("Account Name,Main Phone,Zip,Status\nJersey Roofing,201-982-2718,07026,Active\n")  # no account ids
    out = import_accounts(pg, csv)
    assert out["matched"] == 1 and pg.list_runs(1)[0]["status"] == "succeeded"
    company = cid(pg, cs[0].gaf_id)
    long = EnrichmentResult(source="website_crawl", status=EnrichmentStatus.OK, confidence=0.9,
                            source_urls=["https://x.example"],
                            contacts=[Contact(name="Pat " + "Long" * 80, title="Owner " + "and founder " * 40,
                                              source="website", confidence=0.6)])
    pg.save_enrichment(company, long, run_id=pg.start_run("enrich", {}))
    with pg.engine.connect() as conn:
        name, title = conn.execute(select(contacts.c.name, contacts.c.title).where(contacts.c.company_id == company)).one()
    assert len(name) == 255 and len(title) == 255


def test_validate_reads_postgres(pg, tmp_path):
    from leadmaker import validate as V

    legacy = tmp_path / "section1.db"
    build_legacy(legacy).close()
    import_sqlite(legacy, pg)
    report = V.validate(pg, "07026", 25, settings=Settings(database_url="sqlite://"))
    checks = {c["id"]: c for c in report["checks"]}
    assert report["area"]["leads"] == 2 and report["area"]["run_id"] == 3
    for cid_ in ("integrity.unique_gaf_id", "integrity.orphans", "runs.latest_scrape_complete", "audit.enrichments",
                 "audit.contacts", "provenance.source_urls"):
        assert checks[cid_]["status"] == "pass", (cid_, checks[cid_])
    assert not any(c["id"].endswith(".error") for c in report["checks"])
