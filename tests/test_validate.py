"""`leadmaker validate`: every Section 1 data guarantee is checked, and each check reaches pass / warn / fail.

A clean database is built once through the real write paths (Repository upserts, run_tagging, the
signals store) from the saved Coveo fixture, copied per test, then broken in exactly one way.
"""

import json
import shutil
from datetime import timedelta

import pytest
from sqlalchemy import delete, event, insert, select, update

from leadmaker import validate as V
from leadmaker.cli import main
from leadmaker.config import Settings
from leadmaker.db import Repository
from leadmaker.db.repository import company_label, utcnow
from leadmaker.db.schema import (
    accounts,
    audit_events,
    companies,
    contacts,
    enrichments,
    jobs,
    regional_signals,
    scrape_runs,
    search_hits,
)
from leadmaker.models import (
    Contact,
    Contractor,
    ContractorProfile,
    EnrichmentResult,
    EnrichmentStatus,
    SearchArea,
    SearchHit,
)
from leadmaker.pipeline.tag import run_tagging
from leadmaker.signals import store

from dbutil import cid
from fakes import fixture_contractors

AREA = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7185, longitude=-74.0025)
FIPS = {"NY": "36081", "NJ": "34003"}
OWNERS = ["Alex Golovin", "Dana Hayden", "Sam Bluemaster", "Jordan Jersey"]  # leads 0-3 have a site + owner
# Explicit TTLs so LEADMAKER_*_TTL_HOURS in the environment cannot move the thresholds under test.
SETTINGS = Settings(database_url="sqlite://", profile_ttl_hours=24 * 7, enrichment_ttl_hours=24 * 30)


def _site(c: Contractor) -> str:
    return f"https://www.{c.name.split()[0].lower()}roofing.com"


def _ok(source, data, conf, *, website=None, urls=(), people=()):
    return EnrichmentResult(source=source, status=EnrichmentStatus.OK, confidence=conf, data=data, website=website,
                            source_urls=list(urls), contacts=list(people))


def _build_clean(repo: Repository) -> None:
    cs = fixture_contractors()
    scrape = repo.start_run("gaf_ingest", {"postal_code": "10013", "radius_miles": 25.0})
    repo.upsert_contractors(cs, run_id=scrape)
    repo.record_search_hits(scrape, AREA, [SearchHit(company_id=cid(repo, c.gaf_id), distance_miles=2.0 + 4 * i, rank=i + 1)
                                           for i, c in enumerate(cs)])
    for c in cs:
        repo.save_profile(cid(repo, c.gaf_id), ContractorProfile(gaf_id=c.gaf_id, employees_range="1-5"), run_id=scrape)
    repo.finish_run(scrape, "succeeded", {"completeness": {"complete": True, "results": 6, "total": 6},
                                          "coveo_total": 6, "results": 6})

    enrich = repo.start_run("enrich", {"postal_code": "10013", "radius_miles": 25})
    for i, c in enumerate(cs):
        company = cid(repo, c.gaf_id)
        if i < len(OWNERS):
            site = _site(c)
            repo.save_enrichment(company, _ok("website_discovery", {"website": site}, 0.9, website=site, urls=[site]),
                                 run_id=enrich)
            owner = Contact(name=OWNERS[i], title="Owner", source="website", source_url=f"{site}/about", confidence=0.6)
            repo.save_enrichment(company, _ok("website_crawl", {"emails": [], "leadership": []}, 0.9, website=site,
                                               urls=[site, f"{site}/about"], people=[owner]), run_id=enrich)
            repo.set_website(company, site, "website_discovery")
        else:
            repo.save_enrichment(company, EnrichmentResult(source="website_discovery", status=EnrichmentStatus.NO_MATCH),
                                 run_id=enrich)
            repo.save_enrichment(company, EnrichmentResult(source="website_crawl", status=EnrichmentStatus.SKIPPED),
                                 run_id=enrich)
        repo.save_enrichment(company, EnrichmentResult(source="fmcsa", status=EnrichmentStatus.NO_MATCH), run_id=enrich)
    repo.finish_run(enrich, "succeeded", {})

    with repo.engine.begin() as conn:
        for c in cs:
            conn.execute(update(companies).where(companies.c.id == cid(repo, c.gaf_id)).values(county_fips=FIPS[c.state]))
    now = utcnow()
    store.upsert_signals(repo, [
        *({"county_fips": f, "kind": "storm_history", "source": "noaa_storm_events", "external_id": "summary_24m",
           "payload": {"events_24m": 3}} for f in FIPS.values()),
        {"county_fips": "36081", "kind": "active_alert", "source": "nws", "external_id": "urn:alert:1",
         "payload": {"event": "Frost Advisory"}, "valid_from": now, "valid_to": now + timedelta(hours=6)},
        {"county_fips": "36081", "kind": "news", "source": "gdelt", "external_id": "https://news.example/roofs",
         "payload": {"title": "Roof permits up"}},
    ])
    sig = repo.start_run("signals", {"news": True})
    repo.finish_run(sig, "succeeded", {"alerts": {"alerts": 1}, "storm_history": {"counties": 2}, "errors": {}})
    run_tagging(repo, "10013", 25)  # last, so tags post-date every fact


@pytest.fixture(scope="module")
def clean_db(tmp_path_factory):
    path = tmp_path_factory.mktemp("validate") / "clean.db"
    repo = Repository(f"sqlite:///{path}")
    _build_clean(repo)
    repo.engine.dispose()  # checkpoint the WAL so a file copy is complete
    return path


@pytest.fixture
def repo(clean_db, tmp_path):
    dst = tmp_path / "v.db"
    shutil.copy(clean_db, dst)
    return Repository(f"sqlite:///{dst}")


def _run(repo, **kw):
    return V.validate(repo, "10013", 25, settings=SETTINGS, **kw)


def _checks(repo, **kw):
    return {c["id"]: c for c in _run(repo, **kw)["checks"]}


def _exec(repo, *stmts):
    with repo.engine.begin() as conn:
        for s in stmts:
            conn.execute(s)


def _without_fk(repo, *stmts):
    with repo.engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        for s in stmts:
            conn.execute(s)
        conn.commit()
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")


