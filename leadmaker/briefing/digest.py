"""The territory digest: what changed in a scope's book of leads, from stored data only (no network, no LLM).

Scopes: 'team' (every allocated lead) and 'rep:<user id>' (leads allocated to that rep). The digest is built
with SQLAlchemy Core, so it runs on SQLite (tests, local) and Postgres (the stack):

  poll     the newest complete GAF poll (scrape_runs kind 'gaf_ingest' with stats.poll) when it finished within
           LEADMAKER_BRIEFING_POLL_WINDOW_DAYS: new / changed / delisted counts within the book and up to 3
           highlights from that run's audit_events (tier up, new certification, new lead, rating jump, website
           found, delisted).
  pool     unallocated leads first seen in that poll.
  weather  NWS alerts active now in the book's counties (roofing-relevant hazard families only), and the
           timing layer's storm_response / weather_delays badges for book leads in counties with an alert
           active now or ended <= 7 days ago (leadmaker.signals.timing, read-only: weather never triggers an
           LLM call); plus (v2) recent_storm: storm-restoration roofers in counties where NOAA storm reports
           show a roof-damaging event in the last 30 days (the timing layer's recent_storm badge at medium,
           which it gives storm roofers only), so an ordinary week after a storm is not "quiet".

digest_hash is the sha256 of the canonical JSON without "as_of", so recomputing an unchanged digest keeps its
hash and its cached AI rewrite. Volatile values are kept out on purpose: a storm-response reason is the
badge's event label, not its "ended 2 days ago" phrase.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.engine import Connection

from ..db import Repository
from ..db.schema import (
    audit_events, companies, enrichments, field_overrides, regional_signals, scrape_runs, users,
)
from ..signals.timing import ALERT_LOOKBACK, alert_level, hazard_family
from .config import BriefingConfig
from .text import fence_line, iso, parse_dt, render

DIGEST_VERSION = 2
TEAM = "team"
REP_PREFIX = "rep:"
_REP_SCOPE = re.compile(r"^rep:[0-9a-f-]{36}$")

MAX_HIGHLIGHTS = 3
MAX_ALERTS = 3
MAX_STORM_LEADS = 5
NAME_CHARS = 120
EVENT_CHARS = 80
RATING_JUMP = 0.3
FAR_FUTURE_ONSET = timedelta(days=2)  # a watch for the day after tomorrow is not news yet (as timing does)
POLL_SCAN = 50  # newest gaf_ingest runs inspected for the latest complete poll

HIGHLIGHT_ORDER = ("tier_up", "new_certification", "new_lead", "rating_jump", "website_found", "delisted")
LEVEL_RANK = {"warning": 0, "watch": 1, "advisory": 2}
TIER_RANK = {"master_elite": 3, "certified_plus": 2, "certified": 1, "none": 0}
TIER_LABELS = {"master_elite": "GAF Master Elite", "certified_plus": "GAF Certified Plus",
               "certified": "GAF Certified", "none": "not GAF certified"}
SEVERITY_RANK = {"high": 0, "medium": 1}
# FIPS -> "Bergen County, NJ" tables, first found wins: the copy inside the Python package (ships in the worker
# image), then the shared one in a repo checkout.
COUNTY_NAME_FILES = (
    Path(__file__).resolve().parents[1] / "insights" / "county_names.tsv",
    Path(__file__).resolve().parents[2] / "packages" / "shared" / "data" / "county-names.tsv",
)


# ------------------------------------------------------------------------------------------------ scopes
def rep_scope(user_id: str) -> str:
    return f"{REP_PREFIX}{uuid.UUID(str(user_id))}"


def parse_scope(scope: str) -> tuple[str, str | None]:
    """'team' -> ('team', None); 'rep:<uuid>' -> ('rep', '<uuid>'); anything else raises ValueError."""
    s = (scope or "").strip().lower()
    if s == TEAM:
        return TEAM, None
    if s.startswith(REP_PREFIX):
        try:
            return "rep", str(uuid.UUID(s[len(REP_PREFIX):]))
        except ValueError:
            pass
    raise ValueError(f"invalid briefing scope {scope!r}: expected 'team' or 'rep:<user id>'")


def rep_ids(repo: Repository) -> list[str]:
    with repo.engine.connect() as conn:
        return sorted(str(r) for r in conn.execute(select(users.c.id).where(users.c.role == "rep")).scalars())


def all_scopes(repo: Repository) -> list[str]:
    """'team' plus one 'rep:<id>' per users.role = 'rep'."""
    return [TEAM, *(rep_scope(r) for r in rep_ids(repo))]


def _book(kind: str, rep_id: str | None):
    return companies.c.assigned_rep_id == rep_id if kind == "rep" else companies.c.assigned_rep_id.is_not(None)


# ------------------------------------------------------------------------------------------------ hashing
def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def digest_hash(digest: dict[str, Any]) -> str:
    """sha256 of the canonical JSON of the digest without "as_of"."""
    body = {k: v for k, v in digest.items() if k != "as_of"}
    return hashlib.sha256(canonical_json(body).encode()).hexdigest()


# ---------------------------------------------------------------------------------------------- counties
@lru_cache(maxsize=1)
def _county_table() -> dict[str, str]:
    """FIPS -> 'Bergen County, NJ' from the first COUNTY_NAME_FILES table found, else the cached Census
    relationship file the counties step downloads, else nothing (the text then shows the FIPS code)."""
    for path in COUNTY_NAME_FILES:
        names: dict[str, str] = {}
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if line and not line.startswith("#") and "\t" in line:
                    code, name = line.split("\t", 1)
                    names[code.strip()] = name.strip()
        except OSError:
            continue
        if names:
            return names
    try:
        from ..signals.counties import load_cached_county_index, state_for_fips

        index = load_cached_county_index()
        return {f: f"{n}, {state_for_fips(f)}" if state_for_fips(f) else n for f, n in index.names.items()}
    except Exception:  # no cache yet: names fall back to the FIPS code
        return {}


def county_label(fips: str | None) -> str | None:
    return _county_table().get(fips or "") if fips else None


# ------------------------------------------------------------------------------------------------- reads
def _names(conn: Connection, ids: list[str]) -> dict[str, str]:
    """Effective business names: an active business_name override wins over the scraped name."""
    out: dict[str, str] = {}
    if not ids:
        return out
    for part in (ids[i : i + 500] for i in range(0, len(ids), 500)):
        for r in conn.execute(select(companies.c.id, companies.c.business_name).where(companies.c.id.in_(part))):
            out[str(r.id)] = r.business_name
        for r in conn.execute(
            select(field_overrides.c.company_id, field_overrides.c.value, field_overrides.c.created_at)
            .where(field_overrides.c.company_id.in_(part), field_overrides.c.contact_id.is_(None),
                   field_overrides.c.field == "business_name", field_overrides.c.superseded_at.is_(None))
            .order_by(field_overrides.c.created_at)
        ):
            if isinstance(r.value, str) and r.value.strip():
                out[str(r.company_id)] = r.value
    return {k: fence_line(v, NAME_CHARS) for k, v in out.items()}


def latest_poll(conn: Connection) -> dict[str, Any] | None:
    """The newest complete GAF poll: a gaf_ingest run that succeeded or was partial and whose stats carry
    'poll' (finish_run sets it only for a complete area read)."""
    rows = conn.execute(
        select(scrape_runs.c.id, scrape_runs.c.started_at, scrape_runs.c.finished_at, scrape_runs.c.stats)
        .where(scrape_runs.c.kind == "gaf_ingest", scrape_runs.c.status.in_(["succeeded", "partial"]),
               scrape_runs.c.finished_at.is_not(None))
        .order_by(scrape_runs.c.id.desc()).limit(POLL_SCAN)
    )
    for r in rows:
        stats = r.stats if isinstance(r.stats, dict) else {}
        if "poll" in stats:
            return {"run_id": int(r.id), "started_at": parse_dt(r.started_at), "finished_at": parse_dt(r.finished_at)}
    return None


def _num(x: float) -> str:
    return f"{x:.1f}".rstrip("0").rstrip(".") if x != int(x) else str(int(x))


def _classify(entity_type: str, action: str, changes: Any, tier: str | None) -> tuple[str, str] | None:
    """(kind, text) of one audit event, or None when it is not highlight material. text follows "<Name> is"."""
    changes = changes if isinstance(changes, dict) else {}
    if action == "delisted":
        return "delisted", "no longer listed by GAF"
    if entity_type != "company":
        return None
    if action == "created":
        label = TIER_LABELS.get(tier or "")
        return "new_lead", f"a new {label} listing" if label and tier != "none" else "a new listing"
    if action != "updated":
        return None
    old_new = changes.get("tier")
    if isinstance(old_new, list) and len(old_new) == 2:
        old, new = (str(v or "none") for v in old_new)
        if TIER_RANK.get(new, 0) > TIER_RANK.get(old, 0):
            return "tier_up", f"now {TIER_LABELS.get(new, new)} (was {TIER_LABELS.get(old, old)})"
    certs = changes.get("certifications")
    if isinstance(certs, list) and len(certs) == 2:
        before = set(certs[0] or []) if isinstance(certs[0], list) else set()
        added = [c for c in (certs[1] or []) if c not in before] if isinstance(certs[1], list) else []
        if added:
            return "new_certification", f"now listed with {fence_line(added[0], 60)}"
    rating = changes.get("rating")
    if isinstance(rating, list) and len(rating) == 2 and all(isinstance(v, (int, float)) for v in rating):
        old_r, new_r = float(rating[0]), float(rating[1])
        if abs(new_r - old_r) >= RATING_JUMP - 1e-9:
            return "rating_jump", f"now rated {_num(new_r)} (was {_num(old_r)})"
    website = changes.get("website")
    if isinstance(website, list) and len(website) == 2 and not website[0] and website[1]:
        return "website_found", "newly matched to a website"
    return None


def _poll_part(conn: Connection, book, poll: dict[str, Any] | None, fresh: bool) -> tuple[dict[str, Any], int]:
    """(digest['poll'], pool.new)."""
    empty = {"run_id": poll["run_id"] if poll else None, "finished_at": iso(poll["finished_at"]) if poll else None,
             "fresh": fresh, "new": 0, "changed": 0, "delisted": 0, "highlights": []}
    if poll is None or not fresh:
        return empty, 0
    run_id, started = poll["run_id"], poll["started_at"]
    new = conn.execute(select(func.count()).select_from(companies)
                       .where(book, companies.c.first_seen_at >= started)).scalar() or 0
    changed = conn.execute(select(func.count()).select_from(companies).where(
        book, companies.c.updated_in_last_poll.is_(True), companies.c.first_seen_at < started)).scalar() or 0
    book_ids = select(companies.c.id).where(book)
    delisted = conn.execute(
        select(func.count(func.distinct(audit_events.c.company_id)))
        .where(audit_events.c.run_id == run_id, audit_events.c.action == "delisted",
               audit_events.c.company_id.in_(book_ids))
    ).scalar() or 0
    pool = conn.execute(select(func.count()).select_from(companies).where(
        companies.c.assigned_rep_id.is_(None), companies.c.first_seen_at >= started)).scalar() or 0

    events = conn.execute(
        select(audit_events.c.id, audit_events.c.company_id, audit_events.c.entity_type, audit_events.c.action,
               audit_events.c.changes)
        .where(audit_events.c.run_id == run_id, audit_events.c.company_id.is_not(None),
               audit_events.c.company_id.in_(book_ids))
        .order_by(audit_events.c.id)
    ).all()
    ids = sorted({str(e.company_id) for e in events})
    info: dict[str, Any] = {}
    for part in (ids[i : i + 500] for i in range(0, len(ids), 500)):
        for r in conn.execute(select(companies.c.id, companies.c.tier, companies.c.priority_score)
                              .where(companies.c.id.in_(part))):
            info[str(r.id)] = r
    best: dict[str, tuple[int, str]] = {}  # company -> (kind rank, text)
    for e in events:
        cid = str(e.company_id)
        row = info.get(cid)
        found = _classify(e.entity_type, e.action, e.changes, row.tier if row is not None else None)
        if found is None:
            continue
        rank = HIGHLIGHT_ORDER.index(found[0])
        if cid not in best or rank < best[cid][0]:
            best[cid] = (rank, found[1])
    names = _names(conn, sorted(best))

    def prio(cid: str) -> float:
        p = info[cid].priority_score if cid in info else None
        return float(p) if p is not None else -1.0

    ranked = sorted(best, key=lambda c: (best[c][0], -prio(c), (names.get(c) or "").lower(), c))
    highlights = [{"company_id": c, "name": names.get(c) or "", "kind": HIGHLIGHT_ORDER[best[c][0]],
                   "text": best[c][1]} for c in ranked[:MAX_HIGHLIGHTS] if names.get(c)]
    return {**empty, "new": int(new), "changed": int(changed), "delisted": int(delisted),
            "highlights": highlights}, int(pool)


def _active(now: datetime):
    return and_(
        or_(regional_signals.c.valid_from.is_(None), regional_signals.c.valid_from <= now),
        or_(regional_signals.c.valid_to.is_(None), regional_signals.c.valid_to > now),
    )


def _alerts(conn: Connection, counties: dict[str, int], now: datetime) -> list[dict[str, Any]]:
    """Roofing-relevant NWS alerts active now in the book's counties, one per (county, event): the latest end."""
    if not counties:
        return []
    rows = conn.execute(
        select(regional_signals.c.external_id, regional_signals.c.county_fips, regional_signals.c.payload,
               regional_signals.c.valid_to)
        .where(regional_signals.c.kind == "active_alert", regional_signals.c.county_fips.in_(sorted(counties)),
               _active(now))
    ).all()
    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        p = r.payload if isinstance(r.payload, dict) else {}
        event = fence_line(p.get("event"), EVENT_CHARS)
        if not event or hazard_family(event) is None:
            continue  # statements, frost, air quality...: not roofing news
        onset = parse_dt(p.get("onset"))
        if onset is not None and onset > now + FAR_FUTURE_ONSET:
            continue
        end = parse_dt(r.valid_to)
        alert = {"id": str(r.external_id), "county_fips": r.county_fips, "county": county_label(r.county_fips),
                 "event": event, "level": alert_level(event), "ends_at": iso(end), "leads": counties[r.county_fips]}
        key = (r.county_fips, event)
        prev = by_key.get(key)
        far = "9999"
        if prev is None or ((alert["ends_at"] or far), alert["id"]) > ((prev["ends_at"] or far), prev["id"]):
            by_key[key] = alert
    return sorted(by_key.values(), key=lambda a: (LEVEL_RANK.get(a["level"], 9), -a["leads"], a["county_fips"],
                                                  a["event"], a["id"]))


