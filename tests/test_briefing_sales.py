"""Briefing v3, the sales-first morning briefing: the digest's sales units per scope, the priority order of the text,
the validator on v3 rewrites and the daily snapshot that keeps the hash stable within a day."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import insert, update

from leadmaker.briefing import compute_digest, digest_hash, render_digest_text, validate_rewrite
from leadmaker.briefing.digest import digest_company_ids
from leadmaker.briefing.rewrite import prompt_digest
from leadmaker.briefing.run import run_briefing
from leadmaker.briefing.text import render_units
from leadmaker.db.schema import activity_logs, companies, tasks

from test_briefing_support import BERGEN, ESSEX, NOW, add_company, add_user, settings

DAY = timedelta(days=1)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("LEADMAKER_BRIEFING_AI", "LEADMAKER_BRIEFING_REWRITE_MIN_MINUTES", "LEADMAKER_BRIEFING_POLL_WINDOW_DAYS"):
        monkeypatch.delenv(k, raising=False)


def add_task(repo, company: str, rep: str, due, done=None) -> str:
    tid = str(uuid.uuid4())
    with repo.engine.begin() as conn:
        conn.execute(insert(tasks).values(id=tid, company_id=company, title="Call back", type="call", due_at=due,
                                          done_at=done, assignee_id=rep, created_by=rep))
    return tid


def set_lead(repo, company: str, **values) -> None:
    with repo.engine.begin() as conn:
        conn.execute(update(companies).where(companies.c.id == company).values(**values))


def stage_change(repo, company: str, rep: str, old: str, new: str, at) -> None:
    with repo.engine.begin() as conn:
        conn.execute(insert(activity_logs).values(
            id=str(uuid.uuid4()), company_id=company, actor_type="user", user_id=rep, action_type="stage_changed",
            field_diff={"sales_stage": [old, new]}, created_at=at))
    set_lead(repo, company, sales_stage=new, stage_changed_at=at)


@pytest.fixture
def book(repo):
    """rep A: two overdue follow-ups (Carework, then Direct Call) and one due today; Alpha quoting and quiet for 10
    days; Jersey Roofing new and uncalled (Master Elite); Acme won 2 days ago, Beta moved to quoting. rep B: one
    overdue follow-up on Gamma. NOW is Monday 1 PM ET."""
    a, b = add_user(repo, "Jordan Lee"), add_user(repo, "Priya Shah")
    ids = {"rep_a": a, "rep_b": b}
    for key, name, rep, prio in (("carework", "Carework Construction LLC", a, 60),
                                 ("direct", "Direct Call Roofing", a, 55), ("today", "Today Roofing", a, 50),
                                 ("alpha", "Alpha Roofing", a, 80), ("jersey", "Jersey Roofing LLC", a, 82),
                                 ("acme", "Acme Roofing", a, 40), ("beta", "Beta Exteriors", a, 45),
                                 ("gamma", "Gamma Builders", b, 60)):
        ids[key] = add_company(repo, name, county=BERGEN if rep == a else ESSEX, rep=rep, priority=prio,
                               first_seen=NOW - timedelta(days=40), tier="master_elite" if key == "jersey" else "none")
        set_lead(repo, ids[key], sales_stage="contacted", last_contacted_at=NOW - DAY)
    set_lead(repo, ids["jersey"], sales_stage="new", last_contacted_at=None, first_seen_at=NOW - 3 * DAY)
    set_lead(repo, ids["alpha"], sales_stage="quoting", last_contacted_at=NOW - 10 * DAY)
    add_task(repo, ids["carework"], a, NOW - 5 * DAY)
    add_task(repo, ids["direct"], a, NOW - 2 * DAY)
    add_task(repo, ids["today"], a, NOW + timedelta(hours=2))
    add_task(repo, ids["today"], a, NOW - 9 * DAY, done=NOW - 8 * DAY)  # done: not counted
    add_task(repo, ids["gamma"], b, NOW - 3 * DAY)
    stage_change(repo, ids["acme"], a, "quoting", "won", NOW - 2 * DAY)
    stage_change(repo, ids["beta"], a, "interested", "quoting", NOW - 1 * DAY)
    set_lead(repo, ids["beta"], last_contacted_at=NOW - DAY)
    return ids


def digest(repo, scope, now=NOW, **kw):
    return compute_digest(repo, scope, now, **kw)


# ---------------------------------------------------------------------------------------------- units
def test_rep_sales_units(repo, book):
    d = digest(repo, f"rep:{book['rep_a']}")
    s = d["sales"]
    assert d["v"] == 3 and s["day"] == "2026-10-19"
    f = s["followups"]
    assert (f["overdue"], f["today"]) == (2, 1)
    assert [x["name"] for x in f["waiting"]] == ["Carework Construction LLC", "Direct Call Roofing"]  # oldest first
    assert "behind" not in f
    assert s["quiet"]["count"] == 1 and [x["name"] for x in s["quiet"]["leads"]] == ["Alpha Roofing"]
    assert s["new"]["kind"] == "new" and s["new"]["count"] == 1
    assert s["new"]["leads"][0]["name"] == "Jersey Roofing LLC" and s["new"]["leads"][0]["why"] == "GAF Master Elite"
    m = s["moves"]
    assert (m["quoting"], m["interested"], m["won"], m["lost"]) == (1, 0, 1, 0)
    assert [x["name"] for x in m["won_leads"]] == ["Acme Roofing"]
    assert d["quiet"] is False
    assert {book[k] for k in ("carework", "direct", "alpha", "jersey", "acme")} <= digest_company_ids(d)


def test_team_sales_units_summarise_across_reps(repo, book):
    s = digest(repo, "team")["sales"]
    f = s["followups"]
    assert (f["overdue"], f["today"]) == (3, 1)
    assert f["behind"] == {"rep": "Jordan Lee", "overdue": 2}
    d = digest(repo, "team")
    assert [c for c, _ in render_units(d)] == ["F", "M", "G"]  # team: who is behind and the wins before single leads
    text = render_digest_text(d)
    assert "In the last 7 days: 1 lead moved to quoting and 1 won (Acme Roofing)." in text
    assert text.startswith("This morning across the team: 3 follow-ups are overdue and 1 due today; Jordan Lee is "
                           "furthest behind with 2 overdue.")


def test_quiet_follows_the_call_list_rule(repo, book):
    """Like the dashboard's call list: a quiet lead with a follow-up planned, or marked do-not-contact, is not
    "gone quiet" (the brief and the page header must agree)."""
    scope = f"rep:{book['rep_a']}"
    tid = add_task(repo, book["alpha"], book["rep_a"], NOW + 3 * DAY)
    assert digest(repo, scope, snapshot=False)["sales"]["quiet"]["count"] == 0
    with repo.engine.begin() as conn:
        conn.execute(update(tasks).where(tasks.c.id == tid).values(done_at=NOW))
    assert digest(repo, scope, snapshot=False)["sales"]["quiet"]["count"] == 1  # done: quiet again
    set_lead(repo, book["alpha"], account_status="do_not_contact")
    assert digest(repo, scope, snapshot=False)["sales"]["quiet"]["count"] == 0


def test_rep_b_sees_only_their_book(repo, book):
    s = digest(repo, f"rep:{book['rep_b']}")["sales"]
    assert (s["followups"]["overdue"], s["followups"]["today"]) == (1, 0)
    assert [x["name"] for x in s["followups"]["waiting"]] == ["Gamma Builders"]
    assert s["quiet"]["count"] == 0 and s["new"]["count"] == 0
    assert (s["moves"]["won"], s["moves"]["quoting"]) == (0, 0)


def test_no_new_leads_falls_back_to_uncalled_leads_with_an_insight(repo, book):
    from leadmaker.db.schema import company_insights

    set_lead(repo, book["jersey"], first_seen_at=NOW - 30 * DAY)
    with repo.engine.begin() as conn:
        conn.execute(insert(company_insights).values(
            id=str(uuid.uuid4()), company_id=book["jersey"], business_summary="s", sales_recommendation="p",
            model="fake", prompt_version="insights/v3", input_hash="h1"))
    new = digest(repo, f"rep:{book['rep_a']}")["sales"]["new"]
    assert new["kind"] == "top" and new["count"] == 1 and new["leads"][0]["name"] == "Jersey Roofing LLC"
    assert "1 uncalled lead has an AI pitch ready: Jersey Roofing LLC (GAF Master Elite)." in render_digest_text(
        digest(repo, f"rep:{book['rep_a']}"))


# --------------------------------------------------------------------------------------------- text order
def test_text_is_sales_first(repo, book):
    d = digest(repo, f"rep:{book['rep_a']}")
    assert [c for c, _ in render_units(d)] == ["F", "G", "N"]  # M and anything below drop at 3 sentences
    assert render_digest_text(d) == (
        "This morning: 2 follow-ups are overdue and 1 due today, starting with Carework Construction LLC and Direct "
        "Call Roofing. 1 quoting lead has gone quiet (no touch in 7 days): Alpha Roofing. 1 uncalled lead was found "
        "in the last 14 days: Jersey Roofing LLC (GAF Master Elite).")


def test_weather_is_the_lowest_priority():
    from test_briefing_text import alert, make

    d = make(alerts=[alert()], storm=4)
    d["sales"] = {"followups": {"overdue": 4, "today": 0, "waiting": [{"company_id": "c1", "name": "Carework"}]},
                  "moves": {"won": 1, "lost": 1, "quoting": 2, "interested": 0,
                            "won_leads": [{"company_id": "c2", "name": "Acme Roofing"}]}}
    assert [c for c, _ in render_units(d)] == ["F", "M", "W"]
    text = render_digest_text(d)
    assert text.index("follow-ups") < text.index("In the last 7 days: 2 leads moved to quoting, 1 won (Acme Roofing) "
                                                  "and 1 lost.") < text.index("Severe Thunderstorm Warning")


# ------------------------------------------------------------------------------------------------ validator
@pytest.fixture
def v3(repo, book):
    d = digest(repo, f"rep:{book['rep_a']}")
    return d, render_digest_text(d)


def test_fake_echo_of_the_text_validates(v3):
    d, text = v3
    assert validate_rewrite({"text": text, "company_ids": [x["id"] for x in d["leads"]]}, d, text) == []


def test_a_good_v3_rewrite_validates(v3):
    d, text = v3
    good = ("Start with Carework Construction LLC and Direct Call Roofing: 2 follow-ups are overdue and 1 due today. "
            "Alpha Roofing is a quoting lead with no touch in 7 days, and Jersey Roofing LLC (GAF Master Elite) is "
            "the best new lead, found in the last 14 days.")
    assert validate_rewrite({"text": good, "company_ids": []}, d, text) == []


@pytest.mark.parametrize("bad,problem", [
    ("This morning 1 follow-up is overdue and 2 due today, starting with Carework Construction LLC. Alpha Roofing "
     "has gone quiet for 7 days.", "numbers used for something else"),
    ("This morning 2 follow-ups are overdue and 1 due today, starting with Jersey Roofing LLC. Alpha Roofing has "
     "gone quiet for 7 days.", "names Jersey Roofing LLC for something else"),
    ("This morning 2 follow-ups are overdue and 1 due today, starting with Carework Construction LLC. Summit "
     "Roofing Co has gone quiet for 7 days.", "names something that is not in the digest: Summit Roofing Co"),
    ("This morning 5 follow-ups are overdue, starting with Carework Construction LLC.", "numbers not in the digest"),
])
def test_swapped_numbers_or_names_are_rejected(v3, bad, problem):
    d, text = v3
    violations = validate_rewrite({"text": bad, "company_ids": []}, d, text)
    assert any(problem in v for v in violations), violations


def test_prompt_digest_has_only_the_kept_sales_units(v3):
    d, _ = v3
    seen = prompt_digest(d)["sales"]
    assert set(seen) == {"followups", "quiet", "new"} and "day" not in seen  # M was dropped by the 3-sentence cap


# ------------------------------------------------------------------------------------------- daily snapshot
def test_hash_is_stable_within_the_day_and_moves_the_next_day(repo, book):
    scope = f"rep:{book['rep_a']}"
    morning = NOW - timedelta(hours=4)  # Monday 9 AM ET
    asyncio.run(run_briefing(settings(), repo, scopes=[scope], rewrite=False, now=morning))
    from leadmaker.briefing import store

    first = store.get_brief(repo, scope)["digest_hash"]
    # the rep works the list: a follow-up done, a new task, a call logged
    with repo.engine.begin() as conn:
        conn.execute(update(tasks).where(tasks.c.company_id == book["carework"]).values(done_at=NOW))
    add_task(repo, book["gamma"], book["rep_a"], NOW)
    set_lead(repo, book["alpha"], last_contacted_at=NOW)
    asyncio.run(run_briefing(settings(), repo, scopes=[scope], rewrite=False, now=NOW + timedelta(hours=3)))
    row = store.get_brief(repo, scope)
    assert row["digest_hash"] == first and row["digest"]["sales"]["followups"]["overdue"] == 2  # the 9 AM snapshot
    assert digest(repo, scope, snapshot=False)["sales"]["followups"]["overdue"] == 1  # live counts differ
    asyncio.run(run_briefing(settings(), repo, scopes=[scope], rewrite=False, now=NOW + DAY))
    nxt = store.get_brief(repo, scope)
    assert nxt["digest_hash"] != first and nxt["digest"]["sales"]["day"] == "2026-10-20"
    assert nxt["digest"]["sales"]["quiet"]["count"] == 0  # Alpha was called
