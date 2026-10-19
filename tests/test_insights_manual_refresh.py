"""A rep's "Refresh" on one profile (crm-write POST /api/leads/:id/insights/refresh): the job params
{company_ids: [id], force: true, requested_by} regenerate the lead even when its input_hash is unchanged, on a
separate daily allowance (LEADMAKER_MANUAL_INSIGHTS_PER_DAY) that still works once the batch budget is spent; the
facts the model sees carry the rep's tags, notes, activity, overrides, contacts, stage and last contact; and an
idle worker wakes for such a job within about a second."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from leadmaker.insights import InsightsOptions, build_facts, input_hash, render_leads_block, run_insights
from leadmaker.insights.run import manual_provider
from leadmaker.jobs import MANUAL_INSIGHTS_PRIORITY, JobQueue, idle
from leadmaker.llm.ratelimit import RateLimiter, reset_limiters
from leadmaker.llm.providers.fake import FakeProvider

from dbutil import add_user
from test_insights_support import (
    add_custom_tag, add_note, add_override, fake_settings, insight_events, insight_rows, rich_lead, seeded, set_company,
)

FP = "fake:fake-1"


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    for k in ("LEADMAKER_INSIGHTS_BATCH_SIZE", "LEADMAKER_INSIGHTS_MAX_ATTEMPTS", "LEADMAKER_FAKE_LLM_SCRIPT",
              "LEADMAKER_MANUAL_INSIGHTS_PER_DAY", "LEADMAKER_WORKER_URGENT_POLL_SECONDS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LEADMAKER_INSIGHTS_CONCURRENCY", "1")
    reset_limiters()
    yield
    reset_limiters()


def provider(rpd: int = 0) -> FakeProvider:
    """The fake on a batch limiter with `rpd` calls a day (0 = unlimited)."""
    return FakeProvider(fake_settings(), limiter=RateLimiter("fake:fake-1", rpd=rpd))


def manual_params(company_id: str, rep: str) -> InsightsOptions:
    # What crm-write queues, read back through the worker's params parser.
    return InsightsOptions.from_params({"company_ids": [company_id], "force": True, "requested_by": rep})


def facts_of(repo, company_id: str):
    (lf,) = build_facts(repo, [company_id])
    return lf


# --------------------------------------------------------------------------- options


def test_manual_is_a_forced_requested_run_of_a_few_leads():
    o = InsightsOptions.from_params({"company_ids": ["c1"], "force": True, "requested_by": "u1"})
    assert o.manual and o.force and o.requested_by == "u1" and o.company_ids == ["c1"]
    assert o.params() == {"company_ids": ["c1"], "force": True, "requested_by": "u1"}
    assert not InsightsOptions.from_params({"company_ids": ["c1"], "force": True}).manual  # the CLI's --force
    assert not InsightsOptions.from_params({"company_ids": ["c1"], "requested_by": "u1"}).manual  # not forced
    assert not InsightsOptions.from_params({"stale": True, "force": True, "requested_by": "u1"}).manual  # no ids
    assert not InsightsOptions.from_params({"company_ids": [f"c{i}" for i in range(6)], "force": True,
                                            "requested_by": "u1"}).manual  # a batch, not a profile


# --------------------------------------------------------------------------- force bypasses the hash


async def test_a_manual_refresh_regenerates_an_unchanged_lead_and_emits_the_event(repo):
    ids = seeded(repo)
    rep = add_user(repo, "Rep One")
    p = provider()
    first = await run_insights(fake_settings(), repo, InsightsOptions(company_ids=[ids[0]]), provider=p)
    assert first["generated"] == 1
    (row,) = insight_rows(repo, ids[0])
    # Unchanged inputs: the edit hook's job (no force) skips by hash ...
    again = await run_insights(fake_settings(), repo, InsightsOptions(company_ids=[ids[0]]), provider=p)
    assert again["skipped_unchanged"] == 1 and again["llm_calls"] == 0
    events = len(insight_events(repo))
    # ... the rep's Refresh does not: one call, the same row refreshed in place, a newer generated_at, one event.
    out = await run_insights(fake_settings(), repo, manual_params(ids[0], rep), provider=p)
    assert out["status"] == "succeeded" and out["manual"] is True
    assert out["generated"] == 1 and out["llm_calls"] == 1 and out["skipped_unchanged"] == 0 and out["considered"] == 1
    (after,) = insight_rows(repo, ids[0])
    assert after["id"] == row["id"] and after["attempts"] == 2 and after["generated_at"] > row["generated_at"]
    assert len(insight_events(repo)) == events + 1
    assert insight_events(repo)[-1]["payload"]["fields"] == ["insights"]


async def test_a_manual_refresh_still_skips_a_do_not_contact_lead(repo):
    ids = seeded(repo)
    set_company(repo, ids[0], account_status="do_not_contact")
    p = provider()
    out = await run_insights(fake_settings(), repo, manual_params(ids[0], add_user(repo)), provider=p)
    assert out["skipped_dnc"] == 1 and out["llm_calls"] == 0 and p.calls == []


# --------------------------------------------------------------------------- the manual allowance


async def test_manual_refreshes_run_on_their_own_allowance_when_the_batch_budget_is_spent(repo, monkeypatch):
    monkeypatch.setenv("LEADMAKER_MANUAL_INSIGHTS_PER_DAY", "2")
    ids = seeded(repo)
    rep = add_user(repo, "Rep One")
    p = provider(rpd=1)
    batch = await run_insights(fake_settings(), repo, InsightsOptions(company_ids=ids[:2]), provider=p)
    assert batch["generated"] == 1 and batch["status"] == "partial" and batch["reason"] == "quota"
    assert p.limiter.remaining_today == 0
    # The batch budget is gone; the rep's Refresh still runs, twice, without touching it.
    for _ in range(2):
        out = await run_insights(fake_settings(), repo, manual_params(ids[0], rep), provider=p)
        assert out["status"] == "succeeded" and out["generated"] == 1 and out["llm_calls"] == 1
    assert p.limiter.used_today == 1 and p.limiter.remaining_today == 0
    # The third one finds the manual allowance spent too: deferred, like the batch quota, nothing written.
    rows = insight_rows(repo, ids[0])
    out = await run_insights(fake_settings(), repo, manual_params(ids[0], rep), provider=p)
    assert out["status"] == "partial" and out["reason"] == "quota" and out["generated"] == 0
    assert insight_rows(repo, ids[0]) == rows
    # Batch jobs never draw on the manual allowance.
    later = await run_insights(fake_settings(), repo, InsightsOptions(company_ids=[ids[2]]), provider=p)
    assert later["to_generate"] == 1 and later["generated"] == 0 and later["reason"] == "quota"


def test_manual_provider_copies_the_provider_onto_a_separate_limiter():
    p = provider(rpd=5)
    m = manual_provider(fake_settings(llm_usage_file=""), p, per_day=3)
    assert m is not p and m.limiter is not p.limiter and m.limiter.key == "fake:fake-1:manual"
    assert m.limiter.rpd == 3 and p.limiter.rpd == 5 and m.calls is p.calls and m.model == p.model
    assert manual_provider(fake_settings(), p, per_day=0) is p  # 0: share the batch budget


# --------------------------------------------------------------------------- inputs audit


def test_the_prompt_facts_carry_the_reps_tags_notes_activity_overrides_contacts_stage_and_last_contact(repo):
    company_id = rich_lead(repo)
    set_company(repo, company_id, sales_stage="quoting", account_status="lapsed_customer",
                last_contacted_at=datetime(2026, 10, 12, 15, tzinfo=timezone.utc))
    add_override(repo, company_id, "city", "Rutherford")
    add_custom_tag(repo, company_id, "Wants metal pricing")
    lf = facts_of(repo, company_id)
    block = render_leads_block([lf])
    for text in ("custom_tag: Wants metal pricing", "custom_tag: Bulk buyer",  # rep tags
                 "tag: Storm / insurance work", "services: Roof replacement, Storm damage",  # system tags
                 "custom_field: preferred_brand = GAF Timberline HDZ",  # custom fields
                 "note (Jordan L., 2026-10-09): Buys 40 squares a month",  # notes
                 "activity (call, connected, 2026-10-12): Connected with the owner",  # logged activity
                 "location: Rutherford, NJ 07071",  # a rep-corrected value
                 "target_contact: Owner — Jose Sucuzhanay Sr., President", "contact: Maria Lopez, Office Manager",
                 "sales_stage: quoting", "account_status: lapsed customer", "last_contacted: 2026-10-12",
                 "gaf_tier: GAF Master Elite", "rating: 4.8 stars"):
        assert text in block, text
    assert '<website_excerpt id="W1">' in block and "Storm restoration and roof replacement" in block


@pytest.mark.parametrize("change", ["custom_tag", "note", "visit", "email", "contact_override", "last_contacted",
                                    "account_status"])
def test_a_rep_edit_changes_the_facts_and_the_hash(repo, change):
    from sqlalchemy import select

    from leadmaker.db.schema import contacts, field_overrides

    company_id = rich_lead(repo)
    before = facts_of(repo, company_id)
    if change == "custom_tag":
        add_custom_tag(repo, company_id, "Net-30 approved")
    elif change == "note":
        add_note(repo, company_id, "Asked for a quote on 30 squares of Timberline")
    elif change == "visit":
        add_note(repo, company_id, "Dropped samples at the yard", action="visit", outcome="met")
    elif change == "email":
        add_note(repo, company_id, "Sent the TPO price sheet", action="email", outcome="sent")
    elif change == "contact_override":
        with repo.engine.begin() as conn:
            contact_id = conn.execute(select(contacts.c.id).where(contacts.c.company_id == company_id,
                                                                  contacts.c.name == "Maria Lopez")).scalar()
            conn.execute(field_overrides.insert().values(company_id=company_id, contact_id=contact_id, field="title",
                                                         value="Purchasing Manager", user_id=add_user(repo)))
    elif change == "last_contacted":
        set_company(repo, company_id, last_contacted_at=datetime(2026, 10, 18, 14, tzinfo=timezone.utc))
    elif change == "account_status":
        set_company(repo, company_id, account_status="existing_customer")
    after = facts_of(repo, company_id)
    assert [(f.key, f.text) for f in after.facts] != [(f.key, f.text) for f in before.facts]
    assert input_hash(after, FP) != input_hash(before, FP)
    if change == "custom_tag":
        assert "custom_tag: Net-30 approved" in render_leads_block([after])
    if change == "contact_override":
        assert "contact: Maria Lopez, Purchasing Manager" in render_leads_block([after])


def test_a_lead_never_contacted_has_no_last_contacted_fact(repo):
    lf = facts_of(repo, rich_lead(repo))
    assert not [f for f in lf.facts if f.key == "last_contacted"]


# --------------------------------------------------------------------------- the worker wakes for it


def test_a_due_manual_job_is_urgent_and_runs_first(repo):
    q = JobQueue(repo)
    assert not q.has_urgent()
    q.enqueue("insights", {"stale": True}, priority=200)
    q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25})
    assert not q.has_urgent()  # refreshes and follow-ups wait for the normal poll
    manual = q.enqueue("insights", {"company_ids": ["c1"], "force": True}, priority=MANUAL_INSIGHTS_PRIORITY,
                       dedupe_key="insights:company:c1:manual")
    assert q.has_urgent()
    assert q.claim("w1")["id"] == manual


async def test_an_idle_worker_wakes_within_a_step_when_an_urgent_job_arrives(repo):
    q = JobQueue(repo)
    slept: list[float] = []

    async def sleep(s: float) -> None:
        slept.append(s)
        if len(slept) == 2:
            q.enqueue("insights", {"company_ids": ["c1"], "force": True}, priority=MANUAL_INSIGHTS_PRIORITY,
                      dedupe_key="insights:company:c1:manual")

    await idle(q, 15.0, step=1.0, sleep=sleep)
    assert slept == [1.0, 1.0]  # woke after the second step, not after 15 s
    slept.clear()
    q.claim("w1")
    await idle(q, 3.0, step=1.0, sleep=sleep)
    assert sum(slept) == 3.0  # nothing urgent: the whole poll
    slept.clear()
    await idle(q, 5.0, step=0, sleep=sleep)
    assert slept == [5.0]
