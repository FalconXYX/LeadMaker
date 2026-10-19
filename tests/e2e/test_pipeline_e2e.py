"""End-to-end: the Section 1 user flow through `leadmaker.cli.main`, offline.

scrape -> enrich -> tag -> signals -> export (csv + json), then the operator commands
(stats / runs / sources / audit), the job queue (jobs, schedule, worker --once), the CRM
import and `validate`. All HTTP is served from tests/fixtures by the router in conftest.py;
every command writes only to a temporary SQLite database.
"""

from __future__ import annotations

import csv
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import func, select

from leadmaker import cli
from leadmaker.db.schema import regional_signals
from leadmaker.enrich import REGISTRY
from leadmaker.signals import counties as county_mod
from leadmaker.signals import storms, weather
from leadmaker.sources.gaf.parse import parse_listing_config

from dbutil import add_user, cid, gaf_ids

from .conftest import (
    ADH, BLUEMASTER_ID, CONTACT, COVEO_HOST, ENRICH_SOURCES, GEMZ_ID, GOLOVIN_ID, HAYDEN_ID, JERSEY_ID,
    LEAD_COUNTIES, TOPLINE_ID, ZIP_COUNTIES, _fixture, coveo_results, freeze_clock,
)

ADH_ID = ADH["gaf_id"]
REPO_ROOT = Path(__file__).resolve().parents[2]
COVEO_ORDER = [r["raw"]["gaf_contractor_id"] for r in coveo_results()]
SEGMENTS = {"strategic", "growth", "emerging", "long_tail"}
UNPROFILED = {GOLOVIN_ID, HAYDEN_ID, BLUEMASTER_ID, JERSEY_ID, TOPLINE_ID}  # their profile pages 404


def _csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), list(reader)


def _json_docs(text: str) -> list[object]:
    """Commands that print several JSON documents in a row (e.g. `run`)."""
    dec, docs, i = json.JSONDecoder(), [], 0
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        doc, i = dec.raw_decode(text, i)
        docs.append(doc)
    return docs


def _subcommands() -> set[str]:
    parser = cli.build_parser()
    action = next(a for a in parser._actions if a.dest == "command")
    return set(action.choices)


# ------------------------------------------------------------------------------- scrape
def test_scrape_reads_the_whole_area_and_records_profile_failures_per_contractor(pipeline):
    r = pipeline.steps["scrape"]
    assert r.rc == 0
    s = r.json
    assert s["status"] == "partial"  # 5 profile pages 404; the run is still a usable, complete area read
    assert s["area"]["geocoder"] == "builtin"  # zippopotam 404 -> built-in 10013 centroid
    assert s["coveo_config_discovered"] is True
    assert s["completeness"]["complete"] is True and s["completeness"]["hits_recorded"] is True
    assert (s["coveo_total"], s["results"], s["parsed"], s["parse_errors"]) == (7, 7, 7, 0)
    assert s["upsert"] == {"new": 7, "changed": 0, "unchanged": 0}
    assert s["delisted"] == 0 and s["gaf_recommended"] == 3
    assert s["profiles"] == {"due": 7, "fetched": 2, "failed": 5, "skipped_fresh": 0}

    rows = {c["gaf_id"]: c for c in pipeline.cli.repo().get_companies()}
    assert set(rows) == set(COVEO_ORDER)
    # Profile facts land on the contractor row; failures are recorded, not fatal.
    assert (rows[ADH_ID]["legal_name"], rows[ADH_ID]["in_business_since"]) == ("Makabad Corp", 2015)
    assert rows[GEMZ_ID]["legal_name"] == "Gemz Construction Corp"
    assert all(rows[g]["profile_scraped_at"] for g in (ADH_ID, GEMZ_ID))
    assert all("404" in rows[g]["profile_error"] for g in UNPROFILED)
    assert all(rows[g]["profile_scraped_at"] is None for g in UNPROFILED)

    leads = pipeline.cli.repo().lead_records("10013", 25)
    assert [l["gaf_id"] for l in leads] == COVEO_ORDER  # area view keeps Coveo's order
    ranks = {l["gaf_id"]: l["gaf_recommended_rank"] for l in leads if l["gaf_recommended"]}
    assert ranks == {JERSEY_ID: 1, ADH_ID: 2, HAYDEN_ID: 3}


def test_scrape_queries_coveo_with_the_listing_page_key_and_the_requested_area(pipeline):
    calls = pipeline.calls_by_step["scrape"]
    assert {c.host for c in calls} == {"api.zippopotam.us", "www.gaf.com", COVEO_HOST}
    key = parse_listing_config(_fixture("gaf_listing.html")).api_key
    coveo = [c for c in calls if c.host == COVEO_HOST]
    assert len(coveo) == 2  # one distance-sorted area page (7 < 500) + the recommended ranking
    assert all(c.headers["Authorization"] == f"Bearer {key}" for c in coveo)
    assert all("@distanceinmiles <= 25.0" in c.json["aq"] for c in coveo)
    area = next(c for c in coveo if "sortCriteria" in c.json)
    assert "40.7185, -74.0025" in area.json["queryFunctions"][0]["function"]
    assert area.json["sortCriteria"] == "@distanceinmiles ascending"
    profile_gets = [c for c in calls if c.host == "www.gaf.com" and "/residential/usa/" in c.url]
    assert len(profile_gets) == 7  # exactly one fetch per contractor, no retries