def _without_checks(repo, *stmts):
    """Write values the schema's CHECK constraints refuse, to prove validate still catches them."""
    with repo.engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        for s in stmts:
            conn.execute(s)
        conn.commit()
        conn.exec_driver_sql("PRAGMA ignore_check_constraints=OFF")


def _ids(repo):
    """Company ids of the area's leads, nearest first."""
    return repo.area_company_ids("10013", 25)


def _label(repo, company_id):
    return company_label(repo.get_companies([company_id])[0])


GHOST = "00000000-0000-4000-8000-00000000dead"  # a company id nothing has


def _run_id(repo, kind):
    with repo.engine.connect() as conn:
        return conn.execute(select(scrape_runs.c.id).where(scrape_runs.c.kind == kind)
                            .order_by(scrape_runs.c.id.desc())).scalars().first()


def _retag(repo):
    run_tagging(repo, "10013", 25)


# ------------------------------------------------------------------------------------ baseline
def test_clean_database_passes_every_check_and_exits_zero(repo):
    report = _run(repo)
    bad = [(c["id"], c["status"], c["detail"]) for c in report["checks"] if c["status"] in ("warn", "fail")]
    assert bad == []
    assert report["status"] == "pass" and report["counts"]["fail"] == report["counts"]["warn"] == 0
    assert report["area"] == {"postal_code": "10013", "radius_miles": 25.0, "run_id": 1, "leads": 6}
    assert {c["group"] for c in report["checks"]} == set(V.GROUPS)
    for c in report["checks"]:
        assert set(c) == {"id", "group", "status", "value", "threshold", "detail", "examples"}
        assert c["status"] in ("pass", "warn", "fail", "info") and c["id"].startswith(c["group"] + ".")
    assert V.exit_code(report) == 0 and V.exit_code(report, strict=True) == 0
    json.dumps(report, default=str)  # the --out payload serialises


def test_contacts_reps_created_are_not_checked_as_scraped_data(repo):
    """Reps add people through the CRM Write Service (source 'rep': no source_url, no audit row, maybe no name)."""
    a, b = _ids(repo)[:2]
    with repo.engine.begin() as conn:
        conn.execute(insert(contacts), [
            {"company_id": a, "name": "Rita Rep-Added", "source": "rep", "confidence": 1.0},
            {"company_id": b, "name": "Rita Rep-Added", "source": "rep", "confidence": 1.0},
            {"company_id": b, "name": None, "email": "office@roofer.example", "source": "rep", "confidence": 1.0},
            {"company_id": a, "name": "Ray Keyed", "source": "rep", "source_key": "k" * 64, "confidence": 1.0},
        ])
    report = _run(repo)
    assert [(c["id"], c["status"]) for c in report["checks"] if c["status"] in ("warn", "fail")] == []


def test_validate_only_reads(repo):
    stmts: list[str] = []
    event.listen(repo.engine, "before_cursor_execute", lambda conn, cur, stmt, *a: stmts.append(stmt))
    _run(repo)
    assert stmts and all(s.lstrip().upper().startswith(("SELECT", "PRAGMA")) for s in stmts)


def test_clean_values_report_real_numbers(repo):
    c = _checks(repo)
    assert c["integrity.hit_distance"]["value"]["max_miles"] == 22.0
    assert c["coverage.website"]["value"] == round(4 / 6, 4)
    assert c["coverage.decision_maker"]["value"] == round(4 / 6, 4)
    assert c["tagging.target_contact"]["value"] == "6/6"
    assert c["audit.enrichments"]["value"] == "18/18" and c["audit.contacts"]["value"] == "4/4"
    assert c["signals.storm_history"]["value"] == "2/2"
    assert c["signals.news"] == {**c["signals.news"], "status": "info",
                                 "value": {"rows": 1, "lead_counties_with_news": 1}}
    assert c["coverage.source_ok_rates"]["value"]["website_discovery"] == "4/6 (66.7%)"


# ----------------------------------------------------------------------------------- integrity
def test_case_variant_gaf_ids_are_duplicates(repo):
    base = fixture_contractors()[0]
    twins = [base.model_copy(update={"gaf_id": g}) for g in ("AB12", "ab12")]
    repo.upsert_contractors(twins, run_id=1)
    c = _checks(repo)["integrity.unique_gaf_id"]
    assert c["status"] == "fail" and c["value"] == 1 and c["examples"] == ["gaf_id ab12"]


def test_rows_pointing_at_missing_contractors_are_orphans(repo):
    now = utcnow()
    _without_fk(repo,
                insert(enrichments).values(company_id=GHOST, source="osm", status="ok", match_confidence=0.9, data={},
                                           source_urls=[], fetched_at=now),
                insert(contacts).values(company_id=GHOST, source_key="k-ghost", name="Nobody", source="website",
                                        confidence=0.5, first_seen_at=now, last_seen_at=now))
    c = _checks(repo)["integrity.orphans"]
    assert c["status"] == "fail"
    assert c["value"]["enrichments"] == 1 and c["value"]["contacts"] == 1 and c["value"]["reviews"] == 0
    assert f"enrichments: {GHOST}" in c["examples"]


def test_orphan_search_hits_and_accounts_are_found(repo):
    now = utcnow()
    _without_fk(repo,
                insert(search_hits).values(run_id=1, company_id=GHOST, postal_code="10013", radius_miles=25.0,
                                           distance_miles=1.0, rank=99, gaf_recommended=False, seen_at=now),
                insert(search_hits).values(run_id=777, company_id=_ids(repo)[0], postal_code="99999", radius_miles=5.0,
                                           distance_miles=1.0, rank=1, gaf_recommended=False, seen_at=now),
                insert(accounts).values(account_id="A-1", name="Ghost Roofing", company_id=GHOST, extra={},
                                        imported_at=now))
    c = _checks(repo)
    o = c["integrity.orphans"]
    assert o["status"] == "fail"
    assert (o["value"]["search_hits"], o["value"]["accounts"], o["value"]["search_hits_run"]) == (1, 1, 1)
    assert {f"search_hits: {GHOST}", f"accounts: A-1->{GHOST}", "search_hits run 777 missing"} <= set(o["examples"])
    # The area run now lists a hit with no company behind it: the lead set itself is broken.
    h = c["integrity.hit_distance"]
    assert h["status"] == "fail" and GHOST in h["examples"]


