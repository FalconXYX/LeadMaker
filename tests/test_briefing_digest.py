"""Territory briefing digest (leadmaker.briefing.digest): counts, highlights, weather, quiet and the hash."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import insert, update

from leadmaker.briefing import all_scopes, compute_digest, digest_hash, render_digest_text
from leadmaker.briefing.config import BriefingConfig
from leadmaker.briefing.digest import _classify, digest_company_ids, parse_scope, rep_scope, valid_scope
from leadmaker.db.schema import companies, field_overrides, regional_signals

from test_briefing_support import (
    ALERT_END, BERGEN, ESSEX, NOW, OLD, POLL_STARTED, add_alert, add_audit, add_company, add_poll, add_user, assign,
    seed_scenario, tag,
)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("LEADMAKER_BRIEFING_AI", "LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES", "LEADMAKER_BRIEFING_POLL_WINDOW_DAYS"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def scenario(repo):
    return seed_scenario(repo)


def digest(repo, scope, now=NOW, **cfg):
    return compute_digest(repo, scope, now, config=BriefingConfig(**cfg) if cfg else None)


# ------------------------------------------------------------------------------------------------ scopes
def test_scopes_are_team_plus_every_rep(repo, scenario):
    scopes = all_scopes(repo)
    assert scopes[0] == "team"
    assert sorted(scopes[1:]) == sorted(f"rep:{scenario[k]}" for k in ("rep_a", "rep_b"))  # no manager
    assert all(valid_scope(s) for s in scopes)


def test_parse_scope():
    uid = str(uuid.uuid4())
    assert parse_scope("team") == ("team", None)
    assert parse_scope(f"rep:{uid.upper()}") == ("rep", uid)
    assert rep_scope(uid.upper()) == f"rep:{uid}"
    for bad in ("", "mine", "rep:", "rep:123", "manager:" + uid):
        with pytest.raises(ValueError):
            parse_scope(bad)
    assert not valid_scope("rep:not-a-uuid")


# ------------------------------------------------------------------------------------------------- poll
def test_rep_poll_counts_and_highlights(repo, scenario):
    d = digest(repo, f"rep:{scenario['rep_a']}")
    assert d["v"] == 3 and d["scope"] == f"rep:{scenario['rep_a']}" and d["as_of"] == "2026-10-19T17:00:00Z"
    assert d["book"] == {"leads": 2}
    poll = d["poll"]
    assert poll["run_id"] == scenario["run"] and poll["fresh"] is True
    assert poll["finished_at"] == "2026-10-17T17:05:00Z"
    assert (poll["new"], poll["changed"], poll["delisted"]) == (0, 1, 0)
    assert [(h["name"], h["kind"], h["text"]) for h in poll["highlights"]] == [
        ("Alpha Roofing", "tier_up", "now GAF Master Elite (was GAF Certified)"),
        ("Beta Exteriors", "rating_jump", "now rated 4.6 (was 4.1)"),
    ]
    assert d["pool"] == {"new": 1}  # Delta, first seen in the poll and unallocated
    assert d["quiet"] is False


def test_team_book_is_every_allocated_lead(repo, scenario):
    d = digest(repo, "team")
    assert d["book"] == {"leads": 3}
    assert d["poll"]["changed"] == 1  # Alpha; Delta is new and in the pool, not the book
    assert d["pool"] == {"new": 1}


def test_new_and_delisted_within_the_book(repo, scenario):
    rep = scenario["rep_b"]
    assign(repo, scenario["delta"], rep)  # a lead first seen in the poll, now allocated
    add_audit(repo, scenario["run"], scenario["gamma"], "delisted", {"area": ["10013@25mi", None]}, entity_type="area")
    d = digest(repo, f"rep:{rep}")
    assert (d["poll"]["new"], d["poll"]["changed"], d["poll"]["delisted"]) == (1, 0, 1)
    assert d["pool"] == {"new": 0}
    kinds = [h["kind"] for h in d["poll"]["highlights"]]
    assert kinds == ["new_lead", "delisted"]
    assert d["poll"]["highlights"][0]["text"] == "a new GAF Certified listing"


def test_highlight_order_and_cap(repo):
    rep = add_user(repo, "Sam Rivera")
    run = add_poll(repo)
    ids = {}
    for name, prio in (("Low New", 10), ("High New", 90), ("Cert Co", 20), ("Tier Co", 5), ("Site Co", 99)):
        ids[name] = add_company(repo, name, county=BERGEN, rep=rep, priority=prio,
                                tier="none" if name == "High New" else "certified",
                                first_seen=POLL_STARTED + timedelta(minutes=1) if "New" in name else OLD)
    add_audit(repo, run, ids["Low New"], "created", {"tier": [None, "certified"]})
    add_audit(repo, run, ids["High New"], "created", {"tier": [None, "none"]})
    add_audit(repo, run, ids["Cert Co"], "updated", {"certifications": [["A"], ["A", "Shingle Master"]]})
    add_audit(repo, run, ids["Tier Co"], "updated", {"tier": ["certified", "certified_plus"]})
    add_audit(repo, run, ids["Site Co"], "updated", {"rating": [4.5, 4.6]})  # 0.1: not a jump
    hs = digest(repo, f"rep:{rep}")["poll"]["highlights"]
    assert [(h["name"], h["kind"]) for h in hs] == [
        ("Tier Co", "tier_up"), ("Cert Co", "new_certification"), ("High New", "new_lead")]
    assert hs[1]["text"] == "now listed with Shingle Master"
    assert hs[2]["text"] == "a new listing"  # tier 'none' is not named


@pytest.mark.parametrize("entity,action,changes,tier,expected", [
    ("company", "updated", {"tier": ["master_elite", "certified"]}, None, None),  # a tier drop is not news
    ("company", "updated", {"tier": [None, "certified"]}, None, ("tier_up", "now GAF Certified (was not GAF certified)")),
    ("company", "updated", {"rating": [4.0, 4.3]}, None, ("rating_jump", "now rated 4.3 (was 4)")),
    ("company", "updated", {"rating": [4.8, 4.2]}, None, ("rating_jump", "now rated 4.2 (was 4.8)")),
    ("company", "updated", {"website": [None, "https://x.example"]}, None, ("website_found", "newly matched to a website")),
    ("company", "updated", {"phone": ["1", "2"]}, None, None),
    ("company", "created", {}, "master_elite", ("new_lead", "a new GAF Master Elite listing")),
    ("area", "delisted", {}, None, ("delisted", "no longer listed by GAF")),
    ("enrichment", "updated", {"website": [None, "x"]}, None, None),
    ("company", "removed", {}, None, None),
])
def test_classify(entity, action, changes, tier, expected):
    assert _classify(entity, action, changes, tier) == expected


def test_poll_window_and_incomplete_runs(repo, scenario):
    late = NOW + timedelta(days=8)  # the poll finished > 7 days before
    d = digest(repo, f"rep:{scenario['rep_a']}", now=late)
    assert d["poll"]["fresh"] is False and d["poll"]["run_id"] == scenario["run"]
    assert (d["poll"]["new"], d["poll"]["changed"], d["poll"]["highlights"]) == (0, 0, [])
    assert d["pool"] == {"new": 0}
    assert digest(repo, f"rep:{scenario['rep_a']}", now=late, poll_window_days=30)["poll"]["fresh"] is True
    # a newer run without stats.poll (incomplete area read) or a failed one is not "the poll"
    add_poll(repo, started=NOW - timedelta(hours=2), complete=False)
    add_poll(repo, started=NOW - timedelta(hours=1), status="failed")
    assert digest(repo, "team")["poll"]["run_id"] == scenario["run"]


def test_no_poll_at_all(repo):
    rep = add_user(repo, "Sam Rivera")
    add_company(repo, "Lonely Roofing", county=BERGEN, rep=rep)
    d = digest(repo, f"rep:{rep}")
    assert d["poll"] == {"run_id": None, "finished_at": None, "fresh": False, "new": 0, "changed": 0, "delisted": 0,
                         "highlights": []}
    assert d["quiet"] is True and d["leads"] == [] and render_digest_text(d) == ""


# ---------------------------------------------------------------------------------------------- weather
def test_alerts_only_in_book_counties_and_roofing_relevant(repo, scenario):
    a = digest(repo, f"rep:{scenario['rep_a']}")["weather"]
    assert [(x["event"], x["county"], x["level"], x["leads"]) for x in a["alerts"]] == [
        ("Severe Thunderstorm Warning", "Bergen County, NJ", "warning", 2)]  # no Frost Advisory, no Essex alert
    assert a["alerts"][0]["ends_at"] == "2026-10-20T00:00:00Z" and a["alerts"][0]["id"] == "urn:oid:bergen-svr"
    team = digest(repo, "team")["weather"]
    assert [x["county_fips"] for x in team["alerts"]] == [BERGEN, ESSEX]  # both warnings: more leads first
    assert team["alert_counties"] == 2


def test_storm_response_and_delays_from_the_timing_layer(repo, scenario):
    a = digest(repo, f"rep:{scenario['rep_a']}")["weather"]
    assert a["storm_response"] == [{"company_id": scenario["alpha"], "name": "Alpha Roofing", "severity": "medium",
                                    "reason": "Severe Thunderstorm Warning"}]
    assert (a["storm_response_total"], a["alert_storm_leads"], a["weather_delays_total"]) == (1, 1, 0)
    b = digest(repo, f"rep:{scenario['rep_b']}")["weather"]
    assert (b["storm_response_total"], b["weather_delays_total"]) == (0, 1)  # Gamma: new construction, winter storm


def test_storm_response_sorted_and_capped(repo):
    rep = add_user(repo, "Sam Rivera")
    for i in range(7):
        add_company(repo, f"Storm Co {i}", county=BERGEN, rep=rep, priority=10 * i, tags=[tag("service:storm_damage")])
    add_alert(repo, BERGEN, "Severe Thunderstorm Warning")
    w = digest(repo, f"rep:{rep}")["weather"]
    assert w["storm_response_total"] == 7
    assert [s["name"] for s in w["storm_response"]] == [f"Storm Co {i}" for i in (6, 5, 4, 3, 2)]


def test_alert_filters(repo):
    rep = add_user(repo, "Sam Rivera")
    add_company(repo, "Plain Roofing", county=BERGEN, rep=rep)
    add_alert(repo, BERGEN, "Special Weather Statement")  # statement: not a hazard
    add_alert(repo, BERGEN, "Wind Advisory", start=NOW + timedelta(days=3), end=NOW + timedelta(days=4))  # not yet
    add_alert(repo, BERGEN, "High Wind Warning", start=NOW - timedelta(days=1), end=NOW - timedelta(hours=1))  # over
    d = digest(repo, f"rep:{rep}")
    assert d["weather"]["alerts"] == [] and d["quiet"] is True


def test_alert_levels_sort_and_cap(repo):
    rep = add_user(repo, "Sam Rivera")
    counties = ["34003", "34013", "34017", "34031", "34039"]
    for c in counties:
        add_company(repo, f"Roofer {c}", county=c, rep=rep)
    add_alert(repo, "34003", "Wind Advisory")
    add_alert(repo, "34013", "Flood Watch")
    add_alert(repo, "34017", "Winter Storm Warning", end=None)
    add_alert(repo, "34031", "Tornado Watch")
    add_alert(repo, "34039", "Coastal Flood Advisory")
    w = digest(repo, f"rep:{rep}")["weather"]
    assert [a["level"] for a in w["alerts"]] == ["warning", "watch", "watch"]
    assert w["alerts"][0]["ends_at"] is None and w["alert_counties"] == 5


def test_storm_response_after_an_alert_ended(repo):
    """A warning that ended 2 days ago still drives storm response (timing's 7-day lookback), not the alert list."""
    rep = add_user(repo, "Sam Rivera")
    add_company(repo, "Storm Co", county=BERGEN, rep=rep, tags=[tag("service:storm_damage")])
    add_alert(repo, BERGEN, "Severe Thunderstorm Warning", start=NOW - timedelta(days=2, hours=3),
              end=NOW - timedelta(days=2))
    d = digest(repo, f"rep:{rep}")
    assert d["weather"]["alerts"] == []
    assert d["weather"]["storm_response_total"] == 1
    assert d["weather"]["storm_response"][0]["reason"] == "Severe Thunderstorm Warning (recent)"
    assert d["quiet"] is False
    assert render_digest_text(d) == ("1 storm-restoration roofer in this territory may need tarps and repair stock "
                                     "after recent storm alerts.")


# ------------------------------------------------------------------------------------------- names, quiet
def test_names_use_overrides_and_are_fenced(repo, scenario):
    with repo.engine.begin() as conn:
        conn.execute(insert(field_overrides).values(
            id=str(uuid.uuid4()), company_id=scenario["alpha"], field="business_name",
            value="Alpha <b>Roofing</b>​ & Sons", user_id=scenario["manager"], created_at=NOW))
    d = digest(repo, f"rep:{scenario['rep_a']}")
    name = d["poll"]["highlights"][0]["name"]
    assert name == "Alpha ‹b›Roofing‹/b› & Sons"
    assert d["leads"] == [{"id": scenario["alpha"], "name": name}]
    assert "<" not in render_digest_text(d)


def test_quiet_when_nothing_applies(repo):
    rep = add_user(repo, "Sam Rivera")
    add_company(repo, "Quiet Roofing", county=BERGEN, rep=rep)
    add_poll(repo)  # a fresh poll that changed nothing in the book or the pool
    d = digest(repo, f"rep:{rep}")
    assert d["quiet"] is True and render_digest_text(d) == "" and d["leads"] == []


def test_empty_book_still_sees_the_pool(repo, scenario):
    rep = add_user(repo, "New Rep")
    d = digest(repo, f"rep:{rep}")
    assert d["book"] == {"leads": 0} and d["weather"]["alerts"] == []
    assert render_digest_text(d) == "1 new lead is waiting in the unallocated pool."


def test_digest_company_ids(repo, scenario):
    d = digest(repo, "team")
    assert digest_company_ids(d) == {scenario["alpha"], scenario["beta"]}


# ------------------------------------------------------------------------------------------------- hash
def test_hash_ignores_as_of(repo, scenario):
    scope = f"rep:{scenario['rep_a']}"
    a, b = digest(repo, scope), digest(repo, scope, now=NOW + timedelta(minutes=37))
    assert a["as_of"] != b["as_of"]
    assert digest_hash(a) == digest_hash(b)
    assert len(digest_hash(a)) == 64


def test_hash_changes_with_an_alert_an_allocation_or_a_poll(repo, scenario):
    scope = f"rep:{scenario['rep_b']}"
    base = digest_hash(digest(repo, scope))
    ext = add_alert(repo, ESSEX, "Flood Watch")
    with_alert = digest_hash(digest(repo, scope))
    assert with_alert != base
    with repo.engine.begin() as conn:
        conn.execute(regional_signals.delete().where(regional_signals.c.external_id == ext))
    assert digest_hash(digest(repo, scope)) == base
    assign(repo, scenario["echo"], scenario["rep_b"])
    allocated = digest_hash(digest(repo, scope))
    assert allocated != base
    add_poll(repo, started=NOW - timedelta(hours=3))
    assert digest_hash(digest(repo, scope)) != allocated


def test_hash_ignores_priority_and_unrelated_columns(repo, scenario):
    scope = f"rep:{scenario['rep_b']}"
    base = digest_hash(digest(repo, scope))
    with repo.engine.begin() as conn:
        conn.execute(update(companies).where(companies.c.id == scenario["gamma"]).values(
            priority_score=12, custom_fields={"annual_volume": 10}, updated_at=NOW))
    assert digest_hash(digest(repo, scope)) == base


def test_alert_end_is_absolute_in_the_digest(repo, scenario):
    d = digest(repo, "team")
    assert {a["ends_at"] for a in d["weather"]["alerts"]} == {ALERT_END.isoformat().replace("+00:00", "Z")}


def test_recent_storm_reports_count_storm_roofers_in_the_book(repo):
    """AI/product review M6: the demo week had no active alert and no fresh poll, so every brief was quiet. NOAA
    storm reports from the last 30 days now make storm roofers in those counties news (digest v2)."""
    import uuid as _uuid
    from datetime import timedelta as _td

    from sqlalchemy import insert as _insert

    from leadmaker.db.schema import regional_signals as _signals
    from test_briefing_support import NOW as _NOW

    rep = add_user(repo, "Sam Rivera")
    storm_tags = [{"key": "service:storm_damage", "label": "Storm damage", "category": "services", "value": True}]
    add_company(repo, "Storm Pros", county=BERGEN, rep=rep, tags=storm_tags)
    add_company(repo, "Plain Roofing", county=BERGEN, rep=rep)
    add_company(repo, "Pool Storm Co", county=BERGEN, tags=storm_tags)  # not in the book
    day = (_NOW - _td(days=5)).date().isoformat()
    events = [{"date": day, "kind": "wind", "event_type": "TSTM WND DMG", "location": "Ramsey", "source": "lsr",
               "valid": f"{day}T20:00:00Z", "report_count": 3}]
    with repo.engine.begin() as conn:
        conn.execute(_insert(_signals).values(
            id=str(_uuid.uuid4()), county_fips=BERGEN, kind="storm_history", source="noaa_storm_events",
            external_id="summary_24m", payload={"recent_events": events, "last_event_at": day},
            valid_from=_NOW - _td(days=730), valid_to=_NOW, fetched_at=_NOW))
    d = digest(repo, f"rep:{rep}")
    assert d["weather"]["recent_storm"] == {"leads": 1, "counties": ["Bergen County, NJ"], "county_count": 1}
    assert d["quiet"] is False
    assert render_digest_text(d) == ("Roof-damaging storms were reported in Bergen County in the last 30 days: "
                                     "1 storm-restoration roofer there may need repair stock.")