def test_rescrape_is_idempotent_and_only_refetches_missing_profiles(built):
    r = built("scrape")
    assert r.rc == 0
    s = r.json
    assert s["upsert"] == {"new": 0, "changed": 0, "unchanged": 7}
    assert s["delisted"] == 0
    assert s["completeness"]["previous"] == {"run_id": 1, "results": 7}  # the first run is the baseline
    assert s["profiles"] == {"due": 5, "fetched": 0, "failed": 5, "skipped_fresh": 2}
    added = [e for e in built.repo().audit_log(run_id=s["run_id"]) if e["entity_type"] == "company"]
    assert added == []  # nothing changed, so nothing is audited


def test_scrape_profile_flags_cap_and_force_the_profile_refetch(built):
    capped = built("scrape", "--max-profiles", "3")
    assert capped.rc == 0
    assert capped.json["profiles"] == {"due": 3, "fetched": 0, "failed": 3, "skipped_fresh": 4}
    gets = [c.url for c in built.router.calls if "/residential/usa/" in c.url]
    assert len(gets) == 3 and not any(ADH_ID in u or GEMZ_ID in u for u in gets)  # fresh profiles are skipped

    before = len(built.router.calls)
    forced = built("scrape", "--force-profiles")
    assert forced.rc == 0
    assert forced.json["profiles"] == {"due": 7, "fetched": 2, "failed": 5, "skipped_fresh": 0}
    regets = [c.url for c in built.router.calls[before:] if "/residential/usa/" in c.url]
    assert len(regets) == 7 and ADH["uri"] in regets


def test_scrape_rejects_lat_lng_override_for_several_zips(offline):
    r = offline("scrape", "--zip", "10013", "--also-zip", "07030", "--lat", "40.7", "--lng", "-74.0")
    assert r.rc == 2
    assert "--lat/--lng only apply to a single --zip" in r.err
    assert offline.router.calls == [] and offline.repo().list_runs() == []


def test_multi_zip_scrape_merges_overlapping_areas_on_contractor_id(offline):
    offline.router.add("GET", "https://api.zippopotam.us/us/10014",  # a neighbouring ZIP, same contractors
                       (200, json.dumps({"places": [{"latitude": "40.7340", "longitude": "-74.0054"}]})))
    r = offline("scrape", "--zip", "10013", "--also-zip", "10014", "--no-profiles")
    assert r.rc == 0
    first, second = _json_docs(r.out)
    assert (first["area"]["postal_code"], second["area"]["postal_code"]) == ("10013", "10014")
    assert second["area"]["geocoder"] == "zippopotam"
    assert first["upsert"]["new"] == 7 and second["upsert"] == {"new": 0, "changed": 0, "unchanged": 7}
    assert len(offline.repo().get_companies()) == 7
    assert len(offline.repo().lead_records("10014", 25)) == 7


def test_multi_zip_scrape_reports_a_failed_zip_and_still_scrapes_the_rest(offline):
    r = offline("scrape", "--zip", "99999", "--also-zip", "10013", "--no-profiles")  # 99999 cannot geocode
    assert r.rc == 1
    assert [(x["kind"], x["status"]) for x in offline.repo().list_runs()] == [
        ("gaf_ingest", "succeeded"), ("gaf_ingest", "failed")]
    assert len(offline.repo().get_companies()) == 7


def test_unknown_job_kind_is_a_usage_error(offline):
    with pytest.raises(SystemExit) as e:
        offline("jobs", "enqueue", "bogus")
    assert e.value.code == 2


# ------------------------------------------------------------------------------- enrich
def test_enrich_matches_registries_through_the_profile_legal_name(pipeline):
    r = pipeline.steps["enrich"]
    assert r.rc == 0
    s = r.json
    assert s["status"] == "succeeded" and s["contractors"] == 7
    assert s["by_source"] == {
        "osm": {"no_match": 7},
        "nyc_dcwp": {"ok": 1, "no_match": 6},
        "ny_dos": {"ok": 1, "no_match": 6},
        "fmcsa": {"ok": 1, "no_match": 6},
        "website_crawl": {"skipped": 7},  # no lead has a website yet
        "llm_extract": {},
    }
    assert set(s["disabled"]) == {"llm_extract"}
    assert "no LLM provider configured" in s["disabled"]["llm_extract"]

    repo = pipeline.cli.repo()
    adh_cid, jersey_cid = cid(repo, ADH_ID), cid(repo, JERSEY_ID)
    adh = repo.get_enrichments([adh_cid])[adh_cid]
    # GAF lists "ADH Group"; only the profile's legal name "Makabad Corp" finds the licence and filing.
    assert adh["nyc_dcwp"]["status"] == "ok" and adh["nyc_dcwp"]["data"]["license_number"] == "2083986-DCA"
    assert adh["ny_dos"]["status"] == "ok" and adh["ny_dos"]["data"]["dos_id"] == "4688117"
    assert repo.get_enrichments([jersey_cid])[jersey_cid]["fmcsa"]["data"]["dot_number"] == "111"

    contacts = {l["gaf_id"]: l["contacts"] for l in repo.lead_records("10013", 25)}
    assert [(c["name"], c["source"]) for c in contacts[ADH_ID]] == [("Andres Abadia", "ny_dos")]
    assert [(c["name"], c["source"], c["email"]) for c in contacts[JERSEY_ID]] == [
        ("John Q Public", "fmcsa", "owner@example.com")]
    assert sum(len(v) for v in contacts.values()) == 2


def test_enrich_contacts_only_the_selected_sources(pipeline):
    hosts = {c.host for c in pipeline.calls_by_step["enrich"]}
    assert hosts == {"data.cityofnewyork.us", "data.ny.gov", "data.transportation.gov", "overpass-api.de"}
    assert not [c for c in pipeline.calls_by_step["enrich"] if c in pipeline.cli.router.unrouted]