@pytest.mark.parametrize("distance,status", [(25.4, "pass"), (25.6, "fail"), (None, "warn")])
def test_hit_distance_allows_half_mile_tolerance(repo, distance, status):
    gid = _ids(repo)[0]
    _exec(repo, update(search_hits).where(search_hits.c.company_id == gid).values(distance_miles=distance))
    c = _checks(repo)["integrity.hit_distance"]
    assert c["status"] == status and c["threshold"].startswith("<= 25.5 mi")


def test_missing_coordinates_warn_then_fail_by_rate(repo, monkeypatch):
    gid = _ids(repo)[0]
    with pytest.raises(Exception, match="NOT NULL"):  # the schema refuses a lead without a location ...
        _exec(repo, update(companies).where(companies.c.id == gid).values(latitude=None))
    _without_checks(repo, update(companies).where(companies.c.id == gid).values(latitude=95.0))  # ... so corrupt it
    c = _checks(repo)["integrity.coordinates"]
    assert c["status"] == "fail" and c["value"] == round(5 / 6, 4) and c["examples"][0].startswith(_label(repo, gid))
    monkeypatch.setattr(V, "COORDS_WARN", 0.8)
    assert _checks(repo)["integrity.coordinates"]["status"] == "warn"


def test_required_field_completeness_per_field(repo, monkeypatch):
    gid = _ids(repo)[1]
    _exec(repo, update(companies).where(companies.c.id == gid).values(phone="  "))
    c = _checks(repo)["integrity.required_fields"]
    assert c["status"] == "fail" and c["value"]["phone"] == round(5 / 6, 4) and c["value"]["name"] == 1.0
    monkeypatch.setitem(V.REQUIRED_FIELDS, "phone", (0.98, 0.8))
    assert _checks(repo)["integrity.required_fields"]["status"] == "warn"


def test_same_phone_and_name_under_two_ids_warns_as_duplicate_listing(repo):
    a, b = _ids(repo)[:2]
    # A shared phone alone (answering service, family firms) is not a duplicate listing.
    _exec(repo, update(companies).where(companies.c.id == b).values(phone="(959) 237-0800"))
    c = _checks(repo)["integrity.duplicate_listings"]
    assert c["status"] == "pass" and c["value"] == 0
    _exec(repo, update(companies).where(companies.c.id == b).values(business_name="Golovin Roofing"))
    c = _checks(repo)["integrity.duplicate_listings"]
    assert c["status"] == "warn" and c["value"] == 1 and "9592370800" in c["examples"][0]


# ---------------------------------------------------------------------------------- run health
def test_incomplete_latest_scrape_fails(repo):
    rid = repo.start_run("gaf_ingest", {"postal_code": "10013", "radius_miles": 25.0})
    repo.finish_run(rid, "partial", {"completeness": {"complete": False, "reason": "pagination_stopped",
                                                      "message": "read 4 of 6", "results": 4, "total": 6}})
    c = _checks(repo)["runs.latest_scrape_complete"]
    assert c["status"] == "fail" and c["value"] == {"run_id": rid, "results": 4, "total": 6}
    assert "pagination_stopped" in c["detail"]


@pytest.mark.parametrize("stats,status", [({"coveo_total": 6, "results": 6}, "pass"),
                                          ({"coveo_total": 6, "results": 5}, "fail")])
def test_legacy_scrape_stats_use_the_count_rule(repo, stats, status):
    rid = repo.start_run("gaf_ingest", {"postal_code": "10013", "radius_miles": 25.0})
    repo.finish_run(rid, "succeeded", stats)
    assert _checks(repo)["runs.latest_scrape_complete"]["status"] == status


def test_scrape_completeness_follows_the_read_verdict_like_the_scrape_guard(repo):
    from leadmaker.pipeline.scrape import previous_complete_read

    # Profiles crashed after a complete, stored read: the area read is whole (the guard uses it as its
    # baseline), so completeness passes and the failure surfaces as a failed latest run instead.
    rid = repo.start_run("gaf_ingest", {"postal_code": "10013", "radius_miles": 25.0})
    repo.record_search_hits(rid, AREA, [SearchHit(company_id=g, distance_miles=3.0, rank=i + 1)
                                        for i, g in enumerate(_ids(repo))])
    repo.finish_run(rid, "failed", {"completeness": {"complete": True, "results": 6, "total": 6, "hits_recorded": True}},
                    error="HttpError: profile 503")
    assert previous_complete_read(repo, AREA, rid + 1) == {"run_id": rid, "results": 6}
    c = _checks(repo)
    assert c["runs.latest_scrape_complete"]["status"] == "pass"
    assert c["runs.latest_scrape_complete"]["value"]["run_id"] == rid
    assert "failed after a complete read" in c["runs.latest_scrape_complete"]["detail"]
    assert c["runs.latest_by_kind"]["status"] == "warn" and "profile 503" in c["runs.latest_by_kind"]["detail"]
    # A run that failed before storing its hits had its verdict downgraded by run_scrape: incomplete.
    rid2 = repo.start_run("gaf_ingest", {"postal_code": "10013", "radius_miles": 25.0})
    repo.finish_run(rid2, "failed", {"completeness": {"complete": False, "reason": "run_failed", "results": 6, "total": 6,
                                                      "message": "run failed before search hits were stored"}})
    c = _checks(repo)["runs.latest_scrape_complete"]
    assert c["status"] == "fail" and c["value"]["run_id"] == rid2 and "run_failed" in c["detail"]


def test_a_running_rescrape_does_not_hide_the_last_finished_verdict(repo):
    rid = repo.start_run("gaf_ingest", {"postal_code": "10013", "radius_miles": 25.0})
    c = _checks(repo)["runs.latest_scrape_complete"]
    assert c["status"] == "pass" and c["value"]["run_id"] == 1 and f"run {rid} still running" in c["detail"]


