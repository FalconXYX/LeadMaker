"""24-month roof-relevant storm history per county (one summary row per county).

Ported from research/market_demand (02_storm_events.py, 03_iem_lsr.py, 08_county_summary.py).

Sources (all keyless, cached under data/cache/, refreshed at most every REFRESH_DAYS):
  * NOAA NCEI Storm Events bulk CSV, one "details" file per year (~12 MB gz):
    https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/  -- the official record,
    published with a ~3-month lag (robots disallows /data*, not /pub/data).
  * NWS zone -> county correlation file (zone-based events like High Wind / Winter Storm
    are reported per forecast zone; the file also gives each county's forecast office):
    linked from https://www.weather.gov/gis/ZoneCounty (bpDDmmYY.dbx, re-issued ~yearly).
  * NWS Local Storm Reports via the Iowa Environmental Mesonet archive, to fill the NCEI
    lag with preliminary reports: https://mesonet.agron.iastate.edu/geojson/lsr.php.
    IEM robots.txt asks Crawl-delay: 120 -> ONE request per refresh (max 10,000 features).

Kept: wind >= 50 kt (58 mph) or reported damage, hail, tornadoes, tropical systems,
floods (flash / river / coastal) and winter storms (snow, blizzard, ice). NY/NJ is a
wind market (research: 3 hail vs 265 wind events in 24 months), so wind dominates.
LSRs are point reports (often several per storm), so they are collapsed to one event
per county, day and kind; zone-based NCEI events are de-duplicated the same way.

Binary downloads (the .csv.gz files) need `Response.content`; until leadmaker/http.py
exposes it, already-cached NCEI files are used and missing years are reported in
`coverage.ncei_missing_years` (LSRs then cover those years, capped at 10k reports).
"""

from __future__ import annotations

import csv
import gzip
import logging
import re
from collections import Counter, defaultdict
from collections.abc import Callable
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from ..config import Settings
from ..db import Repository
from ..http import HttpClient, Response
from . import store
from .counties import USPS_TO_FIPS, CountyIndex, cache_dir

log = logging.getLogger(__name__)

NCEI_HOST = "www.ncei.noaa.gov"
NCEI_BASE = f"https://{NCEI_HOST}/pub/data/swdi/stormevents/csvfiles/"
ZONE_PAGE = "https://www.weather.gov/gis/ZoneCounty"
ZONE_BASE = "https://www.weather.gov/source/gis/Shapefiles/County/"
LSR_HOST = "mesonet.agron.iastate.edu"
LSR_URL = f"https://{LSR_HOST}/geojson/lsr.php"
LSR_CRAWL_DELAY_S = 120
LSR_MAX_FEATURES = 10_000  # IEM's cap; it returns the newest first, so a capped answer loses the oldest
# LSR times are UTC; events are dated in local time like NCEI's (an evening storm is 23:00-01:00Z).
LSR_TZ = ZoneInfo("America/New_York")

SOURCE = "noaa_storm_events"
KIND = "storm_history"
EXTERNAL_ID = "summary_24m"
WINDOW_DAYS = 730
REFRESH_DAYS = 30
WIND_MIN_KT = 50
WIND_MIN_MPH = 58
HAIL_SIG_IN = 1.0
RECENT_EVENTS = 10

NCEI_KIND = {
    "Thunderstorm Wind": "wind", "High Wind": "wind", "Strong Wind": "wind",
    "Hail": "hail", "Tornado": "tornado",
    "Tropical Storm": "tropical", "Tropical Depression": "tropical", "Hurricane": "tropical",
    "Hurricane (Typhoon)": "tropical",
    "Flood": "flood", "Flash Flood": "flood", "Coastal Flood": "flood", "Storm Surge/Tide": "flood",
    "Winter Storm": "winter", "Heavy Snow": "winter", "Blizzard": "winter", "Ice Storm": "winter",
}
LSR_KIND = {
    "TSTM WND DMG": "wind", "TSTM WND GST": "wind", "NON-TSTM WND GST": "wind", "NON-TSTM WND DMG": "wind",
    "HIGH SUST WINDS": "wind", "HAIL": "hail", "TORNADO": "tornado",
    "FLASH FLOOD": "flood", "FLOOD": "flood", "COASTAL FLOOD": "flood",
    "SNOW/ICE DMG": "winter", "BLIZZARD": "winter", "ICE STORM": "winter",
}
LSR_MEASURED_WIND = {"TSTM WND GST", "NON-TSTM WND GST", "HIGH SUST WINDS"}  # need >= 58 mph
KINDS = ("wind", "hail", "tornado", "tropical", "flood", "winter")
MONTHS = {"ja": 1, "fe": 2, "mr": 3, "ap": 4, "my": 5, "jn": 6, "jl": 7, "au": 8, "se": 9, "oc": 10,
          "no": 11, "de": 12}


