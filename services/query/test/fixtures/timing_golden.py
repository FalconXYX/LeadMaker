"""Golden cases for the TypeScript port of leadmaker/signals/timing.py (services/query/src/timing.ts).

Regenerate after changing the Python rules (reads data/leadmaker.db read-only):
    .venv/bin/python services/query/test/fixtures/timing_golden.py
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from leadmaker.signals.timing import timing_badges

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).with_name("timing-golden.json")
NOW = datetime(2026, 10, 16, 21, 0, tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


def alert(county: str, event: str, start: datetime, end: datetime | None, onset: datetime | None = None,
          geometry: dict | None = None) -> dict:
    payload = {"event": event, "areaDesc": "Test County"}
    if onset:
        payload["onset"] = iso(onset)
    if geometry:
        payload["geometry"] = geometry
    return {"county_fips": county, "kind": "active_alert", "source": "nws", "payload": payload,
            "valid_from": iso(start), "valid_to": iso(end) if end else None}


def history(county: str, events: list[dict]) -> dict:
    return {"county_fips": county, "kind": "storm_history", "source": "noaa_storm_events",
            "payload": {"recent_events": events}, "valid_from": None, "valid_to": None}


def event(date: str, kind: str, **kw) -> dict:
    return {"date": date, "kind": kind, "event_type": kw.pop("event_type", kind.upper()), "source": "lsr",
            "valid": kw.pop("valid", f"{date}T20:30:00Z"), **kw}


SQUARE = {"type": "Polygon", "coordinates": [[[-74.1, 40.6], [-73.9, 40.6], [-73.9, 40.8], [-74.1, 40.8], [-74.1, 40.6]]]}
DONUT = {"type": "MultiPolygon", "coordinates": [
    [[[-74.2, 40.5], [-73.8, 40.5], [-73.8, 40.9], [-74.2, 40.9], [-74.2, 40.5]],
     [[-74.05, 40.65], [-73.95, 40.65], [-73.95, 40.75], [-74.05, 40.75], [-74.05, 40.65]]],
]}

STORM_ROOFER = {"state": "NY", "county_fips": "36061", "latitude": 40.7, "longitude": -74.0,
                "tags": [{"key": "service:storm_damage", "value": True}, {"key": "service:roof_repair", "value": True}]}
PLAIN = {"state": "NY", "county_fips": "36061", "latitude": 40.7, "longitude": -74.0,
         "tags": [{"key": "service:roof_repair", "value": True}]}
NEW_BUILD = {"state": "NJ", "county_fips": "34003", "latitude": 40.9, "longitude": -74.05,
             "tags": [{"key": "service:new_construction", "value": True}]}
OUTSIDE = {**STORM_ROOFER, "latitude": 40.85, "longitude": -74.15}
ENRICHED = {"state": "", "county_fips": "36061", "latitude": 40.7, "longitude": -74.0, "tags": [],
            "enrichment": {"website_crawl": {"status": "ok", "data": {"services": ["insurance_claims", "emergency_service"]}},
                           "llm_extract": {"status": "error", "data": {"services": ["storm_damage"]}}}}
TAG_ONLY = {"state": "NJ", "county_fips": "34003", "latitude": 40.9, "longitude": -74.05,
            "tags": [{"key": "storm_insurance", "value": True}, {"key": "service:metal_roofing", "value": False}]}
NO_POINT = {**STORM_ROOFER, "latitude": None}
CT = {"state": "CT", "county_fips": "09001", "latitude": 41.1, "longitude": -73.4, "tags": []}

h = timedelta(hours=1)
d = timedelta(days=1)
warning = alert("36061", "Severe Thunderstorm Warning", NOW - 2 * h, NOW + h, geometry=SQUARE)
lsr = history("36061", [event("2026-10-16", "wind", event_type="TSTM WND DMG", location="2 N Manhattan",
                              valid="2026-10-16T20:10:00Z", first_valid="2026-10-16T19:50:00Z", report_count=3)])

SYNTHETIC: list[tuple[str, dict, list[dict], datetime]] = [
    ("warning confirmed by LSR", STORM_ROOFER, [warning, lsr], NOW),
    ("warning unconfirmed", STORM_ROOFER, [warning], NOW),
    ("warning, lead outside polygon", OUTSIDE, [warning, lsr], NOW),
    ("warning, lead in donut hole", STORM_ROOFER, [alert("36061", "Tornado Warning", NOW - h, NOW + h, geometry=DONUT)], NOW),
    ("warning, lead in donut ring", OUTSIDE, [alert("36061", "Tornado Warning", NOW - h, NOW + h, geometry=DONUT)], NOW),
    ("warning, no lead point", NO_POINT, [warning, lsr], NOW),
    ("non-storm roofer", PLAIN, [warning, lsr], NOW),
    ("non-storm roofer outside", {**PLAIN, "latitude": 40.85, "longitude": -74.15}, [warning], NOW),
    ("enrichment services, no state", ENRICHED, [alert("36061", "Severe Thunderstorm Watch", NOW - h, NOW + 3 * h)], NOW),
    ("storm tag only", TAG_ONLY, [alert("34003", "High Wind Warning", NOW - 3 * d, NOW - 2 * d)], NOW),
    ("ended watch ignored", STORM_ROOFER, [alert("36061", "Severe Thunderstorm Watch", NOW - 3 * h, NOW - h)], NOW),
    ("ended warning recent", STORM_ROOFER, [alert("36061", "Severe Thunderstorm Warning", NOW - 6 * d, NOW - 5 * d)], NOW),
    ("ended warning too old", STORM_ROOFER, [alert("36061", "Severe Thunderstorm Warning", NOW - 9 * d, NOW - 8 * d)], NOW),
    ("ended today", STORM_ROOFER, [alert("36061", "Wind Advisory", NOW - 5 * h, NOW - 2 * h)], NOW),
    ("far-future watch skipped", STORM_ROOFER, [alert("36061", "Hurricane Watch", NOW, NOW + 5 * d, onset=NOW + 3 * d)], NOW),
    ("upcoming onset", STORM_ROOFER, [alert("36061", "Winter Storm Warning", NOW - h, NOW + 2 * d, onset=NOW + 20 * h)], NOW),
    ("winter advisory not roof-damaging", STORM_ROOFER, [alert("36061", "Winter Weather Advisory", NOW - h, NOW + h)], NOW),
    ("statements and frost ignored", STORM_ROOFER, [alert("36061", "Special Weather Statement", NOW - h, NOW + h),
                                                    alert("36061", "Frost Advisory", NOW - h, NOW + h)], NOW),
    ("other county ignored", STORM_ROOFER, [alert("34003", "Tornado Warning", NOW - h, NOW + h)], NOW),
    ("several alerts, also list", STORM_ROOFER, [
        alert("36061", "Wind Advisory", NOW - 2 * h, NOW + 5 * h),
        alert("36061", "Severe Thunderstorm Warning", NOW - h, NOW + h),
        alert("36061", "Coastal Flood Warning", NOW - h, NOW + 4 * h),
        alert("36061", "Tornado Watch", NOW - h, NOW + 3 * h),
        alert("36061", "Severe Thunderstorm Warning", NOW - 3 * h, NOW - 2 * h)], NOW),
    ("no end time", STORM_ROOFER, [alert("36061", "High Wind Warning", NOW - h, None)], NOW),
    ("new build, winter delays", NEW_BUILD, [alert("34003", "Winter Storm Warning", NOW - h, NOW + d)], NOW),
    ("new build, extended flood", NEW_BUILD, [alert("34003", "Flood Watch", NOW - h, NOW + d, onset=NOW - h)], NOW),
    ("new build, short flood", NEW_BUILD, [alert("34003", "Flash Flood Warning", NOW - h, NOW + 2 * h, onset=NOW - h)], NOW),
    ("new build, cold", NEW_BUILD, [alert("34003", "Extreme Cold Warning", NOW - h, NOW + h)], NOW),
    ("recent storm: two reports", PLAIN, [history("36061", [event("2026-10-01", "wind"), event("2026-10-02", "hail", magnitude=0.5)])], NOW),
    ("recent storm: one lone report", PLAIN, [history("36061", [event("2026-10-01", "wind", narrative="Tree down")])], NOW),
    ("recent storm: one significant gust", STORM_ROOFER, [history("36061", [event("2026-10-01", "wind", gust_mph=61)])], NOW),
    ("recent storm: knots", PLAIN, [history("36061", [event("2026-10-01", "wind", event_type="TSTM WND GST", magnitude=52, unit="kt")])], NOW),
    ("recent storm: big hail", PLAIN, [history("36061", [event("2026-10-03", "hail", magnitude=1.25, location="Midtown")])], NOW),
    ("recent storm: structure narrative", PLAIN, [history("36061", [event("2026-10-03", "wind", narrative="Roof blown off a house")])], NOW),
    ("recent storm: tornado", PLAIN, [history("36061", [event("2026-10-03", "tornado")])], NOW),
    ("recent storm: floods excluded", PLAIN, [history("36061", [event("2026-10-03", "flood", report_count=5)])], NOW),
    ("recent storm: too old", PLAIN, [history("36061", [event("2026-09-01", "wind", report_count=5)])], NOW),
    ("recent storm: capped", PLAIN, [history("36061", [event(f"2026-10-{i:02d}", "wind") for i in range(1, 11)])], NOW),
    ("recent storm: noaa source", PLAIN, [history("36061", [{**event("2026-10-05", "hail", magnitude=1.5), "source": "noaa"},
                                                              event("2026-10-05", "wind", valid="2026-10-05T21:00:00Z")])], NOW),
    ("second history row used", PLAIN, [history("36061", [event("2026-10-01", "wind", narrative="Tree down")]),
                                        history("36061", [event("2026-10-02", "tornado")])], NOW),
    ("warning confirmed by history in window", STORM_ROOFER, [
        alert("36061", "Tornado Warning", NOW - 2 * d, NOW - 2 * d + h),
        history("36061", [event("2026-10-14", "tornado", valid=iso(NOW - 2 * d + 2 * h), report_count=0),
                          event("2026-10-14", "wind", valid=iso(NOW - 2 * d - 7 * h))])], NOW),
    ("polygon miss ranked first, zone alert covers the lead", OUTSIDE, [
        warning, alert("36061", "Wind Advisory", NOW - h, NOW + 2 * h)], NOW),
    ("confirming reports listed oldest first", STORM_ROOFER, [warning, history("36061", [
        event("2026-10-16", "wind", event_type="TSTM WND DMG", location="Older St", valid="2026-10-16T19:40:00Z"),
        event("2026-10-16", "hail", event_type="HAIL", location="Newer Ave", valid="2026-10-16T20:20:00Z", report_count=2),
        event("2026-10-16", "flood", location="Ignored", valid="2026-10-16T20:50:00Z")])], NOW),
    ("season january", PLAIN, [], datetime(2026, 1, 15, 15, tzinfo=timezone.utc)),
    ("season march", PLAIN, [], datetime(2026, 3, 15, 15, tzinfo=timezone.utc)),
    ("season november", NEW_BUILD, [], datetime(2026, 11, 15, 15, tzinfo=timezone.utc)),
    ("season december", PLAIN, [], datetime(2026, 12, 15, 15, tzinfo=timezone.utc)),
    ("no season outside NY/NJ", CT, [], NOW),
    ("state from county prefix", {**PLAIN, "state": None, "county_fips": "34003"}, [], NOW),
]


USED_PAYLOAD = {"event", "onset", "geometry", "recent_events"}  # what timing.py reads (keeps the fixture small)


def real_cases() -> list[tuple[str, dict, list[dict], datetime]]:
    db = sqlite3.connect(f"file:{ROOT / 'data' / 'leadmaker.db'}?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    signals: dict[str, list[dict]] = {}
    for r in db.execute("SELECT * FROM regional_signals WHERE kind IN ('active_alert', 'storm_history') "
                        "ORDER BY valid_from DESC"):
        payload = {k: v for k, v in json.loads(r["payload"]).items() if k in USED_PAYLOAD}
        signals.setdefault(r["county_fips"], []).append(
            {"county_fips": r["county_fips"], "kind": r["kind"], "source": r["source"],
             "payload": payload, "valid_from": r["valid_from"], "valid_to": r["valid_to"]})
    enrich: dict[str, dict] = {}
    for r in db.execute("SELECT gaf_id, source, status, data FROM enrichments WHERE source IN ('website_crawl', 'llm_extract')"):
        data = json.loads(r["data"] or "{}")
        enrich.setdefault(r["gaf_id"], {})[r["source"]] = {"status": r["status"], "data": {"services": data.get("services") or []}}
    leads = []
    for r in db.execute("SELECT gaf_id, state, county_fips, latitude, longitude, tags FROM contractors ORDER BY gaf_id"):
        tags = [{"key": t.get("key"), "value": t.get("value")} for t in json.loads(r["tags"])
                if str(t.get("key", "")).startswith("service:") or t.get("key") == "storm_insurance"]
        leads.append({"gaf_id": r["gaf_id"], "state": r["state"], "county_fips": r["county_fips"],
                      "latitude": r["latitude"], "longitude": r["longitude"], "tags": tags,
                      "enrichment": enrich.get(r["gaf_id"], {})})
    out, seen = [], set()
    for now in (datetime(2026, 10, 16, 22, 40, tzinfo=timezone.utc), datetime(2026, 10, 18, 21, 0, tzinfo=timezone.utc)):
        for lead in leads:
            sig = signals.get(lead["county_fips"] or "", [])
            badges = timing_badges(lead, sig, now)
            shape = (lead["county_fips"], now, tuple((b["key"], b["severity"], b["label"]) for b in badges))
            if shape in seen:
                continue
            seen.add(shape)
            out.append((f"real {lead['gaf_id']} @ {now:%m-%d %H:%M}", lead, sig, now))
    return out


def main() -> None:
    sets: dict[str, list[dict]] = {}
    cases = []
    for name, lead, sig, now in SYNTHETIC + real_cases():
        key = json.dumps(sig, sort_keys=True, default=str)
        set_id = next((k for k, v in sets.items() if json.dumps(v, sort_keys=True, default=str) == key), None)
        if set_id is None:
            set_id = f"s{len(sets)}"
            sets[set_id] = sig
        lead = {k: v for k, v in lead.items() if k != "gaf_id"}
        cases.append({"name": name, "lead": lead, "signals": set_id, "now": iso(now),
                      "expected": timing_badges(lead, sig, now)})
    OUT.write_text(json.dumps({"signalSets": sets, "cases": cases}, separators=(",", ":"), default=str) + "\n")
    print(f"wrote {len(cases)} cases, {len(sets)} signal sets -> {OUT}")


if __name__ == "__main__":
    main()