def test_enrich_rerun_reuses_fresh_results_and_force_is_idempotent(built):
    again = built("enrich", "--sources", ENRICH_SOURCES)
    assert again.rc == 0
    by = again.json["by_source"]
    assert {k: v for k, v in by.items() if k != "llm_extract"} == {
        k: {"fresh": 7} for k in ("osm", "nyc_dcwp", "ny_dos", "fmcsa", "website_crawl")}

    forced = built("enrich", "--sources", "nyc_dcwp,ny_dos", "--force", "--gaf-id", ADH_ID)
    assert forced.rc == 0
    assert forced.json["contractors"] == 1
    assert forced.json["by_source"] == {"nyc_dcwp": {"ok": 1}, "ny_dos": {"ok": 1}}
    assert built.repo().summary()["contacts"] == 2  # re-found contact is upserted, not duplicated


def test_enrich_limit_processes_only_the_nearest_contractors(built):
    r = built("enrich", "--sources", "nyc_dcwp", "--force", "--limit", "2")
    assert r.rc == 0
    assert r.json["contractors"] == 2 and sum(r.json["by_source"]["nyc_dcwp"].values()) == 2


def test_enrich_rejects_an_unknown_source(offline):
    with pytest.raises(ValueError, match="unknown enrichers"):
        offline("enrich", "--sources", "nope")


# ---------------------------------------------------------------------------------- tag
def test_tag_gives_every_lead_a_segment_priority_and_target_contact(pipeline):
    r = pipeline.steps["tag"]
    assert r.rc == 0
    s = r.json
    assert (s["tagged"], s["failed"]) == (7, 0)
    assert sum(s["segments"].values()) == 7 and set(s["segments"]) <= SEGMENTS
    assert s["account_status"] == {"prospect": 7}  # no CRM import yet

    rows = {c["gaf_id"]: c for c in pipeline.cli.repo().get_companies()}
    for gid, row in rows.items():
        assert row["segment"] in SEGMENTS, gid
        assert 0 <= row["priority_score"] <= 100, gid
        keys = {t["key"] for t in row["tags"]}
        assert {"gaf_tier", "decision_maker", "target_contact", "account_status", "priority_drivers"} <= keys

    def target(gid):
        return next(t for t in rows[gid]["tags"] if t["key"] == "target_contact")["contact"]

    assert (target(JERSEY_ID)["name"], target(JERSEY_ID)["source"], target(JERSEY_ID)["named"]) == (
        "John Q Public", "fmcsa", True)
    assert (target(ADH_ID)["name"], target(ADH_ID)["source"]) == ("Andres Abadia", "ny_dos")
    fallback = target(GOLOVIN_ID)
    assert fallback["named"] is False and fallback["phone"] == "(959) 237-0800" and fallback["phone_is_main_line"]
    # Master Elite + 474 five-star reviews + a named owner outranks an unreviewed Certified firm.
    assert rows[JERSEY_ID]["segment"] == "strategic"
    assert rows[JERSEY_ID]["priority_score"] > rows[GOLOVIN_ID]["priority_score"]


def test_tag_rules_file_adds_custom_tags_and_shifts_priority(built, tmp_path):
    before = {c["gaf_id"]: c["priority_score"] for c in built.repo().get_companies()}
    assert before[JERSEY_ID] >= 10
    rules = tmp_path / "rules.json"
    rules.write_text(json.dumps([{"key": "nj_lead", "label": "NJ lead", "category": "custom",
                                  "priority_boost": -10, "when": {"field": "state", "eq": "NJ"}}]))
    r = built("tag", "--rules", str(rules))
    assert r.rc == 0
    assert (r.json["custom_rules"], r.json["leads_matching_custom_rules"]) == (1, 1)
    rows = {c["gaf_id"]: c for c in built.repo().get_companies()}
    tagged = {g for g, c in rows.items() if any(t["key"] == "nj_lead" for t in c["tags"])}
    assert tagged == {JERSEY_ID}  # the only NJ lead
    assert rows[JERSEY_ID]["priority_score"] == pytest.approx(before[JERSEY_ID] - 10)
    assert all(rows[g]["priority_score"] == before[g] for g in rows if g != JERSEY_ID)


# ------------------------------------------------------------------------------ signals
def test_signals_assigns_counties_and_stores_alerts_storms_and_news(pipeline):
    r = pipeline.steps["signals"]
    assert r.rc == 0
    s = r.json
    assert s["status"] == "succeeded" and s["errors"] == {}
    c = s["counties"]
    assert (c["leads"], c["assigned"], c["unmapped"], c["split"], c["counties"]) == (7, 7, 0, 0, 4)
    assert c["point_check"] == {"checked": 0, "changed": 0}  # every ZIP has a whole-county ZCTA
    assert s["alerts"]["counties"] == 4 and s["alerts"]["rows_written"] == 1  # Nassau coastal flood statement
    st = s["storm_history"]
    assert st["counties"] == 4 and st["rows_written"] == 4
    assert st["ncei_missing_years"] == [2024, 2025] and st["lsr_offices"] == ["OKX"] and st["lsr_error"] is None
    assert st["window_start"] == "2024-10-18" and st["as_of"] == "2026-10-18"
    assert s["news"] == {"rows": 1, "rows_written": 1}

    repo = pipeline.cli.repo()
    fips = {row["gaf_id"]: row["county_fips"] for row in repo.get_companies()}
    by_zip = {row["gaf_id"]: row["postal_code"] for row in repo.get_companies()}
    assert fips == {g: ZIP_COUNTIES[z][0] for g, z in by_zip.items()}

    with repo.engine.connect() as conn:
        kinds = conn.execute(select(regional_signals.c.county_fips, regional_signals.c.kind,
                                    regional_signals.c.source)).all()
    assert sorted(k for k in kinds if k.kind == storms.KIND) == sorted(
        (f, storms.KIND, storms.SOURCE) for f in LEAD_COUNTIES)
    assert [(k.county_fips, k.source) for k in kinds if k.kind == "news"] == [("34003", "gdelt")]
    assert [(k.county_fips, k.source) for k in kinds if k.kind == weather.KIND] == [("36059", "nws")]
    bergen = next(row for row in repo.lead_records("10013", 25) if row["gaf_id"] == JERSEY_ID)
    assert bergen["county_fips"] == "34003"


