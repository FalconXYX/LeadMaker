"""Storm history per county, offline.

Fixtures (real rows, trimmed):
  storm_ncei_details_sample.csv -- NCEI StormEvents_details 2026 (c20260918) rows: Bergen and
    Somerset thunderstorm wind, Bergen forecast-zone winter events (NJZ103/NJZ104, incl. ignored
    "Winter Weather"), two PA hail rows (out of area).
  storm_zones_sample.dbx -- NWS zone-county correlation (bp16ap26.dbx) lines for 6 NJ/NY counties.
  storm_lsr_sample.json -- IEM LSR GeoJSON features (Jul-Oct 2026) for Bergen/Somerset NJ and Berks PA.
  zcta_county_sample.txt -- county names for LSR county-name mapping.
"""

from __future__ import annotations

import gzip
import io
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any


from leadmaker.config import Settings
from leadmaker.http import Response
from leadmaker.signals import storms, store
from leadmaker.signals.counties import CountyIndex

FIX = Path(__file__).parent / "fixtures"
NCEI_CSV = (FIX / "storm_ncei_details_sample.csv").read_text()
ZONES = (FIX / "storm_zones_sample.dbx").read_text()
LSR = json.loads((FIX / "storm_lsr_sample.json").read_text())
INDEX = CountyIndex.from_text((FIX / "zcta_county_sample.txt").read_text(encoding="utf-8"))
COUNTIES = {"34003", "34035"}
NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)
START = NOW.date() - timedelta(days=storms.WINDOW_DAYS)
NCEI_2026 = "StormEvents_details-ftp_v1.0_d2026_c20260918.csv.gz"


def ncei_events():
    return storms.parse_ncei(io.StringIO(NCEI_CSV), COUNTIES, storms.ZoneMap(ZONES), START, NOW.date())


def test_zone_map_and_offices():
    zm = storms.ZoneMap(ZONES)
    assert zm.counties[("34", "103")] == {"34003"} and zm.counties[("34", "104")] == {"34003"}
    assert zm.offices(["34003", "34035"]) == ["OKX", "PHI"]


def test_parse_ncei_filters_and_maps_zones():
    events, coverage = ncei_events()
    assert coverage == date(2026, 6, 12)  # newest BEGIN date in the file
    kinds = {(e["county_fips"], e["event_type"]) for e in events}
    assert ("34003", "Thunderstorm Wind") in kinds and ("34035", "Thunderstorm Wind") in kinds
    assert ("34003", "Winter Storm") in kinds and ("34003", "Blizzard") in kinds  # zone events -> Bergen
    assert not any(e["event_type"] == "Winter Weather" for e in events)  # not roof-relevant
    assert all(e["county_fips"] in COUNTIES for e in events)  # PA hail dropped
    wind = next(e for e in events if e["event_id"] == "1354446")
    assert wind["damage_usd"] == 10000 and wind["unit"] == "kt" and wind["location"]


def test_wind_threshold():
    header, row = NCEI_CSV.splitlines()[0], next(l for l in NCEI_CSV.splitlines() if "1354445" in l)
    weak = header + "\n" + row.replace(",50.00,", ",40.00,")
    events, _ = storms.parse_ncei(io.StringIO(weak), COUNTIES, None, START, NOW.date())
    assert events == []
    events, _ = storms.parse_ncei(io.StringIO(header + "\n" + row), COUNTIES, None, START, NOW.date())
    assert len(events) == 1


def test_parse_lsr_units_and_county_names():
    events = storms.parse_lsr(LSR["features"], COUNTIES, INDEX, date(2026, 7, 1))
    assert {e["county_fips"] for e in events} == COUNTIES  # Berks PA is not ours
    gusts = [f["properties"] for f in LSR["features"] if f["properties"]["typetext"] == "TSTM WND GST"
             and f["properties"]["county"] == "Somerset"]
    kept_gusts = [e for e in events if e["event_type"] == "TSTM WND GST"]
    assert len(kept_gusts) == sum(1 for g in gusts if float(g["magnitude"]) >= storms.WIND_MIN_MPH)
    assert {e["kind"] for e in events} >= {"wind", "flood"}
    assert all(e["source"] == "lsr" for e in events)


