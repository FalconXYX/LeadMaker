"""Timing badges: *when* to call a lead, from county weather and the calendar.

Pure function, no I/O and no LLM: `timing_badges(lead, signals, now)` where `lead` is a
lead record (repo.lead_records shape: state, county_fips, tags, enrichment) and
`signals` are `regional_signals` rows for the lead's county (rows for other counties
are ignored). Every badge is {key, label, reason, source, severity}; severity is one
of high | medium | low | info.

Rules (docs/sales-domain-research.md: storms drive *timing*, not fit)
  storm_response  storm / emergency / insurance roofers (generic roof repair alone is not enough),
                  when a roof-damaging NWS alert (wind, thunderstorm, tornado, tropical; winter and
                  coastal only at warning level) is active in their county or ended <= 7 days ago.
                  A warning is high only when an NWS storm report (LSR) in the county falls within
                  its window +-6 h (ground truth; most warnings are radar-indicated), otherwise
                  medium; watches/advisories -> medium. A watch only counts while active: one that
                  ended without a warning means the storm did not materialise in that county.
                  Storm-based warnings cover a polygon, often part of a county: a lead whose
                  latitude/longitude falls outside it gets a low "nearby" badge instead.
  weather_alert   the same alerts for every other lead (low: context, not a call trigger).
  recent_storm    storm history shows a significant roof-relevant event (wind, hail, tornado,
                  tropical, winter; not floods) in the county in the last 30 days: >= 2 reports,
                  a measured gust >= 58 mph, hail >= 1 in, a tornado / tropical system, or a report
                  that mentions a roof / home / house / structure. One lone "tree down" report is not.
  weather_delays  new-construction contractors while an extended precipitation / winter /
                  cold alert is in effect (jobs slip; shingles need ~50 F to seal).
  season          NY/NJ calendar note: Q1 planning and credit push, Apr-Nov in season,
                  Nov-Dec pre-buy and next-year planning.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

ALERT_LOOKBACK = timedelta(days=7)
RECENT_STORM = timedelta(days=30)
EXTENDED_ALERT = timedelta(hours=12)  # flood watches/warnings this long count as "extended" precipitation
LSR_CONFIRM = timedelta(hours=6)  # a storm report this close to a warning's window confirms it

# Service keys (tagging.taxonomy SERVICE_LABELS) that make a roofer storm-responsive. Not roof_repair:
# nearly every roofer lists it, so it said nothing about storm work (5 of 18 badges in the audit).
STORM_ROOFER_SERVICES = {"storm_damage", "insurance_claims", "emergency_service"}
STORM_TAG_SERVICES = {"storm_damage", "insurance_claims", "emergency_service"}  # taxonomy.STORM_SERVICES
NEW_CONSTRUCTION = "new_construction"
ROOF_DAMAGE_HAZARDS = {"tornado", "tropical", "thunderstorm", "wind", "winter", "coastal"}
# Winter Weather / Coastal Flood Advisories (a few inches of snow, minor tidal flooding) are routine
# and do not damage roofs; for these families only warnings are a storm-response trigger.
WARNING_ONLY_HAZARDS = {"winter", "coastal"}
DELAY_HAZARDS = {"winter", "cold", "flood"}
ROOF_STORM_KINDS = {"wind", "hail", "tornado", "tropical", "winter"}  # storm-history kinds (floods excluded)
SEVERE_GUST_MPH = 58
SEVERE_HAIL_IN = 1.0
MEASURED_WIND_TYPES = {"TSTM WND GST", "NON-TSTM WND GST", "HIGH SUST WINDS"}
STRUCTURE_RE = re.compile(r"\b(?:roofs?|homes?|houses?|structures?)\b", re.I)
SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2, "info": 3}
SEASON_STATES = {"NY", "NJ"}


def _dt(v: Any) -> datetime | None:
    if v is None:
        return None
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v)
        except ValueError:
            return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _in_ring(lon: float, lat: float, ring: list[Any]) -> bool:
    """Ray casting: does a ray east from the point cross the ring an odd number of times?"""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        (xi, yi), (xj, yj) = ring[i][:2], ring[j][:2]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_geometry(lat: float, lon: float, geometry: dict[str, Any] | None) -> bool | None:
    """GeoJSON Polygon / MultiPolygon ([lon, lat] rings, holes after the outer ring) contains the point?

    None when there is no usable geometry (zone-based alerts cover the whole zone).
    """
    if not isinstance(geometry, dict):
        return None
    coords = geometry.get("coordinates") or []
    polys = [coords] if geometry.get("type") == "Polygon" else coords if geometry.get("type") == "MultiPolygon" else []
    polys = [q for q in polys if q and len(q[0]) >= 4]
    if not polys:
        return None
    return any(_in_ring(lon, lat, q[0]) and not any(_in_ring(lon, lat, h) for h in q[1:]) for q in polys)


def _point(lead: dict[str, Any]) -> tuple[float, float] | None:
    try:
        lat, lon = float(lead["latitude"]), float(lead["longitude"])
    except (KeyError, TypeError, ValueError):
        return None
    return (lat, lon) if -90 <= lat <= 90 and -180 <= lon <= 180 else None


def hazard_family(event: str | None) -> str | None:
    """NWS event name -> hazard family (None for statements and irrelevant products like Frost Advisory)."""
    e = (event or "").lower()
    if not e or e.endswith("statement"):
        return None
    if "tornado" in e:
        return "tornado"
    if any(k in e for k in ("hurricane", "tropical storm", "storm surge", "extreme wind")):
        return "tropical"
    if "severe thunderstorm" in e:
        return "thunderstorm"
    if "high wind" in e or e == "wind advisory":
        return "wind"
    if any(k in e for k in ("winter storm", "winter weather", "blizzard", "ice storm", "lake effect snow",
                            "heavy snow", "snow squall")):
        return "winter"
    if "coastal flood" in e:
        return "coastal"
    if "flood" in e:
        return "flood"
    if any(k in e for k in ("extreme cold", "wind chill", "cold weather")):
        return "cold"
    return None


def alert_level(event: str | None) -> str:
    e = (event or "").lower()
    if e.endswith("warning"):
        return "warning"
    return "watch" if e.endswith("watch") else "advisory"


def lead_services(lead: dict[str, Any]) -> set[str]:
    """Service keys from the same shapes tagging reads (website_crawl / llm_extract) plus service:* tags."""
    found: set[str] = set()
    for source in ("website_crawl", "llm_extract"):
        row = (lead.get("enrichment") or {}).get(source)
        if row and row.get("status") == "ok":
            found |= {str(s) for s in (row.get("data") or {}).get("services") or []}
    storm_tag = False
    for t in lead.get("tags") or []:
        if not isinstance(t, dict) or not t.get("value"):
            continue
        key = str(t.get("key") or "")
        if key.startswith("service:"):
            found.add(key.split(":", 1)[1])
        elif key == "storm_insurance":
            storm_tag = True
    if storm_tag and not found & STORM_TAG_SERVICES:
        # The tag alone (no underlying service keys): don't claim a service the reason would then cite.
        found.add("storm_damage")
    return found


def _state(lead: dict[str, Any]) -> str | None:
    st = (lead.get("state") or "").upper()
    if st:
        return st
    return {"34": "NJ", "36": "NY"}.get(str(lead.get("county_fips") or "")[:2])


def _when(dt: datetime | None) -> str:
    """Display time in Eastern (the NY/NJ market), falling back to UTC without tz data."""
    if dt is None:
        return "unknown"
    try:
        loc, tz = dt.astimezone(ZoneInfo("America/New_York")), "ET"
    except Exception:  # pragma: no cover - missing tz database
        loc, tz = dt.astimezone(timezone.utc), "UTC"
    return f"{loc:%b} {loc.day} {loc:%H:%M} {tz}"


def _badge(key: str, label: str, reason: str, source: str, severity: str) -> dict[str, Any]:
    return {"key": key, "label": label, "reason": reason, "source": source, "severity": severity}


def _alerts(signals: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    """NWS alerts with family/state: active now, or ended within ALERT_LOOKBACK."""
    out = []
    for s in signals:
        if s.get("kind") != "active_alert":
            continue
        p = s.get("payload") or {}
        fam = hazard_family(p.get("event"))
        if fam is None:
            continue
        start, end = _dt(s.get("valid_from")), _dt(s.get("valid_to"))
        onset = _dt(p.get("onset")) or start  # valid_from is NWS `effective` (issue time); onset is the hazard start
        if onset is not None and onset > now + timedelta(days=2):
            continue  # far-future watch: not actionable yet
        active = end is None or end > now
        if not active and now - end > ALERT_LOOKBACK:  # type: ignore[operator]
            continue
        out.append({"event": p.get("event"), "family": fam, "active": active, "start": start, "onset": onset,
                    "end": end, "level": alert_level(p.get("event")), "area": p.get("areaDesc"),
                    "geometry": p.get("geometry"), "source": s.get("source")})
    # Active first, warnings before watches/advisories, most recent end first.
    out.sort(key=lambda a: (not a["active"], a["level"] != "warning",
                            -(a["end"] or now + timedelta(days=365)).timestamp()))
    return out


def _roof_damaging(a: dict[str, Any]) -> bool:
    if a["family"] not in ROOF_DAMAGE_HAZARDS:
        return False
    if a["family"] in WARNING_ONLY_HAZARDS and a["level"] != "warning":
        return False
    return a["active"] or a["level"] != "watch"  # an ended watch is not evidence of a storm


def _history_events(signals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for s in signals:
        if s.get("kind") == "storm_history":
            return list((s.get("payload") or {}).get("recent_events") or [])
    return []


def _confirming_reports(a: dict[str, Any], events: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    """Roof-relevant storm reports in the county within LSR_CONFIRM of the alert's window (newest first)."""
    starts = [t for t in (a.get("start"), a.get("onset")) if t]
    if not starts:
        return []
    lo, hi = min(starts) - LSR_CONFIRM, (a.get("end") or now) + LSR_CONFIRM
    out = []
    for e in events:
        last = _dt(e.get("valid"))
        first = _dt(e.get("first_valid")) or last
        if e.get("kind") in ROOF_STORM_KINDS and last and first and first <= hi and last >= lo:
            out.append(e)
    return sorted(out, key=lambda e: e.get("valid") or "", reverse=True)