def test_runs_and_jobs_running_over_two_hours_are_stuck(repo):
    fresh = repo.start_run("enrich", {})
    old = repo.start_run("enrich", {})
    _exec(repo, update(scrape_runs).where(scrape_runs.c.id == old).values(started_at=utcnow() - timedelta(hours=3)))
    c = _checks(repo)["runs.stuck"]
    assert c["status"] == "warn" and c["value"] == 1 and c["examples"][0].startswith(f"run {old} enrich")
    assert f"{fresh} enrich" in c["detail"]
    now = utcnow()
    _exec(repo, insert(jobs).values(kind="scrape", params={}, status="running", run_after=now, created_at=now,
                                    locked_by="w1", locked_at=now - timedelta(hours=5)))
    assert _checks(repo)["runs.stuck"]["value"] == 2


def test_dead_jobs_warn(repo):
    now = utcnow()
    _exec(repo, insert(jobs).values(kind="enrich", params={}, status="dead", run_after=now, created_at=now,
                                    error="RuntimeError: source down"))
    c = _checks(repo)["runs.dead_jobs"]
    assert c["status"] == "warn" and c["value"] == 1 and "source down" in c["examples"][0]


def test_failed_latest_run_of_a_kind_warns(repo):
    rid = repo.start_run("tag", {})
    repo.finish_run(rid, "failed", {}, error="boom")
    c = _checks(repo)["runs.latest_by_kind"]
    assert c["status"] == "warn" and c["value"]["tag"] == f"{rid} failed"


def test_signals_run_age_pass_warn_fail(repo):
    sig = _run_id(repo, "signals")
    assert _checks(repo)["runs.signals_age"]["status"] == "pass"
    _exec(repo, update(scrape_runs).where(scrape_runs.c.id == sig).values(finished_at=utcnow() - timedelta(hours=30)))
    assert _checks(repo)["runs.signals_age"]["status"] == "warn"
    _exec(repo, update(scrape_runs).where(scrape_runs.c.id == sig).values(finished_at=utcnow() - timedelta(days=8)))
    assert _checks(repo)["runs.signals_age"]["status"] == "fail"
    _exec(repo, delete(scrape_runs).where(scrape_runs.c.id == sig))
    c = _checks(repo)["runs.signals_age"]
    assert c["status"] == "fail" and "no finished signals run" in c["detail"]


def test_partial_signals_run_warns_with_its_errors(repo):
    rid = repo.start_run("signals", {})
    repo.finish_run(rid, "partial", {"alerts": {}, "errors": {"news": "TimeoutError: gdelt"}})
    c = _checks(repo)["runs.signals_age"]
    assert c["status"] == "warn" and c["examples"] == ["news: TimeoutError: gdelt"]


# ----------------------------------------------------------------------------------- freshness
def test_profile_ttl_rate_and_profile_errors(repo):
    ids = _ids(repo)
    old = utcnow() - timedelta(hours=SETTINGS.profile_ttl_hours + 1)
    _exec(repo, update(companies).where(companies.c.id == ids[0]).values(profile_scraped_at=old))
    c = _checks(repo)["freshness.profiles"]
    assert c["status"] == "warn" and c["value"] == round(5 / 6, 4)
    _exec(repo, update(companies).values(profile_scraped_at=old))
    assert _checks(repo)["freshness.profiles"]["status"] == "fail"
    _exec(repo, update(companies).values(profile_scraped_at=utcnow()),
          update(companies).where(companies.c.id == ids[1]).values(profile_error="HttpError: 503"))
    c = _checks(repo)["freshness.profiles"]
    assert c["status"] == "warn" and any("HttpError: 503" in e for e in c["examples"])


def test_enrichment_ttl_is_per_source(repo):
    # 10 days old: past the 7-day profile TTL but inside the 30-day enrichment TTL -> still fresh.
    _exec(repo, update(enrichments).where(enrichments.c.source == "fmcsa").values(fetched_at=utcnow() - timedelta(days=10)))
    assert _checks(repo)["freshness.enrichment_ttl"]["status"] == "pass"
    old = utcnow() - timedelta(hours=SETTINGS.enrichment_ttl_hours + 1)
    _exec(repo, update(enrichments).where(enrichments.c.source == "fmcsa").values(fetched_at=old))
    c = _checks(repo)["freshness.enrichment_ttl"]
    assert c["status"] == "fail" and c["value"]["fmcsa"] == 0.0 and c["value"]["website_discovery"] == 1.0
    assert c["examples"] == ["fmcsa: 6/6 older than TTL"]


def test_source_rows_missing_for_some_leads_warn(repo):
    gid = _ids(repo)[5]
    _exec(repo, delete(enrichments).where(enrichments.c.company_id == gid, enrichments.c.source == "fmcsa"))
    c = _checks(repo)["freshness.enrichment_missing"]
    assert c["status"] == "warn" and c["value"] == {"fmcsa": 1}


@pytest.mark.parametrize("n_errors,status", [(0, "pass"), (1, "warn"), (2, "fail")])
def test_per_source_error_rate_thresholds(repo, n_errors, status):
    for gid in _ids(repo)[:n_errors]:
        _exec(repo, update(enrichments).where(enrichments.c.company_id == gid, enrichments.c.source == "fmcsa")
              .values(status="error", error="TimeoutError: socrata"))
    c = _checks(repo)["freshness.error_rate"]
    assert c["status"] == status and c["value"]["fmcsa"] == round(n_errors / 6, 4)


def test_error_rate_ignores_skipped_rows(repo):
    # website_crawl: 4 ok + 2 skipped; one error among the 4 live rows is 25% (warn), not 1/6.
    gid = _ids(repo)[0]
    _exec(repo, update(enrichments).where(enrichments.c.company_id == gid, enrichments.c.source == "website_crawl")
          .values(status="error"))
    c = _checks(repo)["freshness.error_rate"]
    assert c["value"]["website_crawl"] == 0.25 and c["status"] == "warn"


