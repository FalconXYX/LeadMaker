"""NWS alerts -> regional_signals, offline.

Fixtures (real api.weather.gov responses captured 2026-10-18, trimmed to the fields we read):
  nws_alerts_history_sample.json -- /alerts?area=NJ,NY (last 7 days): the 2026-10-16 Severe
    Thunderstorm Warning for Morris/Somerset with its Update and Cancel messages, a Severe
    Thunderstorm Watch + Cancel, a Westchester warning, a Flood Warning, a Coastal Flood Statement.
  nws_alerts_active_sample.json -- /alerts/active?area=NJ: one Frost Advisory (Morris, Somerset, Middlesex).
"""

from __future__ import annotations

import json
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select

from leadmaker.config import Settings
from leadmaker.db import Repository
from leadmaker.db.schema import regional_signals
from leadmaker.http import Response
from leadmaker.signals import store, weather

FIX = Path(__file__).parent / "fixtures"
HISTORY = json.loads((FIX / "nws_alerts_history_sample.json").read_text())
ACTIVE = json.loads((FIX / "nws_alerts_active_sample.json").read_text())
NOW = datetime(2026, 10, 18, 18, 30, tzinfo=timezone.utc)
COUNTIES = ["34023", "34027", "34035", "36119", "36059", "34003"]
WARNING_1 = "urn:oid:2.49.0.1.840.0.1cd32d4d7e6813eded8a789dbdaff1f5ecb41ae0.001.1"
FROST = ACTIVE["features"][0]["properties"]["id"]