def test_signals_identifies_itself_to_nws_with_two_requests_per_run(pipeline):
    calls = pipeline.calls_by_step["signals"]
    nws = [c for c in calls if c.host == weather.HOST]
    assert [c.url for c in nws] == [weather.HISTORY_URL, weather.ACTIVE_URL]
    assert all(c.headers["User-Agent"] == CONTACT for c in nws)  # LEADMAKER_CONTACT
    assert {c.params["zone"] for c in nws} == {"NJC003,NYC059,NYC081,NYC087"}
    assert len([c for c in calls if c.host == storms.LSR_HOST]) == 1  # IEM asks for a 120 s crawl delay
    assert len([c for c in calls if c.url == county_mod.REL_URL]) == 1


def test_signals_rerun_reuses_cached_reference_files_and_fresh_storm_history(built):
    repo = built.repo()
    with repo.engine.connect() as conn:
        before = conn.execute(select(func.count()).select_from(regional_signals)).scalar()
    r = built("signals", "--no-news")
    assert r.rc == 0
    s = r.json
    assert s["status"] == "succeeded" and "news" not in s
    assert s["storm_history"] == {"skipped": "fresh (< 30 days)", "counties": 4}
    assert s["counties"]["already_set"] == 7 and s["counties"]["assigned"] == 0
    hosts = {c.host for c in built.router.calls}
    assert hosts == {weather.HOST}  # county index cached, storms fresh, news off
    with repo.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(regional_signals)).scalar() == before


def test_split_zcta_leads_are_confirmed_by_point_unless_disabled(built):
    from sqlalchemy import update

    from leadmaker.db.schema import companies

    jersey = cid(built.repo(), JERSEY_ID)
    with built.repo().engine.begin() as conn:  # Jersey Roofing moves to 07060, a ZCTA split over 3 counties
        conn.execute(update(companies).where(companies.c.id == jersey)
                     .values(postal_code="07060", county_fips=None))
    built.router.add("GET", county_mod.GEOCODER_URL, (200, _fixture("zcta_geocoder_point_somerset.json")))

    off = built("signals", "--no-news", "--no-point-check")
    assert off.rc == 0 and off.json["counties"]["split"] == 1 and "point_check" not in off.json["counties"]
    assert not built.router.to(county_mod.GEOCODER_HOST)
    assert built.repo().get_companies([jersey])[0]["county_fips"] == "34039"  # Union: largest land share

    with built.repo().engine.begin() as conn:
        conn.execute(update(companies).where(companies.c.id == jersey).values(county_fips=None))
    on = built("signals", "--no-news")
    assert on.rc == 0 and on.json["counties"]["point_check"] == {"checked": 1, "changed": 1, "failed": 0}
    assert len(built.router.to(county_mod.GEOCODER_HOST)) == 1
    assert built.repo().get_companies([jersey])[0]["county_fips"] == "34035"  # the geocoder's answer


def test_signals_exits_nonzero_when_the_county_index_cannot_load(built):
    (built.workdir / "cache" / county_mod.REL_FILE).unlink()
    built.router.add("GET", county_mod.REL_URL, (200, "<html>Request Rejected</html>"))
    r = built("signals", "--no-news")
    assert r.rc == 1
    assert r.json["status"] == "failed" and "unexpected ZCTA relationship file" in r.json["errors"]["run"]
    run = built.repo().list_runs(1)[0]
    assert (run["kind"], run["status"]) == ("signals", "failed") and "ZCTA" in run["error"]


def test_recent_roof_storm_reports_put_a_timing_badge_on_leads_in_that_county(built, monkeypatch, tmp_path):
    aug = datetime(2026, 8, 5, 16, 0, tzinfo=timezone.utc)
    freeze_clock(monkeypatch, aug)
    empty = (200, json.dumps({"features": []}))
    built.router.add("GET", weather.HISTORY_URL, empty)
    built.router.add("GET", weather.ACTIVE_URL, empty)

    r = built("signals", "--force-storms", "--no-news")
    assert r.rc == 0 and r.json["storm_history"]["as_of"] == "2026-08-05"
    out = tmp_path / "aug.json"
    assert built("export", "--out", str(out)).rc == 0
    timing = {l["gaf_id"]: {b["key"]: b for b in l["timing"]} for l in json.loads(out.read_text())}

    badge = timing[JERSEY_ID]["recent_storm"]  # Bergen: Jul 21 + Jul 27 hail and wind reports
    assert badge["label"] == "Recent storm activity"
    assert badge["reason"].startswith("3 roof-relevant storm reports in this county in the last 30 days")
    assert "NWS storm report" in badge["reason"]
    assert all("recent_storm" not in t for g, t in timing.items() if g != JERSEY_ID)
    assert all(t["season"]["label"] == "In season: service & storm response" for t in timing.values())


