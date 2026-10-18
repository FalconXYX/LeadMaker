"""Timing badges: *when* to call a lead, from county weather and the calendar.

Pure function, no I/O and no LLM: `timing_badges(lead, signals, now)` where `lead` is a
lead record (repo.lead_records shape: state, county_fips, tags, enrichment) and
`signals` are `regional_signals` rows for the lead's county (rows for other counties
are ignored). Every badge is {key, label, reason, source, severity}; severity is one
of high | medium | low | info.

Rules (docs/sales-domain-research.md: storms drive *timing*, not fit)
  storm_response  storm / emergency / repair / insurance roofers, when a roof-damaging NWS
                  alert (wind, thunderstorm, tornado, tropical; winter and coastal only at warning
                  level) is active in their county or ended <= 7 days ago. Warnings -> high,
                  watches/advisories -> medium. A watch only counts while active: one that ended
                  without a warning means the storm did not materialise in that county.
  weather_alert   the same alerts for every other lead (low: context, not a call trigger).
  recent_storm    storm history shows a roof-relevant event (wind, hail, tornado, tropical,
                  winter; not floods) in the county in the last 30 days.
  weather_delays  new-construction contractors while an extended precipitation / winter /
                  cold alert is in effect (jobs slip; shingles need ~50 F to seal).
  season          NY/NJ calendar note: Q1 planning and credit push, Apr-Nov in season,
                  Nov-Dec pre-buy and next-year planning.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

ALERT_LOOKBACK = timedelta(days=7)
RECENT_STORM = timedelta(days=30)
EXTENDED_ALERT = timedelta(hours=12)  # flood watches/warnings this long count as "extended" precipitation

# Service keys (tagging.taxonomy SERVICE_LABELS) that make a roofer storm-responsive.
STORM_ROOFER_SERVICES = {"storm_damage", "insurance_claims", "emergency_service", "roof_repair"}
STORM_TAG_SERVICES = {"storm_damage", "insurance_claims", "emergency_service"}  # taxonomy.STORM_SERVICES
NEW_CONSTRUCTION = "new_construction"
ROOF_DAMAGE_HAZARDS = {"tornado", "tropical", "thunderstorm", "wind", "winter", "coastal"}
# Winter Weather / Coastal Flood Advisories (a few inches of snow, minor tidal flooding) are routine
# and do not damage roofs; for these families only warnings are a storm-response trigger.
WARNING_ONLY_HAZARDS = {"winter", "coastal"}
DELAY_HAZARDS = {"winter", "cold", "flood"}
ROOF_STORM_KINDS = {"wind", "hail", "tornado", "tropical", "winter"}  # storm-history kinds (floods excluded)
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
                    "source": s.get("source")})
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
    roof = [a for a in alerts if _roof_damaging(a)]
    if roof:
        top = roof[0]
        others = sorted({a["event"] for a in roof[1:] if a["event"] != top["event"]})
        extra = f"; also {', '.join(others)}" if others else ""
        if storm_roofer:
            listed = ", ".join(sorted(services & STORM_ROOFER_SERVICES)).replace("_", " ")
            badges.append(_badge(
                "storm_response",
                f"Storm response: {top['event']}" + ("" if top["active"] else " (recent)"),
                f"NWS {_alert_phrase(top, now)} in this county{extra}. Lists {listed}: expect repair and "
                "claim work -- lead with stock and fast delivery.",
                top["source"] or "nws",
                "high" if top["level"] == "warning" else "medium",
            ))
        else:
            badges.append(_badge(
                "weather_alert", f"Severe weather: {top['event']}",
                f"NWS {_alert_phrase(top, now)} in this county{extra}.", top["source"] or "nws", "low",
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
        if not recent:
            continue
        last = recent[0]
        n = len(recent)
        capped = "+" if n >= len(p.get("recent_events") or []) and n >= 10 else ""
        where = f" at {last['location']}" if last.get("location") else ""
        badges.append(_badge(
            "recent_storm", "Recent storm activity",
            f"{n}{capped} roof-relevant storm report{'s' if n != 1 else ''} in this county in the last 30 days; "
            f"latest {last.get('date')} {last.get('event_type') or last.get('kind')}{where} "
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