def _float(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def money(s: str | None) -> float:
    """NCEI damage strings: '25.00K' -> 25000.0."""
    if not s:
        return 0.0
    mult = {"K": 1e3, "M": 1e6, "B": 1e9}.get(s[-1].upper(), 1)
    try:
        return float(s[:-1] if s[-1].isalpha() else s) * mult
    except ValueError:
        return 0.0


# ------------------------------------------------------------------ downloads
def _can_fetch_bytes() -> bool:
    return "content" in getattr(Response, "__dataclass_fields__", {})


async def _download(http: HttpClient, url: str, path: Path, *, binary: bool, timeout: float = 600) -> bool:
    """Fetch url into path atomically. False if binary is needed but unsupported by the client."""
    if binary and not _can_fetch_bytes():
        log.warning("storms: HttpClient Response has no .content; cannot download %s", url)
        return False
    resp = await http.get(url, timeout=timeout)
    tmp = path.with_suffix(path.suffix + ".part")
    if binary:
        tmp.write_bytes(resp.content)  # type: ignore[attr-defined]
    else:
        tmp.write_text(resp.text, encoding="utf-8")
    tmp.replace(path)
    return True


def latest_ncei_files(index_html: str, years: range) -> dict[int, str]:
    """Newest details file per year from the NCEI directory listing."""
    out: dict[int, str] = {}
    for y in years:
        names = sorted(set(re.findall(rf"StormEvents_details-ftp_v1\.0_d{y}_c\d{{8}}\.csv\.gz", index_html)))
        if names:
            out[y] = names[-1]
    return out


def _cached_ncei(cache: Path, year: int) -> Path | None:
    files = sorted(cache.glob(f"StormEvents_details-ftp_v1.0_d{year}_c*.csv.gz"))
    return files[-1] if files else None


async def ensure_ncei_files(http: HttpClient, cache: Path, years: range) -> tuple[dict[int, Path], list[int]]:
    """({year: local file}, years with no data). Prefers the newest published file, else the newest cached."""
    http.set_host_interval(NCEI_HOST, 2.0)
    try:
        published = latest_ncei_files((await http.get(NCEI_BASE)).text, years)
    except Exception as e:  # listing down: fall back to whatever is cached
        log.warning("storms: NCEI listing failed (%s); using cached files", e)
        published = {}
    files: dict[int, Path] = {}
    missing: list[int] = []
    for y in years:
        name = published.get(y)
        path = cache / name if name else None
        if path is not None and not path.exists():
            try:
                await _download(http, NCEI_BASE + name, path, binary=True)  # type: ignore[operator]
            except Exception as e:
                log.warning("storms: download of %s failed: %s", name, e)
        if path is not None and path.exists():
            for old in cache.glob(f"StormEvents_details-ftp_v1.0_d{y}_c*.csv.gz"):
                if old != path:
                    old.unlink(missing_ok=True)  # superseded NCEI revision
            files[y] = path
        elif (cached := _cached_ncei(cache, y)) is not None:
            files[y] = cached
        else:
            missing.append(y)
    return files, missing


def _zone_file_date(name: str) -> tuple[int, int, int]:
    m = re.match(r"bp(\d{2})([a-z]{2})(\d{2})\.dbx", name)
    if not m:
        return (0, 0, 0)
    return (int(m.group(3)), MONTHS.get(m.group(2), 0), int(m.group(1)))


async def ensure_zone_file(http: HttpClient, cache: Path) -> Path | None:
    """Newest NWS zone-county correlation file (cached by its release name)."""
    names: list[str] = []
    try:
        names = re.findall(r"(bp\d{2}[a-z]{2}\d{2}\.dbx)", (await http.get(ZONE_PAGE)).text)
    except Exception as e:
        log.warning("storms: zone-county page failed (%s); using cached file", e)
    if names:
        newest = max(names, key=_zone_file_date)
        path = cache / newest
        if not path.exists():
            try:
                await _download(http, ZONE_BASE + newest, path, binary=False)
            except Exception as e:
                log.warning("storms: zone-county download failed: %s", e)
        if path.exists():
            return path
    cached = sorted(cache.glob("bp*.dbx"), key=lambda p: _zone_file_date(p.name))
    return cached[-1] if cached else None


# --------------------------------------------------------------------- parsing
class ZoneMap:
    """NWS forecast zone -> counties, and county -> forecast office (CWA)."""

    def __init__(self, text: str):
        self.counties: dict[tuple[str, str], set[str]] = defaultdict(set)  # (state_fips, zone) -> {county}
        self.cwa: dict[str, set[str]] = defaultdict(set)  # county_fips -> {"OKX"}
        for line in text.splitlines():
            f = line.split("|")
            if len(f) > 6 and len(f[6]) == 5 and f[6].isdigit():
                st = USPS_TO_FIPS.get(f[0])
                if st:
                    self.counties[(st, f[1].zfill(3))].add(f[6])
                if f[2]:
                    self.cwa[f[6]].add(f[2])

    def offices(self, county_fips: list[str]) -> list[str]:
        return sorted({w for c in county_fips for w in self.cwa.get(c, ())})


def parse_ncei(lines: Any, counties: set[str], zones: ZoneMap | None, start: date, end: date) -> tuple[list[dict], date | None]:
    """Roof-relevant NCEI events for our counties in [start, end] -> (events, coverage end of the file)."""
    states = {c[:2] for c in counties}
    events: list[dict[str, Any]] = []
    coverage: date | None = None
    for r in csv.DictReader(lines):
        try:
            d = datetime.strptime(r["BEGIN_DATE_TIME"], "%d-%b-%y %H:%M:%S").date()
        except (KeyError, ValueError):
            continue
        coverage = d if coverage is None or d > coverage else coverage
        kind = NCEI_KIND.get(r.get("EVENT_TYPE") or "")
        sf = str(r.get("STATE_FIPS") or "").zfill(2)
        if kind is None or sf not in states or d < start or d > end:
            continue
        mag = _float(r.get("MAGNITUDE"))
        if kind == "wind" and mag < WIND_MIN_KT and (mag > 0 or r["EVENT_TYPE"] == "Strong Wind"):
            continue  # below severe (Strong Wind is < 50 kt by definition)
        cz = str(r.get("CZ_FIPS") or "").zfill(3)
        if r.get("CZ_TYPE") == "C":
            hit = {sf + cz}
        else:
            hit = set(zones.counties.get((sf, cz), set())) if zones else set()
        hit &= counties
        for c in hit:
            events.append({
                "county_fips": c, "date": d.isoformat(), "kind": kind, "event_type": r["EVENT_TYPE"],
                "magnitude": mag or None, "unit": "in" if kind == "hail" else ("kt" if kind == "wind" and mag else None),
                "location": (r.get("BEGIN_LOCATION") or r.get("CZ_NAME") or "").title() or None,
                "damage_usd": round(money(r.get("DAMAGE_PROPERTY")) / max(len(hit), 1)),
                "narrative": " ".join((r.get("EVENT_NARRATIVE") or r.get("EPISODE_NARRATIVE") or "").split())[:200],
                "source": "ncei", "event_id": r.get("EVENT_ID"), "zone_based": r.get("CZ_TYPE") != "C",
            })
    return events, coverage


def _lsr_date(valid: str | None) -> str | None:
    """IEM `valid` ('2026-07-05T00:09:00Z', UTC) -> local calendar date '2026-07-04'."""
    if not valid:
        return None
    try:
        dt = datetime.fromisoformat(valid.replace("Z", "+00:00"))
    except ValueError:
        return valid[:10] or None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LSR_TZ).date().isoformat()