# ------------------------------------------------------------------------------- export
def test_export_csv_has_the_documented_columns_and_a_scored_row_per_lead(pipeline):
    assert pipeline.steps["export_csv"].rc == 0
    assert pipeline.steps["export_csv"].out.strip() == f"wrote 7 leads to {pipeline.csv_path}"
    header, rows = _csv(pipeline.csv_path)
    assert header == cli.EXPORT_COLUMNS
    assert {"target_contact", "county_fips", "timing", "segment", "priority_score"} <= set(header)
    assert [r["gaf_id"] for r in rows] == COVEO_ORDER and [r["rank"] for r in rows] == [str(i) for i in range(1, 8)]
    for r in rows:
        assert r["segment"] in SEGMENTS, r["gaf_id"]
        assert 0 <= float(r["priority_score"]) <= 100, r["gaf_id"]
        assert r["county_fips"] == ZIP_COUNTIES[r["postal_code"]][0]  # leading-zero ZIPs survive
        assert r["target_contact"], r["gaf_id"]
        assert "In season: service & storm response" in r["timing"]  # October, NY/NJ
        assert "Net-new prospect" in r["tag_labels"]
    by = {r["gaf_id"]: r for r in rows}
    assert by[JERSEY_ID]["target_contact"] == "John Q Public (Company officer (FMCSA MCS-150), fmcsa)"
    assert by[JERSEY_ID]["decision_makers"] == "John Q Public (Company officer (FMCSA MCS-150), fmcsa)"
    assert by[ADH_ID]["target_contact"] == "Andres Abadia (Chairman/CEO (NY DOS filing), ny_dos)"
    assert by[GOLOVIN_ID]["target_contact"] == "Owner (name unknown), main line (959) 237-0800"
    assert by[ADH_ID]["legal_name"] == "Makabad Corp" and by[ADH_ID]["in_business_since"] == "2015"
    assert by[JERSEY_ID]["gaf_recommended"] == "True" and by[GOLOVIN_ID]["gaf_recommended"] == "False"


def test_export_json_carries_the_same_leads_with_structured_detail(pipeline):
    assert pipeline.steps["export_json"].rc == 0
    leads = json.loads(pipeline.json_path.read_text())
    _, rows = _csv(pipeline.csv_path)
    assert [l["gaf_id"] for l in leads] == [r["gaf_id"] for r in rows]
    for lead, row in zip(leads, rows):
        assert lead["segment"] == row["segment"] and float(row["priority_score"]) == lead["priority_score"]
        assert "raw" not in lead
        tc = next(t for t in lead["tags"] if t["key"] == "target_contact")
        assert {"role", "named", "phone", "status"} <= set(tc["contact"])
        assert lead["timing"] and all({"key", "label", "reason", "source", "severity"} <= set(b) for b in lead["timing"])
    adh = next(l for l in leads if l["gaf_id"] == ADH_ID)
    assert adh["enrichment"]["nyc_dcwp"]["data"]["license_status"] == "Active"
    assert len(adh["reviews"]) == 3


def test_export_creates_missing_output_directories(built, tmp_path):
    out = tmp_path / "deep" / "er" / "leads.csv"
    r = built("export", "--format", "csv", "--out", str(out))
    assert r.rc == 0 and out.exists()
    assert len(_csv(out)[1]) == 7


def test_export_never_returns_leads_outside_the_requested_area(built, tmp_path):
    out = tmp_path / "ten_miles.csv"
    r = built("export", "--format", "csv", "--zip", "10013", "--radius", "10", "--out", str(out))
    assert r.rc == 0
    rows = _csv(out)[1]
    # Only a 25-mile read exists. Today all 7 leads come back, unranked and without distances.
    assert all(row["distance_miles"] and float(row["distance_miles"]) <= 10 for row in rows), [
        (row["name"], row["distance_miles"]) for row in rows]


# ---------------------------------------------------------- stats / runs / sources / audit
def test_stats_runs_sources_and_audit_report_the_pipeline(pipeline):
    run = pipeline.cli
    stats = run("stats")
    assert stats.rc == 0
    summary = stats.json
    assert summary.pop("updated_in_last_poll") == 7  # every lead is new in the only complete read
    assert summary.pop("outbox_unpublished") > 0  # no relay runs offline
    assert summary == {
        "companies": 7, "by_tier": {"certified": 4, "master_elite": 3}, "profiles_scraped": 2,
        "with_website": 0, "contacts": 2, "reviews": 3,
        "enrichment": {"fmcsa": {"no_match": 6, "ok": 1}, "ny_dos": {"no_match": 6, "ok": 1},
                       "nyc_dcwp": {"no_match": 6, "ok": 1}, "osm": {"no_match": 7},
                       "website_crawl": {"skipped": 7}},
    }

    runs = run("runs", "--limit", "10").json
    assert [(r["kind"], r["status"]) for r in runs] == [
        ("signals", "succeeded"), ("tag", "succeeded"), ("enrich", "succeeded"), ("gaf_ingest", "partial")]
    assert all(r["finished_at"] for r in runs)
    assert len(run("runs", "--limit", "2").json) == 2

    sources = {s["source"]: s for s in run("sources").json}
    assert set(sources) == set(REGISTRY)
    assert sources["llm_extract"]["enabled"] is False and "GEMINI_API_KEY" in sources["llm_extract"]["reason"]
    assert all(s["enabled"] for name, s in sources.items() if name != "llm_extract")
    assert sources["ny_dos"]["depends_on"] == ["nyc_dcwp"]

    first_run = run("audit", "--run-id", "1", "--limit", "500").json
    assert {e["run_id"] for e in first_run} == {1}  # --run-id filters (enrich/tag events belong to runs 2-3)
    created = [e["company_id"] for e in first_run if e["entity_type"] == "company" and e["action"] == "created"]
    added = sorted(gaf_ids(run.repo(), created))
    assert added == sorted(COVEO_ORDER)
    adh = run("audit", "--gaf-id", ADH_ID, "--limit", "100").json
    assert {(e["entity_type"], e["run_id"]) for e in adh} >= {("company", 1), ("enrichment", 2), ("contact", 2),
                                                            ("tags", 3)}
    assert all(e["company_id"] == cid(run.repo(), ADH_ID) for e in adh)
    assert len(run("audit", "--limit", "3").json) == 3