# ---------------------------------------------------------------------------------- provenance
def test_ok_enrichment_without_source_urls_fails(repo):
    gid = _ids(repo)[0]
    _exec(repo, update(enrichments).where(enrichments.c.company_id == gid, enrichments.c.source == "website_discovery")
          .values(source_urls=[]))
    c = _checks(repo)["provenance.source_urls"]
    assert c["status"] == "fail" and c["examples"] == [f"{_label(repo, gid)}:website_discovery"]


def test_accept_thresholds_come_from_the_enricher_modules(monkeypatch):
    from leadmaker.enrich import bbb, fmcsa, google_places, ny_dos, nyc_dcwp, website_discovery

    t = V.accept_thresholds()
    assert t["bbb"] == bbb.ACCEPT == 0.9 and t["fmcsa"] == fmcsa.MIN_CONFIDENCE
    assert t["google_places"] == google_places.MIN_CONFIDENCE and t["ny_dos"] == ny_dos.ACCEPT
    assert t["nyc_dcwp"] == nyc_dcwp.ACCEPT and t["website_discovery"] == website_discovery.ACCEPT_SCORE
    assert 0 < t["osm"] < 0.7  # name-only floor, derived from osm.NAME_THRESHOLD
    monkeypatch.setattr(bbb, "ACCEPT", 0.8)
    assert V.accept_thresholds()["bbb"] == 0.8


@pytest.mark.parametrize("source,conf,status", [("bbb", 0.85, "fail"), ("bbb", 0.9, "pass"),
                                                ("fmcsa", 0.74, "fail"), ("fmcsa", 0.75, "pass")])
def test_ok_enrichment_below_its_source_accept_threshold_fails(repo, source, conf, status):
    gid = _ids(repo)[4]
    repo.save_enrichment(gid, _ok(source, {"x": 1}, conf, urls=["https://registry.example/1"]),
                         run_id=_run_id(repo, "enrich"))
    c = _checks(repo)["provenance.match_confidence"]
    assert c["status"] == status and c["value"][source] == conf
    if status == "fail":
        assert c["examples"][0].startswith(f"{_label(repo, gid)}:{source} {conf} <")


def test_contacts_need_source_and_confidence_and_should_cite_a_url(repo):
    gid = _ids(repo)[0]
    _exec(repo, update(contacts).where(contacts.c.company_id == gid).values(source_url=None))
    c = _checks(repo)["provenance.contacts"]
    assert c["status"] == "warn" and c["value"]["no_source_url"] == 1
    _exec(repo, update(contacts).where(contacts.c.company_id == gid).values(source=""))
    c = _checks(repo)["provenance.contacts"]
    assert c["status"] == "fail" and c["value"]["invalid"] == 1


def _llm(repo, gid, dms, people):
    repo.save_enrichment(gid, _ok("llm_extract", {"decision_makers": dms}, 0.9, urls=["https://x.example/about"],
                                  people=people), run_id=_run_id(repo, "enrich"))


def test_llm_contacts_need_evidence_in_the_llm_result(repo):
    gid = _ids(repo)[0]
    person = Contact(name="Morgan Lee", title="Owner", source="llm_extract", source_url="https://x.example/about",
                     confidence=0.7)
    _llm(repo, gid, [{"name": "Morgan Lee", "title": "Owner", "evidence": ""}], [person])
    c = _checks(repo)["provenance.llm_evidence"]
    assert c["status"] == "fail" and c["value"] == {"llm_contacts": 1, "without_evidence": 1}
    _llm(repo, gid, [{"name": "Morgan Lee", "title": "Owner", "evidence": "Morgan Lee, owner since 2001"}], [person])
    c = _checks(repo)["provenance.llm_evidence"]
    assert c["status"] == "pass" and c["value"] == {"llm_contacts": 1, "without_evidence": 0}


# ------------------------------------------------------------------------------------- tagging
def test_untagged_lead_fails(repo):
    gid = _ids(repo)[2]
    _exec(repo, update(companies).where(companies.c.id == gid).values(tagged_at=None))
    c = _checks(repo)["tagging.untagged"]
    assert c["status"] == "fail" and c["value"] == 1


def test_tags_older_than_the_newest_enrichment_are_stale(repo):
    gid = _ids(repo)[0]
    repo.save_enrichment(gid, EnrichmentResult(source="fmcsa", status=EnrichmentStatus.NO_MATCH), run_id=_run_id(repo, "enrich"))
    c = _checks(repo)["tagging.stale"]
    assert c["status"] == "fail" and c["value"] == round(1 / 6, 4) and "enrichment fmcsa" in c["examples"][0]
    flight = repo.start_run("enrich", {})  # an enrich run in flight -> re-tag pending, not broken
    c = _checks(repo)["tagging.stale"]
    assert c["status"] == "warn" and f"run {flight} in progress" in c["detail"]
    repo.finish_run(flight, "succeeded", {})
    _retag(repo)
    assert _checks(repo)["tagging.stale"]["status"] == "pass"


def test_a_stuck_enrich_run_does_not_excuse_stale_tags(repo):
    repo.save_enrichment(_ids(repo)[0], EnrichmentResult(source="fmcsa", status=EnrichmentStatus.NO_MATCH),
                         run_id=_run_id(repo, "enrich"))
    stuck = repo.start_run("enrich", {})
    _exec(repo, update(scrape_runs).where(scrape_runs.c.id == stuck).values(started_at=utcnow() - timedelta(hours=3)))
    c = _checks(repo)
    assert c["tagging.stale"]["status"] == "fail" and "in progress" not in c["tagging.stale"]["detail"]
    assert c["runs.stuck"]["status"] == "warn" and c["runs.stuck"]["examples"][0].startswith(f"run {stuck} enrich")


def test_tagged_at_equal_to_the_newest_fact_is_not_stale(repo):
    gid = _ids(repo)[0]
    with repo.engine.connect() as conn:
        newest = max(conn.execute(select(enrichments.c.fetched_at).where(enrichments.c.company_id == gid)).scalars())
    _exec(repo, update(companies).where(companies.c.id == gid).values(tagged_at=newest))
    assert _checks(repo)["tagging.stale"]["status"] == "pass"
    _exec(repo, update(companies).where(companies.c.id == gid).values(tagged_at=newest - timedelta(microseconds=1)))
    c = _checks(repo)["tagging.stale"]
    assert c["status"] == "fail" and c["value"] == round(1 / 6, 4)