def _alert_counties_recent(conn: Connection, counties: dict[str, int], now: datetime) -> list[str]:
    """Book counties with an alert active now or ended within the timing layer's 7-day lookback."""
    if not counties:
        return []
    return sorted(set(conn.execute(
        select(regional_signals.c.county_fips).where(
            regional_signals.c.kind == "active_alert", regional_signals.c.county_fips.in_(sorted(counties)),
            or_(regional_signals.c.valid_to.is_(None), regional_signals.c.valid_to >= now - ALERT_LOOKBACK),
        ).distinct()
    ).scalars()))


def _timing_leads(conn: Connection, book, counties: list[str]) -> list[dict[str, Any]]:
    """Book leads in these counties, shaped as timing.timing_badges reads them."""
    if not counties:
        return []
    leads = [
        {"company_id": str(r.id), "business_name": r.business_name, "state": r.state, "county_fips": r.county_fips,
         "latitude": r.latitude, "longitude": r.longitude, "tags": r.system_tags or [],
         "priority_score": r.priority_score, "enrichment": {}}
        for r in conn.execute(
            select(companies.c.id, companies.c.business_name, companies.c.state, companies.c.county_fips,
                   companies.c.latitude, companies.c.longitude, companies.c.system_tags, companies.c.priority_score)
            .where(book, companies.c.county_fips.in_(counties))
        )
    ]
    by_id = {l["company_id"]: l for l in leads}
    ids = sorted(by_id)
    for part in (ids[i : i + 500] for i in range(0, len(ids), 500)):
        for r in conn.execute(
            select(enrichments.c.company_id, enrichments.c.source, enrichments.c.status,
                   enrichments.c.data["services"].label("services"))
            .where(enrichments.c.company_id.in_(part), enrichments.c.source.in_(["website_crawl", "llm_extract"]))
        ):
            services = r.services if isinstance(r.services, list) else []
            by_id[str(r.company_id)]["enrichment"][r.source] = {"status": r.status, "data": {"services": services}}
    return leads