def test_dedupe_and_summary():
    ncei, _ = ncei_events()
    lsr = storms.parse_lsr(LSR["features"], COUNTIES, INDEX, date(2026, 7, 1))
    events = storms.dedupe(ncei + lsr)
    # Winter Storm on NJZ103 and NJZ104 the same day -> one Bergen event.
    ws = [e for e in events if e["county_fips"] == "34003" and e["event_type"] == "Winter Storm"]
    assert len(ws) == 1
    # Several LSRs of one kind, one county, one day collapse to one.
    keys = [(e["county_fips"], e["date"], e["kind"]) for e in events if e["source"] == "lsr"]
    assert len(keys) == len(set(keys))
    s = storms.summarise(events, "34003", NOW.date(), {"as_of": "2026-10-18"})
    assert s["events_24m"] == sum(1 for e in events if e["county_fips"] == "34003")
    assert s["counts_24m"]["winter"] >= 2 and s["wind_ge_50kt_24m"] >= 2
    assert s["last_event_at"] == max(e["date"] for e in events if e["county_fips"] == "34003")
    assert s["recent_events"][0]["date"] == s["last_event_at"]
    assert len(s["recent_events"]) <= storms.RECENT_EVENTS
    assert s["property_damage_24m_usd"] >= 12000
    assert s["coverage"] == {"as_of": "2026-10-18"}


def test_latest_files_and_zone_file_dates():
    html = ('<a href="StormEvents_details-ftp_v1.0_d2025_c20260701.csv.gz">x</a>'
            '<a href="StormEvents_details-ftp_v1.0_d2025_c20260819.csv.gz">x</a>'
            '<a href="StormEvents_fatalities-ftp_v1.0_d2025_c20260819.csv.gz">x</a>')
    assert storms.latest_ncei_files(html, range(2024, 2026)) == {2025: "StormEvents_details-ftp_v1.0_d2025_c20260819.csv.gz"}
    assert max(["bp18mr25.dbx", "bp16ap26.dbx", "bp05se24.dbx"], key=storms._zone_file_date) == "bp16ap26.dbx"
    assert storms.money("25.00K") == 25000 and storms.money("1.5M") == 1.5e6 and storms.money("") == 0