def test_stale_share_up_to_ten_percent_only_warns(repo, monkeypatch):
    repo.save_enrichment(_ids(repo)[0], EnrichmentResult(source="fmcsa", status=EnrichmentStatus.NO_MATCH),
                         run_id=_run_id(repo, "enrich"))
    monkeypatch.setattr(V, "STALE_TAG_WARN", 0.2)
    assert _checks(repo)["tagging.stale"]["status"] == "warn"


def _set_tags(repo, gid, fn):
    lead = repo.get_companies([gid])[0]
    _exec(repo, update(companies).where(companies.c.id == gid).values(system_tags=fn(lead["tags"])))


def test_tag_without_reason_or_source_and_duplicate_keys_fail(repo):
    gid = _ids(repo)[0]
    _set_tags(repo, gid, lambda ts: [{**t, "reason": ""} if t["key"] == "gaf_tier" else t for t in ts])
    c = _checks(repo)["tagging.tag_fields"]
    assert c["status"] == "fail" and c["examples"] == [f"{_label(repo, gid)}:gaf_tier missing reason"]
    _retag(repo)
    _set_tags(repo, gid, lambda ts: ts + [ts[0]])
    c = _checks(repo)["tagging.tag_fields"]
    assert c["status"] == "fail" and c["value"]["duplicate_keys"] == 1


@pytest.mark.parametrize("values,check", [({"segment": "vip"}, "tagging.segment"),
                                          ({"segment": None}, "tagging.segment"),
                                          ({"priority_score": 120.0}, "tagging.priority"),
                                          ({"priority_score": None}, "tagging.priority")])
def test_segment_and_priority_must_be_valid(repo, values, check):
    _without_checks(repo, update(companies).where(companies.c.id == _ids(repo)[3]).values(**values))
    assert _checks(repo)[check]["status"] == "fail"


@pytest.mark.parametrize("change,count", [(lambda ts: [t for t in ts if t["key"] != "target_contact"], 0),
                                          (lambda ts: ts + [t for t in ts if t["key"] == "target_contact"], 2)])
def test_exactly_one_target_contact_tag_per_lead(repo, change, count):
    gid = _ids(repo)[1]
    _set_tags(repo, gid, change)
    c = _checks(repo)["tagging.target_contact"]
    assert c["status"] == "fail" and c["value"] == "5/6" and c["examples"][0].endswith(f": {count}")


# --------------------------------------------------------------------------------------- audit
def test_enrichment_contact_and_tag_writes_that_bypass_the_audit_log_fail(repo):
    gid = _ids(repo)[5]
    now = utcnow()
    _exec(repo,
          insert(enrichments).values(company_id=gid, source="osm", status="no_match", match_confidence=0, data={},
                                     source_urls=[], fetched_at=now - timedelta(hours=1)),
          insert(contacts).values(company_id=gid, source_key="raw-contact", name="Quiet Person", source="website",
                                  source_url="https://x.example", confidence=0.5, first_seen_at=now, last_seen_at=now),
          delete(audit_events).where(audit_events.c.entity_type == "tags", audit_events.c.company_id == gid))
    c = _checks(repo)
    label = _label(repo, gid)
    assert c["audit.enrichments"]["status"] == "fail" and c["audit.enrichments"]["examples"] == [f"{label}:osm"]
    assert c["audit.contacts"]["status"] == "fail" and "Quiet Person" in c["audit.contacts"]["examples"][0]
    assert c["audit.tags"]["status"] == "fail" and c["audit.tags"]["examples"] == [label]


@pytest.mark.parametrize("run_id,status,bucket", [(None, "fail", "no_run"), (999, "warn", "unknown_run"),
                                                  ("tag", "fail", "wrong_kind")])
def test_audit_events_need_an_existing_run_of_the_right_kind(repo, run_id, status, bucket):
    gid = _ids(repo)[0]
    rid = _run_id(repo, "tag") if run_id == "tag" else run_id
    _exec(repo, insert(audit_events).values(run_id=rid, entity_type="enrichment", entity_id=f"{gid}:fmcsa", company_id=gid,
                                            action="updated", changes={}, at=utcnow()))
    c = _checks(repo)["audit.run_ids"]
    assert c["status"] == status
    assert c["value"] == {"no_run": 0, "unknown_run": 0, "wrong_kind": 0, bucket: 1}
    assert len(c["examples"]) == 1 and c["examples"][0].startswith(f"enrichment {gid}:fmcsa")


def test_contractors_seen_before_the_audit_log_are_informational(repo):
    _exec(repo, delete(audit_events).where(audit_events.c.entity_type == "company", audit_events.c.action == "created"))
    c = _checks(repo)["audit.contractors"]
    assert c["status"] == "info" and c["value"] == "0/6"


# ------------------------------------------------------------------------------------- signals
def test_county_coverage_thresholds(repo, monkeypatch):
    gid = _ids(repo)[0]
    _exec(repo, update(companies).where(companies.c.id == gid).values(county_fips=None))
    c = _checks(repo)["signals.county_coverage"]
    assert c["status"] == "fail" and c["value"] == round(5 / 6, 4) and c["examples"][0].startswith(_label(repo, gid))
    monkeypatch.setattr(V, "COUNTY_WARN", 0.8)
    assert _checks(repo)["signals.county_coverage"]["status"] == "warn"


def test_every_lead_county_needs_a_recent_storm_summary(repo):
    rs = regional_signals.c
    _exec(repo, update(regional_signals).where(rs.county_fips == "34003", rs.kind == "storm_history")
          .values(fetched_at=utcnow() - timedelta(days=V.STORM_MAX_AGE_DAYS + 1)))
    assert _checks(repo)["signals.storm_history"]["status"] == "warn"
    _exec(repo, delete(regional_signals).where(rs.county_fips == "34003", rs.kind == "storm_history"))
    # Only the 24-month NOAA summary counts, not some other storm_history row for the county.
    store.upsert_signals(repo, [{"county_fips": "34003", "kind": "storm_history", "source": "manual_note",
                                 "external_id": "event_42", "payload": {"note": "hail"}}])
    c = _checks(repo)["signals.storm_history"]
    assert c["status"] == "fail" and c["value"] == "1/2" and c["examples"] == ["34003: missing"]