def test_db_flag_wins_over_database_url(built, monkeypatch, tmp_path):
    other = tmp_path / "elsewhere.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{other}")
    assert built("stats").json["companies"] == 7
    assert not other.exists()


# ------------------------------------------------------------------ jobs / schedule / worker
def test_jobs_enqueue_dedupes_per_area_and_lists_the_queue(built):
    first = built("jobs", "enqueue", "tag", "--zip", "10013")
    assert first.rc == 0 and first.json == {"enqueued": [1], "deduplicated": 0}
    assert built("jobs", "enqueue", "tag", "--zip", "10013").json == {"enqueued": [], "deduplicated": 1}
    multi = built("jobs", "enqueue", "scrape", "--zip", "10013", "--also-zip", "07030", "--priority", "5")
    assert multi.json == {"enqueued": [2, 3], "deduplicated": 0}

    jobs = built("jobs", "list").json
    assert [(j["id"], j["kind"], j["status"]) for j in jobs] == [(3, "scrape", "queued"), (2, "scrape", "queued"),
                                                                 (1, "tag", "queued")]
    assert jobs[0]["params"] == {"postal_code": "07030", "radius_miles": 25.0} and jobs[0]["priority"] == 5
    assert built("jobs", "list", "--status", "succeeded").json == []
    assert built("jobs", "retry-dead").json == {"requeued": 0}


def test_jobs_enqueue_applies_the_per_rep_hourly_limit(built, monkeypatch):
    monkeypatch.setenv("LEADMAKER_USER_JOBS_PER_HOUR", "1")
    rep7, rep8 = add_user(built.repo(), "Rep Seven"), add_user(built.repo(), "Rep Eight")
    assert built("jobs", "enqueue", "tag", "--requested-by", rep7).rc == 0
    limited = built("jobs", "enqueue", "enrich", "--requested-by", rep7)
    assert limited.rc == 2
    assert limited.json == {"enqueued": [], "deduplicated": 0, "rate_limited": True}
    assert f"{rep7} reached the limit of 1 on-demand jobs per hour" in limited.err
    merged = built("jobs", "enqueue", "tag", "--requested-by", rep7)  # joins the open job: free
    assert merged.rc == 0 and merged.json == {"enqueued": [], "deduplicated": 1}
    assert built("jobs", "enqueue", "enrich", "--requested-by", rep8).rc == 0  # limits are per rep


def test_schedule_and_worker_once_run_due_and_queued_jobs(built):
    added = built("schedule", "add", "--name", "nightly-tag", "--kind", "tag", "--every-hours", "24")
    assert added.rc == 0 and added.json == {"schedule_id": 1}
    (sched,) = built("schedule", "list").json
    assert (sched["name"], sched["kind"], sched["enabled"]) == ("nightly-tag", "tag", True)
    assert sched["params"] == {"postal_code": "10013", "radius_miles": 25.0}
    rep1 = add_user(built.repo(), "Rep One")
    assert built("jobs", "enqueue", "signals", "--requested-by", rep1).json["enqueued"] == [1]

    w = built("worker", "--once", "--worker-id", "e2e-worker")
    assert w.rc == 0 and "processed 2 job(s)" in w.err
    jobs = {j["kind"]: j for j in built("jobs", "list").json}
    assert {k: (j["status"], j["attempts"]) for k, j in jobs.items()} == {"signals": ("succeeded", 1),
                                                                        "tag": ("succeeded", 1)}
    assert jobs["tag"]["schedule_id"] == 1 and jobs["tag"]["result"]["tag"]["tagged"] == 7
    assert jobs["signals"]["requested_by"] == rep1
    assert jobs["signals"]["result"]["signals"]["status"] == "succeeded"

    (sched,) = built("schedule", "list").json
    assert sched["last_enqueued_at"] is not None
    next_run = datetime.fromisoformat(str(sched["next_run_at"])).replace(tzinfo=timezone.utc)
    # One step of --every-hours from when it was due (added moments ago): not later, not a skipped slot.
    assert timedelta(hours=23) < next_run - datetime.now(timezone.utc) <= timedelta(hours=24)

    idle = built("worker", "--once")
    assert idle.rc == 0 and "processed 0 job(s)" in idle.err  # not due again, queue empty
    assert built("schedule", "disable", "--name", "nightly-tag").json == {"updated": True}
    assert built("schedule", "list").json[0]["enabled"] is False
    assert built("schedule", "enable", "--name", "missing").json == {"updated": False}


def test_failing_jobs_go_dead_after_three_attempts_and_retry_dead_requeues_by_id(offline):
    from sqlalchemy import update

    from leadmaker.db.schema import jobs

    assert offline("jobs", "enqueue", "scrape", "--zip", "99999", "--also-zip", "99998").json["enqueued"] == [1, 2]
    for _ in range(3):  # neither ZIP can geocode; skip the backoff wait between attempts
        with offline.repo().engine.begin() as conn:
            conn.execute(update(jobs).values(run_after=datetime(2020, 1, 1)))
        assert "processed 2 job(s)" in offline("worker", "--once").err
    dead = offline("jobs", "list", "--status", "dead").json
    assert sorted((j["id"], j["attempts"]) for j in dead) == [(1, 3), (2, 3)]

    assert offline("jobs", "retry-dead", "--job-id", "1").json == {"requeued": 1}
    assert [j["id"] for j in offline("jobs", "list", "--status", "dead").json] == [2]
    (requeued,) = offline("jobs", "list", "--status", "queued").json
    assert (requeued["id"], requeued["attempts"]) == (1, 0)