class FakeNws:
    def __init__(self, history: dict[str, Any] = HISTORY, active: dict[str, Any] = ACTIVE):
        self.history, self.active = history, active
        self.calls: list[dict[str, Any]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    async def get(self, url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
                  **kw: Any) -> Response:
        self.calls.append({"url": url, "params": dict(params or {}), "headers": dict(headers or {})})
        body = self.active if url == weather.ACTIVE_URL else self.history
        return Response(url=url, status=200, text=json.dumps(body), headers={})


def rows(repo: Repository) -> list[dict[str, Any]]:
    with repo.engine.connect() as conn:
        return [dict(r._mapping) for r in conn.execute(select(regional_signals))]


def test_county_zone_and_time_parsing():
    assert weather.county_zone("34003") == "NJC003"
    assert weather.county_zone("36059") == "NYC059"
    assert weather.parse_time("2026-10-16T18:15:00-04:00") == datetime(2026, 10, 16, 22, 15, tzinfo=timezone.utc)
    assert weather.parse_time(None) is None and weather.parse_time("soon") is None


def test_alert_rows_apply_updates_and_cancels():
    out, superseded, cancelled = weather.alert_rows(HISTORY["features"], set(COUNTIES), NOW)
    ids = {(r["external_id"], r["county_fips"]) for r in out}
    # The original warning was replaced by its updates in both counties.
    assert (WARNING_1, "34027") in superseded and (WARNING_1, "34035") in superseded
    assert not any(e == WARNING_1 for e, _ in ids)
    # SAME codes outside our counties (PA, other NJ counties) are dropped.
    assert {c for _, c in ids} <= set(COUNTIES)
    # The watch for Middlesex/Morris/Somerset was cancelled early: valid_to = cancel time, not 22:00 local.
    watch = [r for r in out if r["payload"]["event"] == "Severe Thunderstorm Watch" and r["county_fips"] == "34035"]
    assert watch and watch[0]["valid_to"] < datetime(2026, 10, 17, 2, 0, tzinfo=timezone.utc)
    assert "cancelled_at" in watch[0]["payload"]
    r = next(r for r in out if r["payload"]["event"] == "Severe Thunderstorm Warning")
    p = r["payload"]
    assert set(p) >= {"event", "severity", "urgency", "headline", "areaDesc", "instruction"}
    assert p["instruction"] is None or len(p["instruction"]) <= weather.INSTRUCTION_MAX
    assert r["kind"] == "active_alert" and r["source"] == "nws" and r["valid_to"].tzinfo is not None


# The real 2026-10-16 17:24 EDT Upton warning: "Severe Thunderstorm Warning for... Northern Westchester
# County in southeastern New York... Orange County... Putnam County" (the history fixture drops geometry).
WESTCHESTER_RING = [[-74.61, 41.5], [-74.48, 41.5], [-74.42, 41.57], [-74.26, 41.63], [-74.25, 41.6],
                    [-74.13, 41.58], [-74.13, 41.61], [-74.05, 41.58], [-73.95, 41.59], [-74, 41.45],
                    [-73.93, 41.49], [-73.7, 41.51], [-73.6, 41.23], [-73.97, 41.25], [-73.94, 41.29],
                    [-73.98, 41.32], [-74.08, 41.25], [-74.52, 41.27], [-74.66, 41.34], [-74.68, 41.46],
                    [-74.61, 41.5]]


def test_alert_rows_keep_the_warning_polygon_and_zone_codes():
    from leadmaker.signals.timing import point_in_geometry

    features = json.loads(json.dumps(HISTORY["features"]))
    svr = next(f for f in features if f["properties"]["event"] == "Severe Thunderstorm Warning"
               and "Westchester" in f["properties"]["areaDesc"])
    svr["geometry"] = {"type": "Polygon", "coordinates": [[[x + 0.000012, y] for x, y in WESTCHESTER_RING]]}
    out, _, _ = weather.alert_rows(features, set(COUNTIES), NOW)
    row = next(r for r in out if r["external_id"] == svr["properties"]["id"])
    geom = row["payload"]["geometry"]
    assert geom["type"] == "MultiPolygon" and geom["coordinates"] == [[WESTCHESTER_RING]]  # rounded to 4 places
    assert row["payload"]["ugc"] == ["NYC071", "NYC079", "NYC119"]
    assert point_in_geometry(40.957543, -73.873863, geom) is False  # Hastings Roofing, Yonkers
    assert point_in_geometry(41.2901, -73.9204, geom) is True  # Peekskill
    # Zone-based products (the watch) carry no polygon: their UGC zones are the area.
    watch = next(r for r in out if r["payload"]["event"] == "Severe Thunderstorm Watch")
    assert watch["payload"]["geometry"] is None and "NJC035" in watch["payload"]["ugc"]
    assert weather.polygons({"type": "Point", "coordinates": [1, 2]}) == []
    assert weather.polygons({"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [0, 0]]]}) == []  # degenerate


async def test_refresh_stores_expires_and_is_idempotent(repo):
    http = FakeNws()
    settings = Settings(user_agent_contact="LeadMaker test (ops@example.com)")
    stats = await weather.refresh_alerts(http, settings, repo, COUNTIES, now=NOW)
    assert stats["active_alerts"] == 1 and stats["active_by_event"] == {"Frost Advisory": 1}
    # NWS etiquette: identifying UA, geo+json, county zones, politeness interval.
    assert all(c["headers"]["User-Agent"] == settings.user_agent_contact for c in http.calls)
    assert http.calls[0]["params"]["zone"] == "NJC003,NJC023,NJC027,NJC035,NYC059,NYC119"
    assert "start" in http.calls[0]["params"] and http.intervals[weather.HOST] >= 1
    assert len(http.calls) == 2  # history page shorter than the limit -> no pagination
    stored = rows(repo)
    frost = [r for r in stored if r["external_id"] == FROST]
    assert {r["county_fips"] for r in frost} == {"34023", "34027", "34035"}
    first = len(stored)
    again = await weather.refresh_alerts(http, settings, repo, COUNTIES, now=NOW)
    assert len(rows(repo)) == first and again["closed_missing"] == 0

    # The frost advisory disappears from /alerts/active before its end time -> closed now, kept as history.
    later = NOW + timedelta(hours=2)
    gone = FakeNws(active={"features": []})
    out = await weather.refresh_alerts(gone, settings, repo, COUNTIES, now=later)
    assert out["closed_missing"] == 3
    sig = store.signals_for_counties(repo, ["34035"], kinds=["active_alert"])["34035"]
    frost_row = next(r for r in sig if r["external_id"] == FROST)
    assert frost_row["valid_to"] == later

    # Retention: a month on, everything has ended long ago and is purged.
    month = NOW + timedelta(days=weather.RETENTION_DAYS + 2)
    empty = FakeNws(history={"features": []}, active={"features": []})
    out = await weather.refresh_alerts(empty, settings, repo, COUNTIES, now=month)
    assert out["purged"] == first and rows(repo) == []


async def test_update_from_a_later_run_replaces_stored_original(repo):
    original = [f for f in HISTORY["features"] if f["properties"]["id"] == WARNING_1]
    settings = Settings()
    await weather.refresh_alerts(FakeNws(history={"features": original}, active={"features": []}), settings, repo,
                                 COUNTIES, now=NOW)
    assert any(r["external_id"] == WARNING_1 for r in rows(repo))
    out = await weather.refresh_alerts(FakeNws(), settings, repo, COUNTIES, now=NOW)
    assert out["superseded_deleted"] == 2
    assert not any(r["external_id"] == WARNING_1 for r in rows(repo))


async def test_test_messages_and_no_counties_are_ignored(repo):
    feat = json.loads(json.dumps(ACTIVE["features"][0]))
    feat["properties"]["status"] = "Test"
    out, _, _ = weather.alert_rows([feat], set(COUNTIES), NOW)
    assert out == []
    stats = await weather.refresh_alerts(FakeNws(), Settings(), repo, [], now=NOW)
    assert stats == {"counties": 0, "features": 0}


# ------------------------------------------------------------- pipeline wiring
class _NoHttp:
    def __init__(self, settings: Any):
        self.stats = {"requests": 0}

    async def __aenter__(self) -> "_NoHttp":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None


def _wire(monkeypatch, repo):
    """run_signals with every network step faked; returns (module, calls made)."""
    from leadmaker.pipeline import signals as pipe
    from leadmaker.signals.counties import CountyIndex

    idx = CountyIndex.from_text((FIX / "zcta_county_sample.txt").read_text(encoding="utf-8"))
    calls: dict[str, Any] = {}

    async def load_index(http, cache=None):
        return idx

    def assign(repo_, index=None, force=False, run_id=None):
        return {"leads": 2, "assigned": 2, "already_set": 0, "unmapped": [], "split": [], "counties": 2}

    async def refine(http, repo_, ids, run_id=None):
        return {"checked": len(ids), "changed": 0}

    def counties(repo_, index=None):
        return [{**idx.county("34003"), "leads": 1}, {**idx.county("34035"), "leads": 1}]

    async def alerts(http, settings, repo_, fips, now=None):
        calls["alerts"] = fips
        return {"active_alerts": 0}

    async def storm(http, settings, repo_, index, fips, now=None, force=False):
        raise RuntimeError("NCEI down")

    monkeypatch.setattr(pipe, "HttpClient", _NoHttp)
    monkeypatch.setattr(pipe.county_mod, "load_county_index", load_index)
    monkeypatch.setattr(pipe.county_mod, "assign_county_fips", assign)
    monkeypatch.setattr(pipe.county_mod, "refine_by_point", refine)
    monkeypatch.setattr(pipe.county_mod, "lead_counties", counties)
    monkeypatch.setattr(pipe.weather, "refresh_alerts", alerts)
    monkeypatch.setattr(pipe.storms, "refresh_storm_history", storm)
    return pipe, calls


async def test_run_signals_isolates_failures_and_calls_news_hook(repo, monkeypatch):
    pipe, calls = _wire(monkeypatch, repo)
    news = types.ModuleType("leadmaker.signals.news")

    async def fetch_county_news(http, settings, counties):
        calls["news"] = counties
        return [{"county_fips": "34003", "source": "patch", "external_id": "https://example.org/a",
                 "payload": {"title": "Storm cleanup"}, "valid_from": NOW}]

    news.fetch_county_news = fetch_county_news  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "leadmaker.signals.news", news)
    stats = await pipe.run_signals(Settings(), repo, now=NOW)
    assert stats["status"] == "partial" and "NCEI down" in stats["errors"]["storm_history"]
    assert calls["alerts"] == ["34003", "34035"]
    assert calls["news"][0] == {"county_fips": "34003", "county_name": "Bergen County", "state": "NJ"}
    assert stats["news"]["rows_written"] == 1
    assert store.signals_for_counties(repo, ["34003"], kinds=["news"])["34003"][0]["kind"] == "news"
    run = repo.list_runs(1)[0]
    assert run["kind"] == "signals" and run["status"] == "partial" and "storm_history" in run["error"]


async def test_run_signals_skips_missing_news_module(repo, monkeypatch):
    pipe, _ = _wire(monkeypatch, repo)
    monkeypatch.setitem(sys.modules, "leadmaker.signals.news", None)  # import -> ImportError
    stats = await pipe.run_signals(Settings(), repo, now=NOW)
    assert stats["news"]["skipped"].startswith("news module not available")


async def test_run_signals_marks_partial_when_storm_reports_fail(repo, monkeypatch):
    pipe, _ = _wire(monkeypatch, repo)

    async def storm(http, settings, repo_, index, fips, now=None, force=False):
        return {"counties": 2, "rows_written": 2, "lsr_error": "HttpError: HTTP 503"}

    monkeypatch.setattr(pipe.storms, "refresh_storm_history", storm)
    stats = await pipe.run_signals(Settings(), repo, news=False, now=NOW)
    assert stats["status"] == "partial" and "HTTP 503" in stats["errors"]["storm_history"]
    assert stats["storm_history"]["rows_written"] == 2  # the NCEI part still landed