def parse_lsr(features: list[dict[str, Any]], counties: set[str], index: CountyIndex, start: date) -> list[dict]:
    """IEM LSR GeoJSON features -> roof-relevant events (unit-aware wind threshold)."""
    out = []
    for f in features:
        p = f.get("properties") or {}
        typ = p.get("typetext") or ""
        kind = LSR_KIND.get(typ)
        if kind is None:
            continue
        mag = _float(p.get("magnitude"))
        if typ in LSR_MEASURED_WIND:
            mph = mag * 1.15078 if (p.get("unit") or "").upper() in ("KTS", "KNOTS", "KT") else mag
            if mph < WIND_MIN_MPH:
                continue
        d = _lsr_date(p.get("valid"))
        if not d or d < start.isoformat():
            continue
        fips = index.fips_for_name(p.get("st") or p.get("state"), p.get("county"))
        if fips not in counties:
            continue
        out.append({
            "county_fips": fips, "date": d, "kind": kind, "event_type": typ, "magnitude": mag or None,
            "unit": (p.get("unit") or "").lower() or None, "location": p.get("city"),
            "damage_usd": 0, "narrative": " ".join((p.get("remark") or "").split())[:200],
            "source": "lsr", "event_id": p.get("product_id"), "zone_based": False,
        })
    return out


