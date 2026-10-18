"""NWS watches, warnings and advisories per county (api.weather.gov, keyless).

Endpoints (https://www.weather.gov/documentation/services-web-api):
  /alerts/active?zone=NJC003,NYC059,...   what is in effect right now
  /alerts?zone=...&start=<7 days ago>     recent history, so "ended <= 7 days ago" rules
                                          work from the first run (the API keeps ~7 days)
County zones are `<STATE>C<3-digit county FIPS>` (Bergen NJ = NJC003). The API also
matches forecast-zone products (Winter Storm Warning on NJZ103/NJZ104) to the county
zone, and each alert lists the counties it covers as SAME codes ("034003"), which is
what we key rows on. NWS asks for an identifying User-Agent: settings.user_agent_contact
(LEADMAKER_CONTACT env); there is no published rate limit, we keep 1 s between requests.
api.weather.gov's robots.txt disallows crawling; this is the documented programmatic
API (no page crawling), queried a handful of times per run.

Message lifecycle: an `Update` replaces the alerts it references (per county) and a
`Cancel` ends them at its send time. Alerts that vanish from /alerts/active before
their end time are closed at fetch time. Ended alerts are kept RETENTION_DAYS.
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, update

from ..config import Settings
from ..db import Repository
from ..db.schema import regional_signals as rs
from ..http import HttpClient
from . import store
from .counties import STATE_FIPS

log = logging.getLogger(__name__)

HOST = "api.weather.gov"
ACTIVE_URL = f"https://{HOST}/alerts/active"
HISTORY_URL = f"https://{HOST}/alerts"
SOURCE = "nws"
KIND = "active_alert"
ZONES_PER_REQUEST = 25
HISTORY_DAYS = 7
HISTORY_PAGE = 500
MAX_PAGES = 5
RETENTION_DAYS = 30
INSTRUCTION_MAX = 280


def county_zone(county_fips: str) -> str:
    """'34003' -> 'NJC003' (NWS county zone id)."""
    return f"{STATE_FIPS[county_fips[:2]]}C{county_fips[2:]}"


def parse_time(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _headers(settings: Settings) -> dict[str, str]:
    return {"User-Agent": settings.user_agent_contact, "Accept": "application/geo+json"}


def _short(text: str | None, n: int = INSTRUCTION_MAX) -> str | None:
    if not text:
        return None
    t = " ".join(text.split())
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


async def fetch_alerts(
    http: HttpClient, settings: Settings, county_fips: list[str], *, history: bool = True,
    now: datetime | None = None,
) -> tuple[list[dict[str, Any]], set[str]]:
    """(features, ids active right now) for the counties' zones; history adds the last HISTORY_DAYS."""
    now = now or datetime.now(timezone.utc)
    http.set_host_interval(HOST, 1.0)
    zones = sorted({county_zone(f) for f in county_fips if f[:2] in STATE_FIPS})
    features: dict[str, dict[str, Any]] = {}
    active: set[str] = set()
    for i in range(0, len(zones), ZONES_PER_REQUEST):
        zone_param = ",".join(zones[i : i + ZONES_PER_REQUEST])
        if history:
            start = (now - timedelta(days=HISTORY_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
            url: str | None = HISTORY_URL
            params: dict[str, Any] | None = {"zone": zone_param, "start": start, "status": "actual",
                                             "limit": HISTORY_PAGE}
            for _ in range(MAX_PAGES):
                assert url is not None
                page = (await http.get(url, params=params, headers=_headers(settings))).json()
                batch = page.get("features") or []
                features.update((f["properties"]["id"], f) for f in batch if f.get("properties"))
                url = (page.get("pagination") or {}).get("next")
                params = None  # the cursor URL carries the query
                if not url or len(batch) < HISTORY_PAGE:
                    break
        page = (await http.get(ACTIVE_URL, params={"zone": zone_param}, headers=_headers(settings))).json()
        for f in page.get("features") or []:
            if f.get("properties"):
                features[f["properties"]["id"]] = f  # the active copy wins
                active.add(f["properties"]["id"])
    return list(features.values()), active


def _counties_of(p: dict[str, Any], wanted: set[str]) -> list[str]:
    same = (p.get("geocode") or {}).get("SAME") or []
    return sorted({s[-5:] for s in same if len(s) == 6 and s[-5:] in wanted})


def alert_rows(
    features: list[dict[str, Any]], county_fips: set[str], fetched_at: datetime
) -> tuple[list[dict[str, Any]], set[tuple[str, str]], dict[tuple[str, str], datetime]]:
    """Map NWS features to regional_signals rows.

    Returns (rows, superseded {(alert_id, county)}, cancelled {(alert_id, county): ended_at}).
    Superseded/cancelled pairs also apply to rows stored by earlier runs.
    """
    superseded: set[tuple[str, str]] = set()
    cancelled: dict[tuple[str, str], datetime] = {}
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    props = sorted((f["properties"] for f in features if f.get("properties")), key=lambda p: p.get("sent") or "")
    for p in props:
        if (p.get("status") or "Actual") != "Actual":  # Test / Exercise / Draft
            continue
        counties = _counties_of(p, county_fips)
        if not counties:
            continue
        mtype = p.get("messageType") or "Alert"
        refs = [r.get("identifier") for r in p.get("references") or [] if r.get("identifier")]
        if mtype == "Cancel":
            ended = parse_time(p.get("sent")) or fetched_at
            for ref in refs:
                for c in counties:
                    cancelled[(ref, c)] = ended
            continue
        if mtype == "Update":
            superseded.update((ref, c) for ref in refs for c in counties)
        start = parse_time(p.get("effective")) or parse_time(p.get("sent"))
        end = parse_time(p.get("ends")) or parse_time(p.get("expires"))
        payload = {
            "event": p.get("event"),
            "severity": p.get("severity"),
            "urgency": p.get("urgency"),
            "certainty": p.get("certainty"),
            "headline": p.get("headline"),
            "areaDesc": p.get("areaDesc"),
            "instruction": _short(p.get("instruction")),
            "onset": p.get("onset"),
            "ends": p.get("ends"),
            "expires": p.get("expires"),
            "message_type": mtype,
            "sender_name": p.get("senderName"),
            "url": p.get("@id"),
        }
        for c in counties:
            rows[(p["id"], c)] = {
                "county_fips": c, "kind": KIND, "source": SOURCE, "external_id": p["id"], "payload": payload,
                "valid_from": start, "valid_to": end, "fetched_at": fetched_at,
            }
    out = []
    for key, r in rows.items():
        if key in superseded:
            continue
        if key in cancelled and (r["valid_to"] is None or cancelled[key] < r["valid_to"]):
            r["valid_to"] = cancelled[key]
            r["payload"] = {**r["payload"], "cancelled_at": cancelled[key].isoformat()}
        out.append(r)
    return out, superseded, cancelled


def _apply_lifecycle(
    repo: Repository, superseded: set[tuple[str, str]], cancelled: dict[tuple[str, str], datetime]
) -> tuple[int, int]:
    """Apply Update/Cancel messages to rows stored by earlier runs."""
    deleted = ended = 0
    with repo.engine.begin() as conn:
        for ref, c in sorted(superseded):
            deleted += conn.execute(delete(rs).where(
                rs.c.source == SOURCE, rs.c.external_id == ref, rs.c.county_fips == c)).rowcount or 0
        for (ref, c), at in sorted(cancelled.items()):
            at = store.to_utc(at)
            ended += conn.execute(update(rs).where(
                rs.c.source == SOURCE, rs.c.external_id == ref, rs.c.county_fips == c,
                (rs.c.valid_to.is_(None)) | (rs.c.valid_to > at)).values(valid_to=at)).rowcount or 0
    return deleted, ended


async def refresh_alerts(
    http: HttpClient, settings: Settings, repo: Repository, county_fips: list[str], *,
    now: datetime | None = None, history: bool = True,
) -> dict[str, Any]:
    """Fetch, store and expire NWS alerts for these counties. Returns stats."""
    now = now or datetime.now(timezone.utc)
    wanted = {f for f in county_fips if f}
    if not wanted:
        return {"counties": 0, "features": 0}
    features, active_ids = await fetch_alerts(http, settings, sorted(wanted), history=history, now=now)
    rows, superseded, cancelled = alert_rows(features, wanted, now)
    deleted, cancelled_n = _apply_lifecycle(repo, superseded, cancelled)
    written = store.upsert_signals(repo, rows)
    closed = store.end_missing(repo, KIND, SOURCE, sorted(wanted), active_ids, now)
    purged = store.purge_ended(repo, KIND, now - timedelta(days=RETENTION_DAYS), SOURCE)
    active = {r["external_id"]: r["payload"]["event"] for r in rows if r["external_id"] in active_ids}
    return {
        "counties": len(wanted),
        "features": len(features),
        "active_alerts": len(active),
        "active_by_event": dict(Counter(active.values())),
        "rows_written": written,
        "superseded_deleted": deleted,
        "cancelled": cancelled_n,
        "closed_missing": closed,
        "purged": purged,
    }