def _weather_part(repo: Repository, conn: Connection, book, counties: dict[str, int], now: datetime) -> dict[str, Any]:
    from ..pipeline.signals import lead_timing_badges  # local import: keeps `leadmaker briefing --help` light

    alerts = _alerts(conn, counties, now)
    alert_fips = {a["county_fips"] for a in alerts}
    leads = _timing_leads(conn, book, _alert_counties_recent(conn, counties, now))
    badges = lead_timing_badges(repo, leads, now) if leads else {}
    storm: list[dict[str, Any]] = []
    delays = 0
    for lead in leads:
        bs = badges.get(lead["company_id"]) or []
        sr = next((b for b in bs if b.get("key") == "storm_response" and b.get("severity") in SEVERITY_RANK), None)
        if sr is not None:
            label = str(sr.get("label") or "")
            storm.append({"company_id": lead["company_id"], "severity": sr["severity"],
                          "reason": fence_line(label.split(": ", 1)[-1], 120),
                          "_county": lead["county_fips"], "_priority": lead["priority_score"]})
        if any(b.get("key") == "weather_delays" for b in bs):
            delays += 1
    names = _names(conn, [s["company_id"] for s in storm])
    storm.sort(key=lambda s: (SEVERITY_RANK[s["severity"]], -(s["_priority"] if s["_priority"] is not None else -1),
                              (names.get(s["company_id"]) or "").lower(), s["company_id"]))
    alert_storm = sum(1 for s in storm if s["_county"] in alert_fips)
    listed = [{"company_id": s["company_id"], "name": names.get(s["company_id"]) or "", "severity": s["severity"],
               "reason": s["reason"]} for s in storm[:MAX_STORM_LEADS]]
    return {"alerts": alerts[:MAX_ALERTS], "alert_counties": len(alert_fips), "alert_storm_leads": alert_storm,
            "storm_response": listed, "storm_response_total": len(storm), "weather_delays_total": delays,
            "recent_storm": _recent_storm_part(repo, conn, book, counties, now, {s["company_id"] for s in storm})}


