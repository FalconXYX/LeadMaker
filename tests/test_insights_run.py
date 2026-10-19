"""run_insights end to end on SQLite with the fake provider: skip-unchanged by input_hash, --force, --limit,
allocated-first order, --dry-run, quota (partial, resumable), auth (aborts), no provider, error rows retried by
attempts and age, do-not-contact leads, and the --stale candidates (notes yes, weather no)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy import func, select, update

from leadmaker.db.schema import companies, regional_signals, scrape_runs
from leadmaker.insights import InsightsOptions, candidates, run_insights
from leadmaker.llm import LlmAuthError, LlmQuotaExceeded
from leadmaker.llm.providers.fake import FakeProvider

from dbutil import add_user
from fakes import offline_settings
from test_insights_support import (
    add_note, age_rows, fake, fake_settings, insight_events, insight_rows, seeded, set_company,
)


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    for k in ("LEADMAKER_INSIGHTS_BATCH_SIZE", "LEADMAKER_INSIGHTS_MAX_ATTEMPTS", "LEADMAKER_FAKE_LLM_SCRIPT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LEADMAKER_INSIGHTS_CONCURRENCY", "1")  # deterministic call order


class QuotaAfter(FakeProvider):
    """Template answers for the first `n` calls, then the daily quota is gone."""

    def __init__(self, n: int):
        super().__init__(fake_settings())
        self.n = n

    async def generate_json(self, http, **kw: Any):
        if len(self.calls) >= self.n:
            self.calls.append({"kind": "generate_json", "user": kw["user"], "system": "", "schema_name": "insights"})
            raise LlmQuotaExceeded("free-tier daily quota", provider="fake",
                                   resets_at=datetime(2026, 10, 20, 7, tzinfo=timezone.utc))
        return await super().generate_json(http, **kw)


async def run(repo, provider=None, **opts):
    return await run_insights(fake_settings(), repo, InsightsOptions(**opts), provider=provider or fake())


def runs(repo, kind="insights"):
    with repo.engine.connect() as conn:
        return [dict(r._mapping) for r in conn.execute(select(scrape_runs).where(scrape_runs.c.kind == kind))]


def names_in_calls(provider) -> list[str]:
    import re

    return [m for c in provider.calls for m in re.findall(r"F1 business_name: (.*)", c["user"])]


async def test_generates_every_lead_then_skips_unchanged(repo):
    ids = seeded(repo)
    p = fake()
    out = await run(repo, p)
    assert out["status"] == "succeeded" and out["considered"] == 6 and out["generated"] == 6
    assert out["llm_calls"] == 6 == len(p.calls) and out["errors"] == 0 and out["model"] == "fake:fake-1"
    assert {r["company_id"] for r in insight_rows(repo)} == set(ids)
    assert all(r["status"] == "ok" and r["business_summary"] for r in insight_rows(repo))
    assert len(insight_events(repo)) == 6
    again = await run(repo, p)
    assert again["skipped_unchanged"] == 6 and again["llm_calls"] == 0 and again["generated"] == 0
    assert len(p.calls) == 6 and len(insight_rows(repo)) == 6
    (r1, r2) = runs(repo)
    assert r1["status"] == "succeeded" and r1["stats"]["generated"] == 6 and r1["finished_at"] is not None
    # emit=False: per-lead lead.updated events drive invalidation, no pipeline.run_completed for the run
    assert not [e for e in repo.outbox("pipeline.run_completed") if e["payload"]["run_id"] in (r1["id"], r2["id"])]


async def test_batches_force_and_limit(repo):
    seeded(repo)
    p = fake()
    out = await run(repo, p, batch_size=4)
    assert out["llm_calls"] == 2 and out["generated"] == 6
    assert insight_rows(repo)[0]["token_usage"]["batch_size"] in (2, 4)
    forced = await run(repo, p, force=True, limit=2, batch_size=2)
    assert forced["generated"] == 2 and forced["llm_calls"] == 1 and forced["to_generate"] == 2
    assert sorted(r["attempts"] for r in insight_rows(repo)) == [1, 1, 1, 1, 2, 2]


async def test_allocated_leads_go_first_then_priority(repo):
    ids = seeded(repo)
    for i, cid in enumerate(ids):
        set_company(repo, cid, priority_score=float(10 * i))
    rep = add_user(repo, "Rep One")
    set_company(repo, ids[1], assigned_rep_id=rep)  # low priority but allocated
    names = {}
    with repo.engine.connect() as conn:
        for r in conn.execute(select(companies.c.id, companies.c.business_name)):
            names[r.id] = r.business_name
    p = fake()
    await run(repo, p, limit=3)
    assert names_in_calls(p) == [names[ids[1]], names[ids[5]], names[ids[4]]]


async def test_dry_run_makes_no_calls_and_no_writes(repo):
    seeded(repo)
    p = fake()
    out = await run(repo, p, dry_run=True, batch_size=4)
    assert out["status"] == "dry_run" and out["to_generate"] == 6 and out["estimated_llm_calls"] == 2
    assert out["provider_ready"] is True and len(out["leads"]) == 6 and len(out["leads"][0]["input_hash"]) == 64
    assert p.calls == [] and insight_rows(repo) == [] and runs(repo) == [] and insight_events(repo) == []
    # without any provider a dry run still reports the facts and hashes
    out = await run_insights(offline_settings(), repo, InsightsOptions(dry_run=True))
    assert out["status"] == "dry_run" and out["provider_ready"] is False and out["to_generate"] == 6


async def test_no_provider_skips_without_a_run(repo):
    seeded(repo)
    out = await run_insights(offline_settings(), repo, InsightsOptions())
    assert out == {"run_id": None, "status": "skipped", "reason": "no_provider", "detail": "no LLM provider configured"}
    assert runs(repo) == []


async def test_quota_mid_run_is_partial_keeps_earlier_rows_and_the_next_run_resumes(repo):
    seeded(repo)
    p = QuotaAfter(2)
    out = await run(repo, p)
    assert out["status"] == "partial" and out["reason"] == "quota" and out["generated"] == 2
    assert out["resets_at"] == "2026-10-20T07:00:00+00:00" and out["errors"] == 0
    assert len(p.calls) == 3  # the 3rd call hit the quota; later batches never went out
    assert len(insight_rows(repo)) == 2 and runs(repo)[0]["status"] == "partial"
    resumed = await run(repo, fake())
    assert resumed["skipped_unchanged"] == 2 and resumed["generated"] == 4 and len(insight_rows(repo)) == 6


async def test_auth_failure_aborts_the_run(repo):
    seeded(repo)
    with pytest.raises(LlmAuthError):
        await run(repo, fake([{"insights": []}, LlmAuthError("API key not valid", provider="fake")]))
    (r,) = runs(repo)
    assert r["status"] == "failed" and "API key not valid" in r["error"]


async def test_error_rows_are_retried_by_attempts_and_age(repo, monkeypatch):
    monkeypatch.setenv("LEADMAKER_INSIGHTS_MAX_ATTEMPTS", "2")
    cid = seeded(repo)[0]
    bad = {"insights": [{"lead_ref": "L1", "summary": "x", "summary_facts": ["F99"], "pitch": "y", "pitch_facts": [],
                         "talking_points": [], "target_contact": None, "product_focus": []}]}
    out = await run(repo, fake([bad, bad]), company_ids=[cid])
    assert out["errors"] == 1 and out["llm_calls"] == 2
    (row,) = insight_rows(repo, cid)
    assert row["status"] == "error" and "cited F99, which does not exist" in row["error"] and row["attempts"] == 1
    # an error row emits lead.updated ['insights'] too, so a profile waiting on a Refresh sees the failed attempt
    (ev,) = insight_events(repo)
    assert ev["company_id"] == cid and ev["payload"]["material"] is False
    out = await run(repo, fake(), company_ids=[cid])
    assert out["skipped_backoff"] == 1 and out["llm_calls"] == 0  # under an hour old
    age_rows(repo, 2)
    out = await run(repo, fake([bad, bad]), company_ids=[cid])
    assert out["errors"] == 1 and insight_rows(repo, cid)[0]["attempts"] == 2
    age_rows(repo, 2)
    out = await run(repo, fake(), company_ids=[cid])
    assert out["skipped_failed"] == 1 and out["llm_calls"] == 0  # used its attempts: waits for new facts
    out = await run(repo, fake(), company_ids=[cid], force=True)
    assert out["generated"] == 1 and insight_rows(repo, cid)[0]["status"] == "ok"


async def test_do_not_contact_leads_are_never_sent(repo):
    ids = seeded(repo)
    set_company(repo, ids[0], account_status="do_not_contact")
    p = fake()
    out = await run(repo, p)
    assert out["skipped_dnc"] == 1 and out["generated"] == 5
    assert ids[0] not in {r["company_id"] for r in insight_rows(repo)}


async def test_lead_selection_by_company_and_area(repo):
    ids = seeded(repo)
    out = await run(repo, fake(), company_ids=[ids[2], ids[3]])
    assert out["considered"] == 2 and out["generated"] == 2
    out = await run(repo, fake(), postal_code="10013", radius_miles=25)
    assert out["considered"] == 6 and out["skipped_unchanged"] == 2 and out["generated"] == 4
    out = await run(repo, fake(), postal_code="07030", radius_miles=25)
    assert out["considered"] == 0 and out["llm_calls"] == 0


def test_options_from_job_params():
    o = InsightsOptions.from_params({"postal_code": 10013, "sources": ["gaf"], "limit": "5", "stale": 1})
    assert (o.postal_code, o.radius_miles, o.limit, o.stale) == ("10013", 25.0, 5, True)
    assert InsightsOptions.from_params({"company_id": "abc"}).company_ids == ["abc"]
    assert InsightsOptions.from_params(None) == InsightsOptions()
    assert InsightsOptions(stale=True, limit=3).params() == {"stale": True, "limit": 3}


async def test_a_newer_row_for_other_inputs_means_the_old_hash_is_regenerated(repo):
    cid = seeded(repo)[0]
    await run(repo, fake(), company_ids=[cid])
    add_note(repo, cid, "Wants a quote")
    await run(repo, fake(), company_ids=[cid])
    with repo.engine.begin() as conn:  # the note is deleted: the inputs are back to the first row's hash
        from leadmaker.db.schema import activity_logs

        conn.execute(activity_logs.delete().where(activity_logs.c.company_id == cid))
    out = await run(repo, fake(), company_ids=[cid])
    assert out["generated"] == 1  # the newest row (with the note) is what readers show, so it is refreshed
    rows = insight_rows(repo, cid)
    assert len(rows) == 2 and rows[-1]["attempts"] == 2  # the old row was upserted in place


# --------------------------------------------------------------------------- --stale


async def test_stale_picks_leads_with_new_notes_but_never_weather(repo):
    ids = seeded(repo)
    await run(repo, fake())
    assert candidates(repo) == []
    now = datetime.now(timezone.utc)
    with repo.engine.begin() as conn:  # weather is joined on county at read time, never written to companies
        conn.execute(regional_signals.insert().values(
            county_fips="36061", kind="active_alert", source="nws", external_id="urn:test:alert",
            payload={"event": "Wind Advisory"}, valid_from=now, valid_to=now + timedelta(hours=6)))
    assert candidates(repo) == []
    p = fake()
    out = await run(repo, p, stale=True)
    assert out["considered"] == 0 and len(p.calls) == 0
    add_note(repo, ids[3], "Asked for a quote on 25 squares")
    assert candidates(repo) == [ids[3]]
    out = await run(repo, p, stale=True)
    assert out["considered"] == 1 and out["generated"] == 1 and len(p.calls) == 1
    assert candidates(repo) == []


async def test_stale_candidates_after_company_updates_are_confirmed_by_the_hash(repo):
    ids = seeded(repo)
    await run(repo, fake())
    later = datetime.now(timezone.utc) + timedelta(seconds=2)
    set_company(repo, ids[0], priority_score=99.0, updated_at=later)  # a re-score bumps updated_at
    set_company(repo, ids[1], custom_fields={"annual_volume_squares": 1200}, updated_at=later)
    assert sorted(candidates(repo)) == sorted([ids[0], ids[1]])
    p = fake()
    out = await run(repo, p, stale=True)
    assert out["considered"] == 2 and out["skipped_unchanged"] == 1 and out["generated"] == 1 and len(p.calls) == 1


async def test_stale_retries_error_rows_with_attempts_left_once_they_are_an_hour_old(repo, monkeypatch):
    monkeypatch.setenv("LEADMAKER_INSIGHTS_MAX_ATTEMPTS", "2")
    ids = seeded(repo)
    cid = ids[0]
    for c in ids:
        set_company(repo, c, updated_at=datetime.now(timezone.utc) - timedelta(hours=5))
    await run(repo, fake())
    bad = {"insights": [{"lead_ref": "L1", "summary": "x"}]}
    await run(repo, fake([bad, bad]), company_ids=[cid], force=True)  # same hash -> the row turns into an error
    row = insight_rows(repo, cid)[0]
    assert row["status"] == "error" and row["attempts"] == 2
    with repo.engine.begin() as conn:
        from leadmaker.db.schema import company_insights

        conn.execute(update(company_insights).values(attempts=1))
    assert candidates(repo) == []  # under an hour old
    age_rows(repo, 2)
    assert candidates(repo) == [cid]
    with repo.engine.begin() as conn:
        conn.execute(update(company_insights).values(attempts=2))
    assert candidates(repo) == []  # used its attempts


async def test_a_company_without_any_row_is_a_candidate(repo):
    ids = seeded(repo)
    assert sorted(candidates(repo)) == sorted(ids)
    with repo.engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(companies)).scalar() == 6


async def test_batches_never_mix_owners(repo):
    """Security review M1: one prompt never holds two reps' leads (or a rep's and pool leads)."""
    ids = seeded(repo)
    r1, r2 = add_user(repo, "Rep One"), add_user(repo, "Rep Two")
    owners = [r1, r2, r1, None, r2, r1]
    for cid, owner in zip(ids, owners):
        set_company(repo, cid, assigned_rep_id=owner)
    by_name: dict[str, Any] = {}
    with repo.engine.connect() as conn:
        for r in conn.execute(select(companies.c.business_name, companies.c.assigned_rep_id)):
            by_name[r.business_name] = r.assigned_rep_id
    p = fake()
    out = await run(repo, p, batch_size=8)
    assert out["generated"] == 6 and out["batches"] == 3 == len(p.calls)
    import re
    for call in p.calls:
        owners_in_call = {by_name[n] for n in re.findall(r"F1 business_name: (.*)", call["user"])}
        assert len(owners_in_call) == 1, owners_in_call