def test_nws_freshness_counts_alert_rows_and_empty_successful_fetches(repo):
    rs = regional_signals.c
    sig = _run_id(repo, "signals")
    old = utcnow() - timedelta(hours=30)
    _exec(repo, update(regional_signals).where(rs.source == "nws").values(fetched_at=old),
          update(scrape_runs).where(scrape_runs.c.id == sig).values(finished_at=old))
    c = _checks(repo)["signals.nws_freshness"]
    assert c["status"] == "warn" and c["value"] >= 30
    # A fresh run whose alerts step succeeded but found nothing still counts as a fetch.
    fresh = repo.start_run("signals", {})
    repo.finish_run(fresh, "succeeded", {"alerts": {"alerts": 0}, "errors": {}})
    assert _checks(repo)["signals.nws_freshness"]["status"] == "pass"
    failed = repo.start_run("signals", {})
    repo.finish_run(failed, "partial", {"alerts": None, "errors": {"alerts": "HttpError 503"}})
    _exec(repo, delete(scrape_runs).where(scrape_runs.c.id == fresh))
    assert _checks(repo)["signals.nws_freshness"]["status"] == "warn"


# ------------------------------------------------------------------------------------ coverage
def test_coverage_is_info_above_floor_and_warns_below(repo, monkeypatch):
    assert _checks(repo)["coverage.website"]["status"] == "info"
    monkeypatch.setitem(V.COVERAGE_FLOORS, "website", 0.8)
    monkeypatch.setitem(V.COVERAGE_FLOORS, "decision_maker_identified", 0.8)
    c = _checks(repo)
    assert c["coverage.website"]["status"] == "warn" and c["coverage.decision_maker"]["status"] == "warn"


# --------------------------------------------------------------------------------- consistency
def test_sources_naming_different_website_domains_warn(repo):
    gid = _ids(repo)[0]
    site = _site(fixture_contractors()[0])
    run = _run_id(repo, "enrich")
    repo.save_enrichment(gid, _ok("bbb", {"website": "http://golovin.com"}, 0.95, website="http://golovin.com",
                                  urls=["https://www.bbb.org/x"]), run_id=run)
    c = _checks(repo)["consistency.website_domain"]
    assert c["status"] == "warn" and c["value"] == "1/1" and "bbb=golovin.com" in c["examples"][0]
    # www / subdomain / scheme variants of the same site agree; directory pages are not a company site.
    repo.save_enrichment(gid, _ok("bbb", {}, 0.95, website=site.replace("https://www.", "http://shop."),
                                  urls=["https://www.bbb.org/x"]), run_id=run)
    repo.save_enrichment(gid, _ok("osm", {}, 0.9, website="https://facebook.com/golovin", urls=["https://osm.org/n/1"]),
                         run_id=run)
    assert _checks(repo)["consistency.website_domain"]["status"] == "pass"


def test_phone_conflicts_warn_above_twenty_percent(repo):
    run = _run_id(repo, "enrich")
    a, b = fixture_contractors()[:2]
    repo.save_enrichment(cid(repo, a.gaf_id), _ok("bbb", {"phone": a.phone}, 0.95, urls=["https://bbb.example/a"]), run_id=run)
    repo.save_enrichment(cid(repo, b.gaf_id), _ok("bbb", {"phone": "(212) 555-0100"}, 0.95, urls=["https://bbb.example/b"]),
                         run_id=run)
    c = _checks(repo)["consistency.phone"]
    assert c["status"] == "warn" and c["value"] == 0.5 and "2125550100" in c["examples"][0]
    repo.save_enrichment(cid(repo, b.gaf_id), _ok("nyc_dcwp", {"contact_phone": b.phone}, 0.9, urls=["https://dcwp.example/b"]),
                         run_id=run)
    assert _checks(repo)["consistency.phone"]["status"] == "pass"  # one source agreeing is enough


def test_phone_conflicts_at_exactly_twenty_percent_pass(repo):
    run = _run_id(repo, "enrich")
    cs = fixture_contractors()
    for i, c in enumerate(cs[:5]):  # 1 of 5 leads with a source phone disagrees -> 20.0%, not above it
        repo.save_enrichment(cid(repo, c.gaf_id), _ok("bbb", {"phone": "(212) 555-0100" if i == 0 else c.phone}, 0.95,
                                           urls=[f"https://bbb.example/{i}"]), run_id=run)
    c = _checks(repo)["consistency.phone"]
    assert c["value"] == 0.2 and c["status"] == "pass" and len(c["examples"]) == 1
    repo.save_enrichment(cid(repo, cs[5].gaf_id), _ok("bbb", {"phone": "(212) 555-0199"}, 0.95, urls=["https://bbb.example/5"]),
                         run_id=run)
    c = _checks(repo)["consistency.phone"]
    assert c["value"] == round(2 / 6, 4) and c["status"] == "warn"


def _add_contact(repo, gid, name, source, title="Founder & CEO"):
    repo.save_enrichment(gid, _ok(source if source != "website" else "website_crawl", {}, 0.9, urls=["https://s.example"],
                                  people=[Contact(name=name, title=title, source=source, source_url="https://s.example",
                                                  confidence=0.6)]), run_id=_run_id(repo, "enrich"))


def test_placeholder_contact_name_warns(repo):
    _add_contact(repo, _ids(repo)[4], "Thomas Smith", "website")
    c = _checks(repo)["consistency.template_names"]
    assert c["status"] == "warn" and c["value"]["placeholder"] == 1
    assert c["examples"][0].startswith("placeholder: Thomas Smith (Founder & CEO)")


def test_one_scraped_name_on_unrelated_companies_warns(repo):
    ids = _ids(repo)
    _add_contact(repo, ids[0], "Riley Quinn", "website")
    _add_contact(repo, ids[3], "Riley Quinn", "website")
    c = _checks(repo)["consistency.template_names"]
    assert c["status"] == "warn" and c["value"]["multi_company"] == 1 and c["examples"][0].startswith("Riley Quinn on")