def _recent_storm_part(repo: Repository, conn: Connection, book, counties: dict[str, int], now: datetime,
                       exclude: set[str]) -> dict[str, Any]:
    """Storm-restoration roofers in the book whose county had roof-damaging storm reports in the last 30 days (the
    timing layer's recent_storm badge, which is medium only for storm roofers), not counting leads that already
    have a storm-response badge. Counties by count (desc), then name."""
    from ..pipeline.signals import lead_timing_badges  # local import, as in _weather_part

    leads = [l for l in _timing_leads(conn, book, sorted(counties)) if l["company_id"] not in exclude]
    badges = lead_timing_badges(repo, leads, now) if leads else {}
    per_county: dict[str, int] = {}
    total = 0
    for lead in leads:
        if any(b.get("key") == "recent_storm" and b.get("severity") == "medium"
               for b in badges.get(lead["company_id"]) or []):
            total += 1
            per_county[lead["county_fips"]] = per_county.get(lead["county_fips"], 0) + 1
    order = sorted(per_county, key=lambda f: (-per_county[f], county_label(f) or f))
    return {"leads": total, "counties": [county_label(f) or f"county {f}" for f in order[:MAX_ALERTS]],
            "county_count": len(per_county)}


# ------------------------------------------------------------------------------------------------ digest
def compute_digest(repo: Repository, scope: str, now: datetime, *, config: BriefingConfig | None = None) -> dict:
    """The deterministic digest for one scope (spec §5.2), including its rendered text's named companies."""
    config = config or BriefingConfig.from_env()
    now = (now if now.tzinfo else now.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    kind, rep_id = parse_scope(scope)
    scope = TEAM if kind == TEAM else f"{REP_PREFIX}{rep_id}"
    book = _book(kind, rep_id)
    with repo.engine.connect() as conn:
        size = conn.execute(select(func.count()).select_from(companies).where(book)).scalar() or 0
        counties = {str(f): int(n) for f, n in conn.execute(
            select(companies.c.county_fips, func.count()).where(book, companies.c.county_fips.is_not(None))
            .group_by(companies.c.county_fips)).all()}
        poll = latest_poll(conn)
        fresh = bool(poll and poll["finished_at"]
                     and poll["finished_at"] >= now - timedelta(days=config.poll_window_days))
        poll_part, pool_new = _poll_part(conn, book, poll, fresh)
        weather = _weather_part(repo, conn, book, counties, now)
    digest: dict[str, Any] = {
        "v": DIGEST_VERSION, "scope": scope, "as_of": iso(now), "book": {"leads": int(size)},
        "poll": poll_part, "pool": {"new": pool_new}, "weather": weather, "leads": [],
    }
    changes = poll_part["new"] + poll_part["changed"] + poll_part["delisted"]
    digest["quiet"] = not (changes or weather["alerts"] or weather["storm_response_total"] or pool_new
                           or (weather.get("recent_storm") or {}).get("leads"))
    digest["leads"] = render(digest)[1]
    return digest


def is_quiet(digest: dict[str, Any]) -> bool:
    return bool(digest.get("quiet"))


def digest_company_ids(digest: dict[str, Any]) -> set[str]:
    """Every company id the digest mentions (what an AI rewrite may cite)."""
    ids = {str(h.get("company_id")) for h in (digest.get("poll") or {}).get("highlights") or []}
    ids |= {str(s.get("company_id")) for s in (digest.get("weather") or {}).get("storm_response") or []}
    ids |= {str(l.get("id")) for l in digest.get("leads") or []}
    return {i for i in ids if i and i != "None"}


def valid_scope(scope: str) -> bool:
    return scope == TEAM or bool(_REP_SCOPE.match(scope))