def test_worker_max_jobs_stops_after_that_many_jobs(built):
    assert built("jobs", "enqueue", "tag", "--zip", "10013", "--also-zip", "10014").json["enqueued"] == [1, 2]
    w = built("worker", "--once", "--max-jobs", "1")
    assert w.rc == 0 and "processed 1 job(s)" in w.err
    assert sorted(j["status"] for j in built("jobs", "list").json) == ["queued", "succeeded"]


def test_worker_runs_an_on_demand_pipeline_job_from_an_empty_database(offline):
    assert offline("jobs", "enqueue", "pipeline", "--sources", "nyc_dcwp,ny_dos").json["enqueued"] == [1]
    w = offline("worker", "--once", "--max-jobs", "5")
    assert w.rc == 0 and "processed 1 job(s)" in w.err
    (job,) = offline("jobs", "list").json
    assert job["status"] == "succeeded" and job["error"] is None
    res = job["result"]
    assert res["scrape"]["status"] == "partial" and res["scrape"]["upsert"] == {"new": 7, "changed": 0, "unchanged": 0}
    assert res["enrich"]["by_source"] == {"nyc_dcwp": {"ok": 1, "no_match": 6}, "ny_dos": {"ok": 1, "no_match": 6}}
    assert res["tag"]["tagged"] == 7
    rows = offline.repo().get_companies()
    assert len(rows) == 7 and all(r["segment"] in SEGMENTS for r in rows)


def test_worker_requeues_a_failed_job_with_backoff(offline):
    offline("jobs", "enqueue", "scrape", "--zip", "99999")  # no geocoder answer and no built-in centroid
    w = offline("worker", "--once")
    assert w.rc == 0 and "processed 1 job(s)" in w.err
    (job,) = offline("jobs", "list").json
    assert (job["status"], job["attempts"]) == ("queued", 1)  # 1 of 3 attempts used
    assert job["error"].startswith("GeocodeError: could not geocode US 99999")
    run_after = datetime.fromisoformat(str(job["run_after"])).replace(tzinfo=timezone.utc)
    assert run_after > datetime.now(timezone.utc)  # backoff: not picked up again right away
    assert "processed 0 job(s)" in offline("worker", "--once").err
    (run,) = offline.repo().list_runs()
    assert (run["kind"], run["status"]) == ("gaf_ingest", "failed")


# ------------------------------------------------------------------------------ accounts
def test_accounts_import_of_the_template_maps_every_crm_column(built):
    r = built("accounts", "import", str(REPO_ROOT / "examples" / "accounts_template.csv"))
    assert r.rc == 0
    s = r.json
    assert (s["rows"], s["matched"], s["unmatched"]) == (0, 0, 0)
    assert set(s["headers_mapped"]) == {"account_id", "name", "phone", "postal_code", "city", "state", "status",
                                        "owner_rep", "annual_spend", "last_order_at"}


def test_crm_import_then_retag_marks_customers_and_zeroes_do_not_contact(built, tmp_path):
    crm = tmp_path / "crm.csv"
    recent = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")  # account status uses the real clock
    crm.write_text(
        "Account Number,Account Name,Main Phone,Zip,City,State,Status,Sales Rep,TTM Sales,Last Order Date\n"
        f'A-100,Jersey Roofing,(201) 982-2718,07026,Garfield,NJ,Active,Dana Rep,"$650,000",{recent}\n'
        "A-200,Golovin Roofing LLC,,11358,Flushing,NY,Do Not Contact,,,\n"
        'A-300,Hayden Building Maintenance Corp,(845) 353-3400,10983,Tappan,NY,Active,,"$40,000",2024-01-15\n'
        "A-400,Some Other Roofer Inc,(555) 010-0000,10001,New York,NY,Active,,,\n"
    )
    imp = built("accounts", "import", str(crm))
    assert imp.rc == 0 and (imp.json["rows"], imp.json["matched"], imp.json["unmatched"]) == (4, 3, 1)
    listed = {a["account_id"]: a for a in built("accounts", "list").json}
    assert len(built("accounts", "list", "--limit", "2").json) == 2
    repo = built.repo()
    assert {k: (a["company_id"], a["match_method"]) for k, a in listed.items()} == {
        "A-100": (cid(repo, JERSEY_ID), "phone"), "A-200": (cid(repo, GOLOVIN_ID), "name+locality"),
        "A-300": (cid(repo, HAYDEN_ID), "phone"), "A-400": (None, None)}

    tag = built("tag")
    assert tag.rc == 0
    assert tag.json["account_status"] == {"existing_customer": 1, "do_not_contact": 1, "lapsed_customer": 1,
                                          "prospect": 4}
    rows = {c["gaf_id"]: c for c in built.repo().get_companies()}
    assert rows[GOLOVIN_ID]["priority_score"] == 0.0
    jersey = {t["key"]: t["value"] for t in rows[JERSEY_ID]["tags"]}
    assert (jersey["account_status"], jersey["account_owner"], jersey["account_spend_band"]) == (
        "existing_customer", "Dana Rep", "high")

    out = tmp_path / "after_crm.csv"
    built("export", "--format", "csv", "--out", str(out))
    by = {r["gaf_id"]: r for r in _csv(out)[1]}
    assert "Existing customer" in by[JERSEY_ID]["tag_labels"]
    assert "Do not contact" in by[GOLOVIN_ID]["tag_labels"] and float(by[GOLOVIN_ID]["priority_score"]) == 0.0
    assert "Lapsed customer" in by[HAYDEN_ID]["tag_labels"]

    # A plain re-import replaces the previous list instead of duplicating it.
    assert built("accounts", "import", str(crm)).rc == 0
    assert len(built("accounts", "list").json) == 4