def test_a_name_on_sister_listings_sharing_a_website_does_not_warn(repo):
    ids = _ids(repo)
    repo.set_website(ids[3], _site(fixture_contractors()[0]).replace("https://www.", "https://"), "website_discovery")
    _add_contact(repo, ids[0], "Riley Quinn", "website")
    _add_contact(repo, ids[3], "Riley Quinn", "website")
    assert _checks(repo)["consistency.template_names"]["status"] == "pass"


def test_repeated_names_that_are_plausibly_real_do_not_warn(repo):
    ids = _ids(repo)
    _add_contact(repo, ids[0], "Riley Golovin", "website", "Owner")  # surname is in one company's name
    _add_contact(repo, ids[2], "Riley Golovin", "website", "Owner")
    _add_contact(repo, ids[1], "Casey Officer", "fmcsa", "Company officer")  # registry filings only
    _add_contact(repo, ids[4], "Casey Officer", "fmcsa", "Company officer")
    c = _checks(repo)["consistency.template_names"]
    assert c["status"] == "pass"
    assert c["value"] == {"placeholder": 0, "multi_company": 0, "registry_multi_company": 1}


def test_one_registry_record_matched_to_two_leads_warns(repo):
    # The real-data case: FMCSA DOT 3896694 attached to RJS Construction (phone match) and RH Development (name).
    run = _run_id(repo, "enrich")
    a, b = _ids(repo)[:2]
    repo.save_enrichment(a, _ok("fmcsa", {"dot_number": "3896694"}, 0.99, urls=["https://dot.example"]), run_id=run)
    repo.save_enrichment(b, _ok("fmcsa", {"dot_number": "3896694"}, 0.75, urls=["https://dot.example"]), run_id=run)
    c = _checks(repo)["consistency.shared_records"]
    assert c["status"] == "warn" and c["value"] == 1
    assert c["examples"][0].startswith("fmcsa 3896694: " + _label(repo, a)) and c["examples"][0].endswith("@ 0.75")


# ------------------------------------------------------------------------------- report & CLI
def test_area_defaults_to_the_newest_search_run(repo):
    other = SearchArea(postal_code="07030", radius_miles=10, latitude=40.74, longitude=-74.03)
    rid = repo.start_run("gaf_ingest", {"postal_code": "07030", "radius_miles": 10.0})
    repo.record_search_hits(rid, other, [SearchHit(company_id=_ids(repo)[3], distance_miles=3.0, rank=1)])
    assert V.validate(repo, settings=SETTINGS)["area"] == {"postal_code": "07030", "radius_miles": 10.0,
                                                          "run_id": rid, "leads": 1}
    assert V.validate(repo, "10013", settings=SETTINGS)["area"]["run_id"] == 1


def test_database_without_a_search_run_fails_and_skips_lead_checks(tmp_path):
    report = V.validate(Repository(f"sqlite:///{tmp_path / 'empty.db'}"), settings=SETTINGS)
    c = {x["id"]: x for x in report["checks"]}
    assert c["integrity.area_run"]["status"] == "fail" and report["status"] == "fail"
    assert c["tagging.skipped"]["status"] == "info" and "tagging.untagged" not in c
    assert V.exit_code(report) == 1


def test_a_crashing_check_is_reported_as_a_failure(repo, monkeypatch):
    def boom(ctx):
        raise KeyError("x")

    monkeypatch.setattr(V, "CHECKS", (V.check_integrity, boom))
    c = {x["id"]: x for x in _run(repo)["checks"]}
    assert c["boom.error"]["status"] == "fail" and "KeyError" in c["boom.error"]["detail"]


def test_exit_code_warns_pass_unless_strict():
    def rep(**counts):
        return {"counts": {"pass": 1, "warn": 0, "fail": 0, "info": 0, **counts}}

    assert V.exit_code(rep()) == 0
    assert V.exit_code(rep(warn=2)) == 0 and V.exit_code(rep(warn=2), strict=True) == 1
    assert V.exit_code(rep(fail=1)) == 1


def test_cli_validate_prints_table_writes_json_and_honours_strict(repo, tmp_path, capsys):
    url = str(repo.engine.url)
    out = tmp_path / "out" / "report.json"
    assert main(["--db", url, "validate", "--zip", "10013", "--radius", "25", "--out", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "PASS    integrity.unique_gaf_id" in printed and printed.rstrip().endswith("-> PASS")
    saved = json.loads(out.read_text())
    assert saved["status"] == "pass" and len(saved["checks"]) > 30

    now = utcnow()
    _exec(repo, insert(jobs).values(kind="enrich", params={}, status="dead", run_after=now, created_at=now, error="x"))
    assert main(["--db", url, "validate"]) == 0
    assert "WARN    runs.dead_jobs" in capsys.readouterr().out
    assert main(["--db", url, "validate", "--strict"]) == 1

    _exec(repo, update(companies).values(segment="vip"))
    assert main(["--db", url, "validate"]) == 1
    lines = capsys.readouterr().out.splitlines()
    i = next(i for i, l in enumerate(lines) if l.startswith("FAIL    tagging.segment"))
    assert lines[i + 1].strip().startswith("- ") and "'vip'" in lines[i + 1]  # examples under failing rows


def test_cli_validate_refuses_to_create_a_missing_database(tmp_path, capsys):
    missing = tmp_path / "nope.db"
    assert main(["--db", f"sqlite:///{missing}", "validate"]) == 2
    assert not missing.exists() and "no database" in capsys.readouterr().err


# ------------------------------------------------------------- bug surfaced by validate on real data
def test_fmcsa_does_not_accept_a_different_company_sharing_only_a_generic_word():
    from leadmaker.enrich import fmcsa

    lead = {"name": "RH Development Corp", "phone": "(516) 376-3330", "postal_code": "11710", "city": "North Bellmore"}
    row = {"legal_name": "RJS CONSTRUCTION & DEVELOPMENT INC", "phone": "5162209242", "phy_zip": "11710",
           "phy_city": "BELLMORE"}
    conf, _ = fmcsa.score(lead, row)
    assert conf < fmcsa.MIN_CONFIDENCE
