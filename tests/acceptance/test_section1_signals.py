"""Section 1 acceptance -- Contextual Signal Sources (weather / storms -> timing).

Requirement (docs/OpeningRequirements.MD, Section 1):
  "Contextual Signal Sources: Weather/Storm APIs and local news feeds to track regional roofing demand drivers."
Design (SystemDesign / leadmaker/pipeline/signals.py): signals are fetched per county, never per lead,
and timing badges are rules over the stored rows -- no LLM call anywhere on this path.

Fixtures: real Census ZCTA->county rows, a real Census point lookup (Somerset County), real NWS alert
history (the 2026-10-16 Severe Thunderstorm Warning for Morris/Somerset) and active alerts (a Frost
Advisory), real NCEI StormEvents rows, the NWS zone-county file and IEM storm reports.
"""

from __future__ import annotations

import functools
import gzip
import json
from datetime import datetime, timezone

import pytest

import leadmaker.llm as llm_pkg
from leadmaker.jobs import JobQueue, work
from leadmaker.llm.base import LlmProvider
from leadmaker.models import Contractor, EnrichmentResult, EnrichmentStatus
from leadmaker.pipeline import signals as pipe
from leadmaker.signals import counties as county_mod
from leadmaker.signals import store, storms, weather

from dbutil import cid
from fakes import FIX, LLM_HOSTS, RoutedHttp, offline_settings, seed_area


NOW = datetime(2026, 10, 18, 18, 30, tzinfo=timezone.utc)
NCEI_2026 = "StormEvents_details-ftp_v1.0_d2026_c20260918.csv.gz"
STORM_ROOFER, PLAIN_ROOFER, BERGEN_ROOFER = "800001", "800002", "800003"


# An IEM storm report (same shape as storm_lsr_sample.json) in Somerset inside the 2026-10-16 warning's window
# (22:06-22:15 UTC): ground truth that the radar-indicated warning really did damage there.
SOMERSET_DAMAGE_REPORT = {"type": "Feature", "properties": {
    "wfo": "PHI", "typetext": "TSTM WND DMG", "county": "Somerset", "state": "NJ", "st": "NJ",
    "city": "Green Brook Twp", "magnitude": "", "unit": None, "valid": "2026-10-16T22:10:00Z",
    "remark": "Large tree down on a house.", "product_id": "202610162230-KPHI-NWUS51-LSRPHI"}}


def _signals_http(extra_storm_reports: list[dict] | None = None) -> RoutedHttp:
    def text(name):
        return lambda m, u, kw: (FIX / name).read_text(encoding="utf-8")

    def lsr(m, u, kw):
        body = json.loads((FIX / "storm_lsr_sample.json").read_text(encoding="utf-8"))
        body["features"] += extra_storm_reports or []
        return body

    return RoutedHttp([
        (county_mod.REL_URL, text("zcta_county_sample.txt")),
        (county_mod.GEOCODER_URL, text("zcta_geocoder_point_somerset.json")),
        (weather.ACTIVE_URL, text("nws_alerts_active_sample.json")),  # before the /alerts prefix
        (weather.HISTORY_URL, text("nws_alerts_history_sample.json")),
        (storms.NCEI_BASE, lambda m, u, kw: f'<a href="{NCEI_2026}">{NCEI_2026}</a>'),
        (storms.ZONE_PAGE, lambda m, u, kw: '<a href="/source/gis/Shapefiles/County/bp16ap26.dbx">current</a>'),
        (storms.ZONE_BASE, text("storm_zones_sample.dbx")),
        (storms.LSR_URL, lsr),
    ])


@pytest.fixture
def county_leads(repo, tmp_path):
    """Three leads: two in split ZIP 07060 (point lookup puts them in Somerset), one in Bergen (07010).
    The first lists storm-damage / repair work on its website."""
    cache = tmp_path / "cache"
    cache.mkdir(exist_ok=True)
    (cache / NCEI_2026).write_bytes(gzip.compress((FIX / "storm_ncei_details_sample.csv").read_bytes()))

    def lead(gid, name, z, city, lat, lng):
        return Contractor(gaf_id=gid, name=name, city=city, state="NJ", postal_code=z, latitude=lat, longitude=lng,
                          phone="(908) 555-0100", profile_url=f"https://www.gaf.com/x/{gid}")

    seed_area(repo, [
        lead(STORM_ROOFER, "Storm Pros Roofing", "07060", "Plainfield", 40.6301, -74.4174),
        lead(PLAIN_ROOFER, "Plain Roofing Co", "07060", "Plainfield", 40.6302, -74.4170),
        lead(BERGEN_ROOFER, "Bergen Roofing", "07010", "Cliffside Park", 40.8198, -73.9885),
    ])
    repo.save_enrichment(cid(repo, STORM_ROOFER), EnrichmentResult(
        source="website_crawl", status=EnrichmentStatus.OK, confidence=0.9,
        data={"services": ["storm_damage", "roof_repair", "insurance_claims"]}))
    return repo