def test_accounts_append_keeps_earlier_accounts(built, tmp_path):
    first, second = tmp_path / "branch_a.csv", tmp_path / "branch_b.csv"
    first.write_text("Account Number,Account Name,Zip\nA-1,Jersey Roofing LLC,07026\n")
    second.write_text("Account Number,Account Name,Zip\nB-1,Gemz Construction Corp,11434\n")
    assert built("accounts", "import", str(first)).json["matched"] == 1
    assert built("accounts", "import", str(second), "--append").json["matched"] == 1
    listed = {a["account_id"]: a["company_id"] for a in built("accounts", "list").json}
    assert listed == {"A-1": cid(built.repo(), JERSEY_ID), "B-1": cid(built.repo(), GEMZ_ID)}


def test_accounts_append_of_crm_exports_without_account_numbers(built, tmp_path):
    first, second = tmp_path / "branch_a.csv", tmp_path / "branch_b.csv"
    first.write_text("Account Name,Zip\nJersey Roofing LLC,07026\n")
    second.write_text("Account Name,Zip\nGemz Construction Corp,11434\n")
    assert built("accounts", "import", str(first)).rc == 0
    r = built("accounts", "import", str(second), "--append")  # raises IntegrityError today
    assert r.rc == 0 and r.json["matched"] == 1
    assert {a["company_id"] for a in built("accounts", "list").json} == {cid(built.repo(), JERSEY_ID),
                                                                         cid(built.repo(), GEMZ_ID)}


# ------------------------------------------------------------------------------ run / validate
def test_run_command_chains_scrape_enrich_and_tag(offline):
    r = offline("run", "--no-profiles", "--sources", "nyc_dcwp")
    assert r.rc == 0
    scrape, enrich, tag = _json_docs(r.out)
    assert scrape["status"] == "succeeded" and "profiles" not in scrape
    assert enrich["by_source"] == {"nyc_dcwp": {"no_match": 7}}  # no profile -> no legal name -> no licence
    assert tag["tagged"] == 7
    assert [x["kind"] for x in offline.repo().list_runs()] == ["tag", "enrich", "gaf_ingest"]
    assert not any("/residential/usa/" in c.url for c in offline.router.calls)


def _require_validate() -> None:
    if "validate" not in _subcommands():
        pytest.skip("`leadmaker validate` is not registered in leadmaker/cli.py yet (written concurrently)")


def test_validate_fails_the_e2e_database_only_for_its_missing_profiles(built, tmp_path):
    _require_validate()
    out = tmp_path / "reports" / "validation.json"
    r = built("validate", "--out", str(out))
    report = json.loads(out.read_text())  # written even when the verdict is a failure
    assert report["area"] == {"postal_code": "10013", "radius_miles": 25.0, "run_id": 1, "leads": 7}
    failed = {c["id"]: c for c in report["checks"] if c["status"] == "fail"}
    # 5 of 7 GAF profile pages 404'd in the e2e area: exactly that, and nothing else, fails.
    assert set(failed) == {"freshness.profiles"}
    assert failed["freshness.profiles"]["value"] == pytest.approx(2 / 7, abs=1e-4)
    assert r.rc == 1 and report["status"] == "fail" and report["counts"]["fail"] == 1
    assert f"wrote {out}" in r.err and "FAIL" in r.out and "freshness.profiles" in r.out
    explicit = built("validate", "--zip", "10013", "--radius", "25")
    assert explicit.rc == 1 and "freshness.profiles" in explicit.out
    other = tmp_path / "other_area.json"
    assert built("validate", "--zip", "10014", "--radius", "25", "--out", str(other)).rc == 1  # never scraped
    assert json.loads(other.read_text())["area"] == {"postal_code": "10014", "radius_miles": 25.0, "run_id": None,
                                                     "leads": 0}


def test_validate_passes_a_fully_profiled_area(offline, tmp_path):
    _require_validate()
    keep = [r for r in coveo_results() if r["raw"]["gaf_contractor_id"] in (GEMZ_ID, ADH_ID)]

    def two_contractors(call):  # an area whose every profile page is served
        body = call.json
        page = keep[body["firstResult"]: body["firstResult"] + body["numberOfResults"]] if "sortCriteria" in body else keep
        return 200, json.dumps({"totalCount": len(keep), "results": page})

    offline.router.add("POST", lambda u: u.split("/")[2] == COVEO_HOST, two_contractors)
    for argv in (("scrape",), ("enrich", "--sources", ENRICH_SOURCES), ("tag",), ("signals",)):
        assert offline(*argv).rc == 0, argv
    out = tmp_path / "ok.json"
    r = offline("validate", "--out", str(out))
    report = json.loads(out.read_text())
    assert r.rc == 0, [c for c in report["checks"] if c["status"] == "fail"]
    assert report["counts"]["fail"] == 0 and report["area"]["leads"] == 2
    statuses = {c["id"]: c["status"] for c in report["checks"]}
    assert statuses["freshness.profiles"] == "pass" and statuses["tagging.target_contact"] == "pass"
    # No lead has a website yet, and ADH's licence lists another phone: warnings, which --strict fails.
    assert {k for k, v in statuses.items() if v == "warn"} == {"coverage.website", "consistency.phone"}
    assert offline("validate", "--strict").rc == 1


def test_validate_refuses_a_missing_database(offline):
    _require_validate()
    r = offline("validate")
    assert r.rc == 2 and "no database at" in r.err
    assert not offline.db_path.exists()