def dedupe(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One event per (county, day, kind) for zone-based NCEI rows and LSRs; county NCEI rows stay distinct."""
    seen: set[Any] = set()
    out = []
    for e in sorted(events, key=lambda e: (e["date"], -(e.get("damage_usd") or 0), -(e.get("magnitude") or 0))):
        key = (e["county_fips"], e["date"], e["kind"]) if (e["zone_based"] or e["source"] == "lsr") \
            else (e["county_fips"], e["event_id"])
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def summarise(events: list[dict[str, Any]], county: str, as_of: date, coverage: dict[str, Any]) -> dict[str, Any]:
    ev = sorted((e for e in events if e["county_fips"] == county), key=lambda e: e["date"], reverse=True)
    start12 = (as_of - timedelta(days=365)).isoformat()
    counts = Counter(e["kind"] for e in ev)

    def brief(e: dict[str, Any]) -> dict[str, Any]:
        return {k: e.get(k) for k in ("date", "kind", "event_type", "magnitude", "unit", "location",
                                      "damage_usd", "narrative", "source")}

    notable = max((e for e in ev if e["kind"] != "winter"),
                  key=lambda e: (e.get("damage_usd") or 0, e.get("magnitude") or 0), default=None)
    return {
        "events_24m": len(ev),
        "events_12m": sum(1 for e in ev if e["date"] >= start12),
        "counts_24m": {k: counts.get(k, 0) for k in KINDS},
        "wind_ge_50kt_24m": counts.get("wind", 0),
        "hail_ge_1in_24m": sum(1 for e in ev if e["kind"] == "hail" and (e.get("magnitude") or 0) >= HAIL_SIG_IN),
        "storm_days_24m": len({e["date"] for e in ev if e["kind"] != "winter"}),
        "property_damage_24m_usd": round(sum(e.get("damage_usd") or 0 for e in ev)),
        "last_event_at": ev[0]["date"] if ev else None,
        "last_event": brief(ev[0]) if ev else None,
        "notable_event": brief(notable) if notable else None,
        "recent_events": [brief(e) for e in ev[:RECENT_EVENTS]],
        "coverage": coverage,
    }


# ------------------------------------------------------------------- pipeline
async def fetch_lsr(http: HttpClient, offices: list[str], start: date, end: datetime) -> list[dict[str, Any]]:
    http.set_host_interval(LSR_HOST, LSR_CRAWL_DELAY_S)
    resp = await http.get(LSR_URL, params={
        "sts": start.strftime("%Y%m%d0000"), "ets": end.strftime("%Y%m%d%H%M"), "wfos": ",".join(offices),
    }, timeout=180, retries=1)  # each retry waits the 120 s crawl delay; a failure is retried next run
    return resp.json().get("features") or []


def is_stale(repo: Repository, county_fips: list[str], now: datetime) -> bool:
    """A county summary is missing, older than REFRESH_DAYS, or was built while the LSR fetch failed.

    LSRs are the only source after NCEI's ~3-month lag (all of `recent_storm`), so a failed
    fetch is retried on the next run instead of waiting a month.
    """
    rows = store.signals_for_counties(repo, county_fips, kinds=[KIND])
    cutoff = now - timedelta(days=REFRESH_DAYS)
    for c in county_fips:
        row = next((r for r in rows.get(c, []) if r["source"] == SOURCE and r["external_id"] == EXTERNAL_ID), None)
        if row is None or row["fetched_at"] is None or row["fetched_at"] < cutoff:
            return True
        if ((row.get("payload") or {}).get("coverage") or {}).get("lsr_error"):
            return True
    return False


def _lsr_window(
    start: date, years: dict[int, Path], missing_years: list[int], ncei_end: date | None
) -> tuple[date, Callable[[str], bool]]:
    """(first day LSRs are needed, predicate 'NCEI already covers this ISO date').

    NCEI covers every year it has a file for, up to its newest event (the latest file is
    partial). LSRs fill the rest: the post-NCEI gap and any year whose file is missing. A
    current year NCEI has not published yet (Jan-Apr) is just part of the post-NCEI gap.
    """
    end_iso = ncei_end.isoformat() if ncei_end else ""

    def covered(d: str) -> bool:
        return bool(end_iso) and int(d[:4]) in years and d <= end_iso

    gaps = [max(start, date(y, 1, 1)) for y in missing_years]
    gaps.append(ncei_end + timedelta(days=1) if ncei_end else start)
    return min(gaps), covered


async def build_storm_history(
    http: HttpClient, index: CountyIndex, county_fips: list[str], *, now: datetime | None = None,
    cache: str | Path | None = None, use_lsr: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Download/parse sources and return (regional_signals rows, stats)."""
    now = now or datetime.now(timezone.utc)
    as_of = now.date()
    start = as_of - timedelta(days=WINDOW_DAYS)
    counties = set(county_fips)
    cdir = cache_dir(cache)
    zone_path = await ensure_zone_file(http, cdir)
    zones = ZoneMap(zone_path.read_text(errors="ignore")) if zone_path else None
    files, missing_years = await ensure_ncei_files(http, cdir, range(start.year, as_of.year + 1))
    events: list[dict[str, Any]] = []
    ncei_end: date | None = None
    for y, path in sorted(files.items()):
        with gzip.open(path, "rt", encoding="latin-1") as fh:
            ev, cov = parse_ncei(fh, counties, zones, start, as_of)
        events += ev
        if cov and (ncei_end is None or cov > ncei_end):
            ncei_end = cov
    # LSRs only where NCEI has no data, so the two sources never double count.
    lsr_from, ncei_covered = _lsr_window(start, files, missing_years, ncei_end)
    lsr_n = 0
    lsr_error = None
    lsr_truncated = False
    offices = zones.offices(sorted(counties)) if zones else []
    if use_lsr and offices and lsr_from <= as_of:
        try:
            feats = await fetch_lsr(http, offices, lsr_from, now)
            lsr_truncated = len(feats) >= LSR_MAX_FEATURES
            lsr = [e for e in parse_lsr(feats, counties, index, lsr_from) if not ncei_covered(e["date"])]
            lsr_n = len(lsr)
            events += lsr
        except Exception as e:
            lsr_error = f"{type(e).__name__}: {e}"[:300]
            log.warning("storms: LSR fetch failed: %s", lsr_error)
    events = dedupe(events)
    coverage = {
        "window_start": start.isoformat(), "as_of": as_of.isoformat(),
        "ncei_files": {str(y): p.name for y, p in sorted(files.items())},
        "ncei_through": ncei_end.isoformat() if ncei_end else None,
        "ncei_missing_years": missing_years,
        "lsr_from": lsr_from.isoformat() if use_lsr and offices else None,
        "lsr_offices": offices,
        "lsr_error": lsr_error,
        "lsr_truncated": lsr_truncated,  # IEM cap hit: the oldest part of the LSR window is missing
    }
    rows = [{
        "county_fips": c, "kind": KIND, "source": SOURCE, "external_id": EXTERNAL_ID,
        "payload": summarise(events, c, as_of, coverage),
        "valid_from": datetime.combine(start, time.min, tzinfo=timezone.utc),
        "valid_to": now, "fetched_at": now,
    } for c in sorted(counties)]
    stats = {"counties": len(rows), "events": len(events), "lsr_events": lsr_n,
             "by_kind": dict(Counter(e["kind"] for e in events)), **coverage}
    return rows, stats


async def refresh_storm_history(
    http: HttpClient, settings: Settings, repo: Repository, index: CountyIndex, county_fips: list[str], *,
    now: datetime | None = None, force: bool = False, cache: str | Path | None = None,
) -> dict[str, Any]:
    """Recompute storm summaries if any county's is older than REFRESH_DAYS (or force)."""
    now = now or datetime.now(timezone.utc)
    county_fips = sorted({c for c in county_fips if c})
    if not county_fips:
        return {"skipped": "no counties"}
    if not force and not is_stale(repo, county_fips, now):
        return {"skipped": f"fresh (< {REFRESH_DAYS} days)", "counties": len(county_fips)}
    rows, stats = await build_storm_history(http, index, county_fips, now=now, cache=cache)
    stats["rows_written"] = store.upsert_signals(repo, rows)
    return stats