class FakeHttp:
    def __init__(self):
        self.calls: list[dict[str, Any]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    async def get(self, url: str, params: dict[str, Any] | None = None, **kw: Any) -> Response:
        self.calls.append({"url": url, "params": params})
        if url == storms.NCEI_BASE:
            text = f'<a href="{NCEI_2026}">{NCEI_2026}</a>'
        elif url == storms.ZONE_PAGE:
            text = '<a href="/source/gis/Shapefiles/County/bp16ap26.dbx">current</a>'
        elif url == storms.ZONE_BASE + "bp16ap26.dbx":
            text = ZONES
        elif url == storms.LSR_URL:
            text = json.dumps(LSR)
        else:
            raise AssertionError(f"unexpected url {url}")
        return Response(url=url, status=200, text=text, headers={})


async def test_refresh_uses_cache_and_respects_monthly_ttl(repo, tmp_path):
    # NCEI 2026 is already cached; 2024/2025 are not and cannot be downloaded as text -> reported missing.
    (tmp_path / NCEI_2026).write_bytes(gzip.compress(NCEI_CSV.encode("latin-1")))
    http = FakeHttp()
    stats = await storms.refresh_storm_history(http, Settings(), repo, INDEX, sorted(COUNTIES), now=NOW,
                                               cache=tmp_path)
    assert stats["rows_written"] == 2
    assert stats["ncei_files"] == {"2026": NCEI_2026}
    assert stats["ncei_missing_years"] == [2024, 2025]
    assert stats["lsr_from"] == START.isoformat()  # NCEI incomplete -> LSRs cover the whole window
    assert http.intervals[storms.LSR_HOST] == storms.LSR_CRAWL_DELAY_S
    lsr_calls = [c for c in http.calls if c["url"] == storms.LSR_URL]
    assert len(lsr_calls) == 1 and lsr_calls[0]["params"]["wfos"] == "OKX,PHI"
    assert (tmp_path / "bp16ap26.dbx").exists()
    sig = store.signals_for_counties(repo, sorted(COUNTIES), kinds=["storm_history"])
    bergen = sig["34003"][0]
    assert bergen["source"] == storms.SOURCE and bergen["external_id"] == storms.EXTERNAL_ID
    assert bergen["payload"]["last_event_at"] and bergen["payload"]["coverage"]["lsr_offices"] == ["OKX", "PHI"]

    # Inside the monthly window: no requests, no rewrite.
    http2 = FakeHttp()
    again = await storms.refresh_storm_history(http2, Settings(), repo, INDEX, sorted(COUNTIES),
                                               now=NOW + timedelta(days=5), cache=tmp_path)
    assert again["skipped"].startswith("fresh") and http2.calls == []
    # A new county makes it stale; so does age.
    assert storms.is_stale(repo, ["34003", "36119"], NOW)
    assert storms.is_stale(repo, sorted(COUNTIES), NOW + timedelta(days=storms.REFRESH_DAYS + 1))


async def test_lsr_failure_is_recorded_not_raised(repo, tmp_path):
    (tmp_path / NCEI_2026).write_bytes(gzip.compress(NCEI_CSV.encode("latin-1")))

    class Down(FakeHttp):
        async def get(self, url: str, params: dict[str, Any] | None = None, **kw: Any) -> Response:
            if url == storms.LSR_URL:
                raise RuntimeError("IEM down")
            return await super().get(url, params, **kw)

    rows, stats = await storms.build_storm_history(Down(), INDEX, sorted(COUNTIES), now=NOW, cache=tmp_path)
    assert len(rows) == 2 and "IEM down" in stats["lsr_error"] and stats["lsr_events"] == 0


def test_lsr_dates_are_local_and_window_avoids_double_counting():
    # 00:09Z on Jul 5 is the evening of Jul 4 in NY/NJ (NCEI dates events in local time too).
    assert storms._lsr_date("2026-07-05T00:09:00Z") == "2026-07-04"
    assert storms._lsr_date("2026-07-05T16:00:00Z") == "2026-07-05"
    assert storms._lsr_date(None) is None
    start = date(2024, 10, 18)
    files = {2024: Path("a"), 2025: Path("b"), 2026: Path("c")}
    # Normal: LSRs only after the newest NCEI event.
    frm, covered = storms._lsr_window(start, files, [], date(2026, 6, 30))
    assert frm == date(2026, 7, 1) and covered("2026-06-30") and not covered("2026-07-01")
    # January: the current year has no NCEI file yet -> still just the post-NCEI gap, not 24 months.
    frm, covered = storms._lsr_window(date(2025, 1, 15), {2025: Path("b"), 2026: Path("c")}, [2027],
                                      date(2026, 9, 30))
    assert frm == date(2026, 10, 1)
    # Older years missing: LSRs fill them, but not dates a present NCEI file covers.
    frm, covered = storms._lsr_window(start, {2026: Path("c")}, [2024, 2025], date(2026, 6, 12))
    assert frm == start and not covered("2025-05-01") and covered("2026-03-01") and not covered("2026-07-01")


async def test_lsr_reports_inside_ncei_coverage_are_dropped(repo, tmp_path):
    (tmp_path / NCEI_2026).write_bytes(gzip.compress(NCEI_CSV.encode("latin-1")))
    shadow = json.loads(json.dumps(LSR))
    dup = json.loads(json.dumps(next(f for f in shadow["features"] if f["properties"]["typetext"] == "TSTM WND DMG")))
    dup["properties"]["valid"] = "2026-05-20T18:00:00Z"  # inside NCEI 2026 coverage (through 2026-06-12)
    shadow["features"].append(dup)

    class Shadow(FakeHttp):
        async def get(self, url: str, params: dict[str, Any] | None = None, **kw: Any) -> Response:
            if url == storms.LSR_URL:
                self.calls.append({"url": url, "params": params})
                return Response(url=url, status=200, text=json.dumps(shadow), headers={})
            return await super().get(url, params, **kw)

    _, base = await storms.build_storm_history(FakeHttp(), INDEX, sorted(COUNTIES), now=NOW, cache=tmp_path)
    _, stats = await storms.build_storm_history(Shadow(), INDEX, sorted(COUNTIES), now=NOW, cache=tmp_path)
    assert stats["lsr_from"] == START.isoformat()  # 2024/2025 missing -> LSRs fill them
    assert stats["lsr_events"] == base["lsr_events"] > 0  # ...but not the NCEI-covered May 2026 report
    assert stats["events"] == base["events"] and stats["lsr_truncated"] is False


async def test_lsr_failure_makes_history_stale_for_next_run(repo, tmp_path):
    (tmp_path / NCEI_2026).write_bytes(gzip.compress(NCEI_CSV.encode("latin-1")))

    class Down(FakeHttp):
        async def get(self, url: str, params: dict[str, Any] | None = None, **kw: Any) -> Response:
            if url == storms.LSR_URL:
                raise RuntimeError("IEM down")
            return await super().get(url, params, **kw)

    stats = await storms.refresh_storm_history(Down(), Settings(), repo, INDEX, sorted(COUNTIES), now=NOW,
                                               cache=tmp_path)
    assert stats["rows_written"] == 2 and "IEM down" in stats["lsr_error"]
    # NCEI rows landed, but the next run retries instead of waiting REFRESH_DAYS.
    assert storms.is_stale(repo, sorted(COUNTIES), NOW + timedelta(hours=6))
    ok = await storms.refresh_storm_history(FakeHttp(), Settings(), repo, INDEX, sorted(COUNTIES),
                                            now=NOW + timedelta(hours=6), cache=tmp_path)
    assert ok["lsr_error"] is None and not storms.is_stale(repo, sorted(COUNTIES), NOW + timedelta(hours=7))


def _lsr(valid, typ, city, remark, county="Bergen", mag="", unit=""):
    return {"type": "Feature", "geometry": None, "properties": {
        "valid": valid, "typetext": typ, "county": county, "st": "NJ", "state": "NJ", "city": city,
        "magnitude": mag, "unit": unit, "remark": remark, "product_id": f"{valid}-{typ}"}}


# Real IEM reports for Bergen on 2026-09-26: IEM keeps each original next to its "Corrects previous" twin.
BERGEN_0926 = [
    _lsr("2026-09-26T09:43:00Z", "TSTM WND DMG", "1 ENE Park Ridge", "Tree down on power lines at East Grand Avenue."),
    _lsr("2026-09-26T09:43:00Z", "NON-TSTM WND DMG", "1 ENE Park Ridge",
         "Corrects previous tstm wnd dmg for non tstm report from 1 ENE Park Ridge. Tree down on power lines at "
         "East Grand Avenue."),
    _lsr("2026-09-26T10:20:00Z", "TSTM WND DMG", "Montvale", "Tree down with powerlines at Spring Valley Road and "
         "West Grand."),
    _lsr("2026-09-26T10:20:00Z", "NON-TSTM WND DMG", "Montvale", "Corrects previous tstm wnd dmg report for non "
         "tstm dmg from Montvale. Tree down with powerlines at Spring Valley Road and West Grand."),
    _lsr("2026-09-26T12:37:00Z", "NON-TSTM WND DMG", "3 W Ramsey", "Tree down on power lines on Ramapo Valley Road "
         "between Darlington Ave and Seminary Drive."),
    _lsr("2026-09-26T14:30:00Z", "COASTAL FLOOD", "1 SSE Rutherford", "Flooding along Rutherford Avenue near "
         "Poltio Avenue."),
]


def test_lsr_collapse_keeps_report_count_latest_report_and_drops_corrected_twins():
    events = storms.parse_lsr(BERGEN_0926, COUNTIES, INDEX, date(2026, 7, 1))
    wind = [e for e in events if e["kind"] == "wind"]
    assert [e["location"] for e in wind] == ["1 ENE Park Ridge", "Montvale", "3 W Ramsey"]  # corrections only
    assert all(e["event_type"] == "NON-TSTM WND DMG" for e in wind)
    (bergen,) = [e for e in storms.dedupe(events) if e["kind"] == "wind"]
    assert bergen["report_count"] == 3  # was shown as 1 report before
    assert bergen["valid"] == "2026-09-26T12:37:00Z" and bergen["location"] == "3 W Ramsey"  # the latest report
    assert bergen["first_valid"] == "2026-09-26T09:43:00Z"
    assert bergen["structure"] is False and bergen["gust_mph"] is None
    s = storms.summarise(storms.dedupe(events), "34003", NOW.date(), {})
    top = next(e for e in s["recent_events"] if e["kind"] == "wind")
    assert {k: top[k] for k in ("report_count", "valid", "first_valid", "location")} == {
        "report_count": 3, "valid": "2026-09-26T12:37:00Z", "first_valid": "2026-09-26T09:43:00Z",
        "location": "3 W Ramsey"}
    # A correction that moves the time (Mamaroneck-style) still replaces its original the same day.
    moved = [_lsr("2026-09-26T16:30:00Z", "TSTM WND DMG", "Teaneck", "Trees down."),
             _lsr("2026-09-26T15:30:00Z", "TSTM WND DMG", "Teaneck", "Corrects previous tstm wnd dmg report from "
                  "Teaneck. Trees down.")]
    assert [e["valid"] for e in storms.parse_lsr(moved, COUNTIES, INDEX, date(2026, 7, 1))] == ["2026-09-26T15:30:00Z"]


def test_correction_replaces_only_its_own_original_at_that_place():
    # Real IEM reports, Rye Brook (Westchester) 2026-07-21: one correction, but three distinct originals that day.
    rye = [
        _lsr("2026-07-21T20:11:00Z", "TSTM WND DMG", "Rye Brook", "Multiple trees down on Lincoln Avenue near Loden "
             "Lane.", county="Westchester"),
        _lsr("2026-07-21T20:16:00Z", "TORNADO", "Rye Brook", "Corrects previous tstm wnd dmg report to tornado from "
             "Rye Brook. Trees & wires down around Dorchester Dr.", county="Westchester"),
        _lsr("2026-07-21T20:17:00Z", "TORNADO", "Rye Brook", "Trees & wires down around Lawridge Dr in Purchase.",
             county="Westchester"),
        _lsr("2026-07-21T20:15:00Z", "TSTM WND DMG", "Rye Brook", "Trees & wires down around Dorchester Dr and "
             "Lawridge Dr in Purchase.", county="Westchester"),
    ]
    kept = [f["properties"]["valid"] for f in storms.drop_corrected(rye)]
    assert kept == ["2026-07-21T20:11:00Z", "2026-07-21T20:16:00Z", "2026-07-21T20:17:00Z"]  # only 20:15 replaced
    # A rewritten remark cannot be matched: every same-place report that day goes, so nothing double counts.
    rewritten = [_lsr("2026-09-26T09:43:00Z", "TSTM WND DMG", "1 ENE Park Ridge", "Tree on wires."),
                 _lsr("2026-09-26T09:43:00Z", "NON-TSTM WND DMG", "1 ENE Park Ridge",
                      "Corrects previous tstm wnd dmg for non tstm report from 1 ENE Park Ridge.")]
    assert [f["properties"]["typetext"] for f in storms.drop_corrected(rewritten)] == ["NON-TSTM WND DMG"]


def test_lsr_gust_and_structure_flags():
    feats = [
        _lsr("2026-09-27T11:41:00Z", "NON-TSTM WND GST", "Sea Bright", "", mag="66", unit="MPH"),
        _lsr("2026-09-27T14:15:00Z", "NON-TSTM WND GST", "Upper Freehold Twp",
             "NJNet mesonet station at Cream Ridge gusted to 49 MPH.", mag="49", unit="MPH"),
        _lsr("2026-07-28T16:38:00Z", "TSTM WND DMG", "3 ESE Laureldale",
             "Delayed report. A tree fell through a home on Wanner Road in Alsace Township."),
    ]
    events = storms.parse_lsr(feats, COUNTIES, INDEX, date(2026, 7, 1))
    assert [e["gust_mph"] for e in events] == [66, None]  # the 49 mph gust is below severe and dropped
    assert [e["structure"] for e in events] == [False, True]
    merged = storms.dedupe([dict(e, date="2026-09-27") for e in events])
    assert len(merged) == 1 and merged[0]["gust_mph"] == 66 and merged[0]["structure"] is True
    assert merged[0]["report_count"] == 2


def test_recent_warning_makes_storm_history_stale_until_its_reports_are_in(repo):
    built = datetime(2026, 10, 16, 22, 30, tzinfo=timezone.utc)
    store.upsert_signals(repo, [{"county_fips": c, "kind": storms.KIND, "source": storms.SOURCE,
                                 "external_id": storms.EXTERNAL_ID, "payload": {"coverage": {}},
                                 "valid_from": built - timedelta(days=730), "valid_to": built, "fetched_at": built}
                                for c in sorted(COUNTIES)])
    assert not storms.is_stale(repo, sorted(COUNTIES), built + timedelta(hours=1))

    def warn(event, end, ext):
        return {"county_fips": "34035", "kind": "active_alert", "source": "nws", "external_id": ext,
                "payload": {"event": event}, "valid_from": end - timedelta(minutes=40), "valid_to": end,
                "fetched_at": built}

    # Real case: Somerset's Severe Thunderstorm Warning ended 22:15Z; reports can trail it by hours.
    store.upsert_signals(repo, [warn("Freeze Warning", built - timedelta(minutes=5), "frz")])
    assert not storms.is_stale(repo, sorted(COUNTIES), built + timedelta(hours=1))  # not roof-damaging
    store.upsert_signals(repo, [warn("Severe Thunderstorm Warning", datetime(2026, 10, 16, 22, 15, tzinfo=timezone.utc),
                                     "svr")])
    assert storms.is_stale(repo, sorted(COUNTIES), built + timedelta(hours=1))
    # Rebuilt after the 6 h confirmation window: fresh again.
    rebuilt = datetime(2026, 10, 17, 4, 30, tzinfo=timezone.utc)
    with repo.engine.begin() as conn:
        from leadmaker.db.schema import regional_signals as rs
        conn.execute(rs.update().where(rs.c.kind == storms.KIND).values(fetched_at=rebuilt))
    assert not storms.is_stale(repo, sorted(COUNTIES), rebuilt + timedelta(hours=1))