@pytest.fixture
def no_llm(monkeypatch):
    """Any attempt to build an LLM provider fails the run loudly -- through the factory functions or by
    instantiating a provider class directly (every provider runs LlmProvider.__init__)."""

    def refuse(*a, **kw):
        raise AssertionError("the signals path must never call an LLM")

    monkeypatch.setattr(llm_pkg, "provider_class", refuse)
    monkeypatch.setattr(llm_pkg, "get_provider", refuse)
    monkeypatch.setattr(LlmProvider, "__init__", refuse)


def _badges(repo, now):
    leads = repo.lead_records("10013", 25)
    gaf = {l["company_id"]: l["gaf_id"] for l in leads}
    return {gaf[c]: {b["key"]: b for b in bs} for c, bs in pipe.lead_timing_badges(repo, leads, now=now).items()}


async def test_county_alerts_become_timing_badges_without_any_llm_call(county_leads, monkeypatch, no_llm):
    """Weather/Storm APIs -> regional demand drivers: alerts are fetched once per county, stored, and turned
    into rule-based timing badges -- a storm-response call for the storm roofer, context for the others."""
    repo = county_leads
    http = _signals_http()
    monkeypatch.setattr(pipe, "HttpClient", http)
    settings = offline_settings(gemini_api_key="present-but-unused")  # an LLM is available; it must not be used

    stats = await pipe.run_signals(settings, repo, news=False, now=NOW)

    assert stats["status"] == "succeeded" and stats["errors"] == {}
    assert not (http.hosts() & set(LLM_HOSTS))
    fips = {r["gaf_id"]: r["county_fips"] for r in repo.get_companies()}
    assert fips == {STORM_ROOFER: "34035", PLAIN_ROOFER: "34035", BERGEN_ROOFER: "34003"}
    assert stats["counties"]["point_check"]["changed"] == 2  # split ZIP resolved by the point lookup
    # Per county, not per lead: one history request + one active request for both counties together.
    nws = [c for c in http.calls if c["url"].startswith("https://api.weather.gov/")]
    assert len(nws) == 2 and nws[0]["params"]["zone"] == "NJC003,NJC035"
    assert nws[0]["headers"]["User-Agent"] == "LeadMaker tests"
    run = repo.list_runs(1)[0]
    assert run["kind"] == "signals" and run["status"] == "succeeded"

    by_lead = _badges(repo, NOW)
    storm = by_lead[STORM_ROOFER]["storm_response"]
    # The 2026-10-16 warning was radar-indicated and no storm report in Somerset confirms damage: medium.
    assert storm["severity"] == "medium" and storm["source"] == "nws"
    assert "Severe Thunderstorm Warning" in storm["label"] and "storm damage" in storm["reason"]
    assert "no NWS storm reports in this county confirm damage yet" in storm["reason"]
    plain = by_lead[PLAIN_ROOFER]
    assert "storm_response" not in plain and plain["weather_alert"]["severity"] == "low"
    bergen = by_lead[BERGEN_ROOFER]
    assert set(bergen) == {"season"} and bergen["season"]["source"] == "calendar"  # no Bergen alert
    for badges in by_lead.values():
        for b in badges.values():
            assert set(b) == {"key", "label", "reason", "source", "severity"} and b["reason"]

    # The same badges come back on the lead view itself (lead_records attaches them).
    assert {b["key"] for b in repo.lead_records("10013", 25)[0]["timing"]} >= {"season"}

    # Once a storm report in Somerset inside the warning's window comes in, the call becomes urgent.
    monkeypatch.setattr(pipe, "HttpClient", _signals_http([SOMERSET_DAMAGE_REPORT]))
    again = await pipe.run_signals(settings, repo, news=False, force_storms=True, now=NOW)
    assert again["status"] == "succeeded" and again["errors"] == {}
    confirmed = _badges(repo, NOW)
    storm = confirmed[STORM_ROOFER]["storm_response"]
    assert storm["severity"] == "high" and "1 NWS storm report in this county confirm" in storm["reason"]
    assert "Green Brook Twp" in storm["reason"]
    assert confirmed[PLAIN_ROOFER]["weather_alert"]["severity"] == "low"  # still context for a regular roofer
    assert set(confirmed[BERGEN_ROOFER]) == {"season"}  # Bergen is untouched by a Somerset report