def _gust_mph(e: dict[str, Any]) -> float:
    if e.get("gust_mph"):
        return float(e["gust_mph"])
    if e.get("event_type") in MEASURED_WIND_TYPES and e.get("magnitude"):  # payloads before gust_mph
        unit = (e.get("unit") or "").lower()
        return float(e["magnitude"]) * (1.15078 if unit in ("kt", "kts", "knots") else 1)
    return 0.0


def _significant(e: dict[str, Any]) -> bool:
    """One storm-history event that is roof-relevant on its own (no second report needed)."""
    if e.get("kind") in ("tornado", "tropical"):
        return True
    if e.get("kind") == "hail" and (e.get("magnitude") or 0) >= SEVERE_HAIL_IN:
        return True
    return _gust_mph(e) >= SEVERE_GUST_MPH or bool(e.get("structure")) or bool(
        STRUCTURE_RE.search(e.get("narrative") or ""))


def _alert_phrase(a: dict[str, Any], now: datetime) -> str:
    if a["active"]:
        if a.get("onset") and a["onset"] > now:
            return f"{a['event']} from {_when(a['onset'])} until {_when(a['end'])}"
        return f"{a['event']} in effect until {_when(a['end'])}"
    days = max(0, (now - a["end"]).days)
    ago = "today" if days == 0 else f"{days} day{'s' if days != 1 else ''} ago"
    return f"{a['event']} ended {_when(a['end'])} ({ago})"


