"""Helpers shared by the territory briefing tests (SQLite and Postgres). No tests here.

The scenario (`seed_scenario`) at NOW = Monday 2026-10-19 13:00 ET:

  rep A   Alpha Roofing    Bergen (34003)  storm-damage roofer, tier certified -> master_elite in the poll, changed
          Beta Exteriors   Bergen (34003)  rating 4.1 -> 4.6 in the poll (not flagged changed)
  rep B   Gamma Builders   Essex  (34013)  new-construction builder
  pool    Delta Roofing    Essex  (34013)  first seen in the poll (new, unallocated)
          Echo Roofing     Bergen (34003)  old, unallocated
  poll    a complete gaf_ingest run that finished Saturday 2026-10-17 13:05 ET
  alerts  Severe Thunderstorm Warning in Bergen until 8 PM ET; Winter Storm Warning in Essex until 8 PM ET;
          a Frost Advisory in Bergen (not roofing news)
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import insert, update

from leadmaker.db import Repository
from leadmaker.db.schema import audit_events, companies, regional_signals, scrape_runs, users
from leadmaker.llm.providers.fake import FakeProvider

from fakes import offline_settings

NOW = datetime(2026, 10, 19, 17, 0, tzinfo=timezone.utc)  # Monday 1 PM ET
POLL_STARTED = datetime(2026, 10, 17, 17, 0, tzinfo=timezone.utc)  # Saturday 1 PM ET
OLD = datetime(2026, 9, 1, tzinfo=timezone.utc)
ALERT_END = datetime(2026, 10, 20, 0, 0, tzinfo=timezone.utc)  # Monday 8 PM ET
BERGEN, ESSEX = "34003", "34013"


def settings(**kw: Any):
    """Offline settings: no keys, no network. llm_provider_setting 'auto' with no key = no provider."""
    return offline_settings(**kw)


def fake_settings(**kw: Any):
    return offline_settings(llm_provider_setting="fake", **kw)


def fake(script: list[Any] | None = None) -> FakeProvider:
    return FakeProvider(fake_settings(), script=script)


def tag(key: str, category: str = "services") -> dict[str, Any]:
    return {"key": key, "label": key.split(":")[-1].replace("_", " "), "category": category, "value": True}


def add_user(repo: Repository, name: str, role: str = "rep") -> str:
    uid = str(uuid.uuid4())
    with repo.engine.begin() as conn:
        conn.execute(insert(users).values(id=uid, name=name, email=f"{uid[:8]}@test.local", role=role))
    return uid


def add_company(repo: Repository, name: str, *, county: str, rep: str | None = None, first_seen: datetime = OLD,
                changed: bool = False, tier: str = "certified", priority: float | None = 50.0,
                tags: list[dict[str, Any]] | None = None, state: str = "NJ") -> str:
    cid = str(uuid.uuid4())
    with repo.engine.begin() as conn:
        conn.execute(insert(companies).values(
            id=cid, business_name=name, latitude=40.9, longitude=-74.1, county_fips=county, state=state,
            content_hash=cid[:16], tier=tier, assigned_rep_id=rep, priority_score=priority,
            system_tags=tags or [], updated_in_last_poll=changed, first_seen_at=first_seen, last_seen_at=first_seen,
            listing_updated_at=first_seen, updated_at=first_seen,
        ))
    return cid


def add_poll(repo: Repository, *, started: datetime = POLL_STARTED, minutes: float = 5,
             complete: bool = True, status: str = "succeeded") -> int:
    stats: dict[str, Any] = {"poll": {"flipped": 1}} if complete else {}
    with repo.engine.begin() as conn:
        res = conn.execute(insert(scrape_runs).values(
            kind="gaf_ingest", status=status, params={}, stats=stats, started_at=started,
            finished_at=started + timedelta(minutes=minutes)))
        return int(res.inserted_primary_key[0])


def add_audit(repo: Repository, run_id: int, company_id: str, action: str, changes: dict[str, Any],
              entity_type: str = "company") -> None:
    with repo.engine.begin() as conn:
        conn.execute(insert(audit_events).values(
            run_id=run_id, entity_type=entity_type, entity_id=company_id, company_id=company_id, action=action,
            changes=changes, at=POLL_STARTED + timedelta(minutes=1)))


def add_alert(repo: Repository, county: str, event: str, *, ext: str | None = None,
              start: datetime | None = None, end: datetime | None = ALERT_END) -> str:
    ext = ext or f"urn:oid:{uuid.uuid4().hex[:12]}"
    start = start or NOW - timedelta(hours=1)
    with repo.engine.begin() as conn:
        conn.execute(insert(regional_signals).values(
            id=str(uuid.uuid4()), county_fips=county, kind="active_alert", source="nws", external_id=ext,
            payload={"event": event, "onset": start.isoformat(), "areaDesc": county}, valid_from=start, valid_to=end,
            fetched_at=start))
    return ext


def assign(repo: Repository, company_id: str, rep: str | None) -> None:
    with repo.engine.begin() as conn:
        conn.execute(update(companies).where(companies.c.id == company_id).values(assigned_rep_id=rep))


def seed_scenario(repo: Repository) -> dict[str, Any]:
    """The module docstring's scenario; returns the ids."""
    rep_a, rep_b = add_user(repo, "Jordan Lee"), add_user(repo, "Priya Shah")
    manager = add_user(repo, "Alex Morgan", role="manager")
    alpha = add_company(repo, "Alpha Roofing", county=BERGEN, rep=rep_a, changed=True, tier="master_elite",
                        priority=80, tags=[tag("service:storm_damage"), tag("service:insurance_claims")])
    beta = add_company(repo, "Beta Exteriors", county=BERGEN, rep=rep_a, priority=40)
    gamma = add_company(repo, "Gamma Builders", county=ESSEX, rep=rep_b, priority=60,
                        tags=[tag("service:new_construction")])
    delta = add_company(repo, "Delta Roofing", county=ESSEX, first_seen=POLL_STARTED + timedelta(minutes=2),
                        changed=True, priority=70)
    echo = add_company(repo, "Echo Roofing", county=BERGEN, priority=30)
    run = add_poll(repo)
    add_audit(repo, run, alpha, "updated", {"tier": ["certified", "master_elite"]})
    add_audit(repo, run, beta, "updated", {"rating": [4.1, 4.6]})
    add_audit(repo, run, delta, "created", {"name": [None, "Delta Roofing"], "tier": [None, "certified"]})
    add_alert(repo, BERGEN, "Severe Thunderstorm Warning", ext="urn:oid:bergen-svr")
    add_alert(repo, ESSEX, "Winter Storm Warning", ext="urn:oid:essex-wsw")
    add_alert(repo, BERGEN, "Frost Advisory", ext="urn:oid:bergen-frost")
    return {"rep_a": rep_a, "rep_b": rep_b, "manager": manager, "alpha": alpha, "beta": beta, "gamma": gamma,
            "delta": delta, "echo": echo, "run": run}