async def test_storm_history_is_stored_per_county_and_drives_recent_storm_badges(county_leads, monkeypatch, no_llm):
    """24 months of NOAA storm history land as one summary row per county; a significant roof-relevant storm
    in the last 30 days gives that county's leads a recent-storm badge (stronger for storm roofers)."""
    repo = county_leads
    monkeypatch.setattr(pipe, "HttpClient", _signals_http())
    stats = await pipe.run_signals(offline_settings(), repo, news=False, now=NOW)
    hist = stats["storm_history"]
    assert hist["rows_written"] == 2 and hist["ncei_files"] == {"2026": NCEI_2026}
    rows = store.signals_for_counties(repo, ["34003", "34035"], kinds=[storms.KIND])
    assert set(rows) == {"34003", "34035"}
    for (row,) in rows.values():
        assert row["source"] == storms.SOURCE and row["payload"]["recent_events"]

    def at(month, day):
        return datetime(2026, month, day, 12, 0, tzinfo=timezone.utc)

    # Somerset's only roof-relevant report in the 30 days before Aug 28 is one lone wind-damage report
    # (2026-08-07, Green Brook): not enough on its own for a recent-storm call, storm roofer or not. On Aug 10
    # the window also holds a 07-18 flash flood, which does not count: floods don't damage roofs.
    for day in (at(8, 10), at(8, 28)):
        somerset = _badges(repo, day)
        assert "recent_storm" not in somerset[STORM_ROOFER] and "recent_storm" not in somerset[PLAIN_ROOFER]
    # Bergen's 2026-07-27 storm (wind damage in Teaneck plus 1.0 in hail in Franklin Lakes) is: two weeks
    # later its lead gets a recent-storm badge naming that storm -- low as context ...
    bergen = _badges(repo, at(8, 10))[BERGEN_ROOFER]["recent_storm"]
    assert bergen["severity"] == "low" and "2026-07-27" in bergen["reason"]
    # ... and medium once the same lead is known to do storm work.
    repo.save_enrichment(cid(repo, BERGEN_ROOFER), EnrichmentResult(
        source="website_crawl", status=EnrichmentStatus.OK, confidence=0.9, data={"services": ["storm_damage"]}))
    assert _badges(repo, at(8, 10))[BERGEN_ROOFER]["recent_storm"]["severity"] == "medium"
    # The window is 30 days: the badge still shows on day 30 after that storm and is gone on day 31.
    assert "recent_storm" in _badges(repo, at(8, 26))[BERGEN_ROOFER]
    assert "recent_storm" not in _badges(repo, at(8, 27))[BERGEN_ROOFER]
    # Back at NOW, neither county has had a significant roof-relevant storm in the last 30 days.
    assert not any("recent_storm" in b for b in _badges(repo, NOW).values())


async def test_signals_job_runs_through_the_queue(county_leads, monkeypatch, no_llm):
    """Signals refresh is a queued job kind like the rest of the pipeline (schedulable, retried on failure)."""
    repo = county_leads
    http = _signals_http()
    monkeypatch.setattr(pipe, "HttpClient", http)
    monkeypatch.setattr(pipe, "run_signals", functools.partial(pipe.run_signals, now=NOW))  # injected clock
    q = JobQueue(repo)
    jid = q.enqueue("signals", {"news": False})
    assert await work(offline_settings(), repo, once=True) == 1
    job = q.list("succeeded")[0]
    assert job["id"] == jid and job["result"]["signals"]["status"] == "succeeded"
    assert job["result"]["signals"]["run_id"] == repo.list_runs(1)[0]["id"]
    assert store.signals_for_counties(repo, ["34035"], kinds=[weather.KIND])["34035"]
    assert not (http.hosts() & set(LLM_HOSTS))