def _season(month: int) -> tuple[str, str]:
    if month in (1, 2):
        return ("Q1: planning & new accounts",
                "Q1 is the distributor trough and planning window: push new-account and credit applications; "
                "GAF Rewards proofs are due 3/31.")
    if month == 3:
        return ("Pre-season: set up credit",
                "The season ramps Mar-Apr: set up or refresh credit before the rush and confirm delivery windows; "
                "GAF Rewards proofs are due 3/31.")
    if 4 <= month <= 10:
        return ("In season: service & storm response",
                "Apr-Nov is NY/NJ install season (shingles need ~50 F to seal): service plays, share gains "
                "and fast storm response.")
    if month == 11:
        return ("Season wind-down: pre-buy",
                "Nov-Dec: pre-buy ahead of manufacturer price increases and next-year planning while the "
                "season winds down.")
    return ("Pre-buy & next-year planning",
            "Nov-Dec: pre-buy ahead of manufacturer price increases and plan next year's volume.")


def timing_badges(lead: dict[str, Any], signals: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    now = _dt(now) or datetime.now(timezone.utc)
    county = lead.get("county_fips")
    if county:
        signals = [s for s in signals if not s.get("county_fips") or s.get("county_fips") == county]
    services = lead_services(lead)
    storm_roofer = bool(services & STORM_ROOFER_SERVICES)
    badges: list[dict[str, Any]] = []

    # --- NWS alerts ---------------------------------------------------------------
    alerts = _alerts(signals, now)
    history = _history_events(signals)
    roof = [a for a in alerts if _roof_damaging(a)]
    point = _point(lead)
    for a in roof:  # None: no polygon (zone-based alert) or no lead point -> the whole county counts
        a["here"] = point_in_geometry(point[0], point[1], a["geometry"]) if point else None
    roof.sort(key=lambda a: a["here"] is False)  # alerts covering the lead first (stable: keeps rank order)
    if roof:
        top = roof[0]
        nearby = top["here"] is False
        others = sorted({a["event"] for a in roof[1:] if a["event"] != top["event"] and (a["here"] is False) == nearby})
        extra = f"; also {', '.join(others)}" if others else ""
        where = " nearby (it covered part of this county, not this address)" if nearby else " in this county"
        if storm_roofer:
            listed = ", ".join(sorted(services & STORM_ROOFER_SERVICES)).replace("_", " ")
            recent = "" if top["active"] else " (recent)"
            if nearby:
                badges.append(_badge(
                    "storm_response", f"Storm nearby: {top['event']}{recent}",
                    f"NWS {_alert_phrase(top, now)}{where}{extra}. Lists {listed}: worth a check-in, "
                    "not a storm-response push.",
                    top["source"] or "nws", "low",
                ))
            else:
                severity, proof = "medium", ""
                if top["level"] == "warning":
                    reports = _confirming_reports(top, history, now)
                    if reports:
                        r = reports[0]
                        n = sum(int(e.get("report_count") or 1) for e in reports)
                        at = f" at {r['location']}" if r.get("location") else ""
                        severity = "high"
                        proof = (f"; {n} NWS storm report{'s' if n != 1 else ''} in this county "
                                 f"confirm{'s' if n == 1 else ''} it "
                                 f"(latest {r.get('event_type') or r.get('kind')}{at}, {_when(_dt(r.get('valid')))})")
                    else:
                        proof = "; no NWS storm reports in this county confirm damage yet"
                badges.append(_badge(
                    "storm_response", f"Storm response: {top['event']}{recent}",
                    f"NWS {_alert_phrase(top, now)}{where}{extra}{proof}. Lists {listed}: expect repair and "
                    "claim work -- lead with stock and fast delivery.",
                    top["source"] or "nws", severity,
                ))
        else:
            badges.append(_badge(
                "weather_alert", f"Severe weather{' nearby' if nearby else ''}: {top['event']}",
                f"NWS {_alert_phrase(top, now)}{where}{extra}.", top["source"] or "nws", "low",
            ))
    if NEW_CONSTRUCTION in services:
        delays = [a for a in alerts if a["active"] and a["family"] in DELAY_HAZARDS and (
            a["family"] != "flood" or (a["onset"] and a["end"] and a["end"] - a["onset"] >= EXTENDED_ALERT))]
        if delays:
            d = delays[0]
            badges.append(_badge(
                "weather_delays", "Weather delays likely",
                f"NWS {_alert_phrase(d, now)}: new-construction schedules likely slip -- confirm delivery "
                "dates rather than push new orders.", d["source"] or "nws", "medium",
            ))

    # --- storm history --------------------------------------------------------------
    for s in signals:
        if s.get("kind") != "storm_history":
            continue
        p = s.get("payload") or {}
        cutoff = (now - RECENT_STORM).date().isoformat()
        recent = [e for e in p.get("recent_events") or []
                  if (e.get("date") or "") >= cutoff and e.get("kind") in ROOF_STORM_KINDS]
        reports = sum(int(e.get("report_count") or 1) for e in recent)
        if not recent or (reports < 2 and not any(_significant(e) for e in recent)):
            continue  # one lone report (a tree down) is not a roofing event
        last = max(recent, key=lambda e: (e.get("date") or "", e.get("valid") or ""))
        capped = "+" if len(recent) >= len(p.get("recent_events") or []) and len(recent) >= 10 else ""
        where = f" at {last['location']}" if last.get("location") else ""
        badges.append(_badge(
            "recent_storm", "Recent storm activity",
            f"{reports}{capped} roof-relevant storm report{'s' if reports != 1 else ''} in this county in the last "
            f"30 days; latest {last.get('date')} {last.get('event_type') or last.get('kind')}{where} "
            f"({'NWS storm report' if last.get('source') == 'lsr' else 'NOAA Storm Events'}).",
            s.get("source") or "noaa_storm_events",
            "medium" if storm_roofer else "low",
        ))
        break

    # --- calendar ----------------------------------------------------------------
    if _state(lead) in SEASON_STATES:
        label, reason = _season(now.month)
        badges.append(_badge("season", label, reason, "calendar", "info"))

    badges.sort(key=lambda b: SEVERITY_RANK.get(b["severity"], 9))
    return badges
