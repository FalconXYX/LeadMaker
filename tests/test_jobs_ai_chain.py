"""Section 4 job wiring: the insights and briefing job kinds, the AI follow-ups a refresh queues (only with a
provider configured, deduped, never failing the refresh), signals queueing the briefing, and the opt-in schedules."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from leadmaker import jobs as jobs_mod
from leadmaker.db.schema import jobs, schedules, territory_briefs
from leadmaker.jobs import (
    AI_SCHEDULES, JOB_KINDS, JobQueue, briefing_on_refresh, enqueue_ai_follow_ups, ensure_ai_schedules, execute, work,
)

from fakes import offline_settings
from test_insights_support import fake_settings, insight_rows, seeded

AREA = {"postal_code": "10013", "radius_miles": 25}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("LEADMAKER_INSIGHTS_ON_REFRESH", "LEADMAKER_BRIEFING_ON_REFRESH", "LEADMAKER_AI_SCHEDULES",
              "LEADMAKER_INSIGHTS_BATCH_SIZE", "LEADMAKER_FAKE_LLM_SCRIPT"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def briefing_calls(monkeypatch) -> list[dict[str, Any]]:
    import leadmaker.briefing as briefing

    calls: list[dict[str, Any]] = []

    async def fake_run_briefing(settings, repo, **kw):
        calls.append(kw)
        return {"scopes": 1, "changed": 0}

    monkeypatch.setattr(briefing, "run_briefing", fake_run_briefing)
    return calls


def open_jobs(repo) -> list[dict[str, Any]]:
    with repo.engine.connect() as conn:
        return [dict(r._mapping) for r in conn.execute(select(jobs).order_by(jobs.c.id))]


def test_job_kinds():
    assert JOB_KINDS == ("scrape", "enrich", "tag", "pipeline", "signals", "insights", "briefing")


async def test_insights_job_runs_the_batch(repo):
    seeded(repo)
    out = await execute(fake_settings(), repo, "insights", {**AREA, "sources": ["gaf"], "limit": 2})
    assert out["insights"]["status"] == "succeeded" and out["insights"]["generated"] == 2
    assert len(insight_rows(repo)) == 2


async def test_insights_job_without_a_provider_is_skipped_not_failed(repo):
    seeded(repo)
    out = await execute(offline_settings(), repo, "insights", {"stale": True})
    assert out == {"insights": {"run_id": None, "status": "skipped", "reason": "no_provider",
                                "detail": "no LLM provider configured"}}


async def test_briefing_job_passes_its_params(repo, briefing_calls):
    out = await execute(offline_settings(), repo, "briefing", {"scopes": ["team"], "rewrite": 0, "force": 1})
    assert out == {"briefing": {"scopes": 1, "changed": 0}}
    assert briefing_calls == [{"scopes": ["team"], "rewrite": False, "force": True}]
    await execute(offline_settings(), repo, "briefing", {})
    assert briefing_calls[-1] == {"scopes": None, "rewrite": None, "force": False}


async def test_a_tag_job_with_a_provider_queues_insights_for_its_area_and_the_briefing(repo):
    seeded(repo)
    out = await execute(fake_settings(), repo, "tag", AREA)
    fu = out["follow_up"]
    assert isinstance(fu["insights"], int) and isinstance(fu["briefing"], int)
    by_kind = {j["kind"]: j for j in open_jobs(repo)}
    ins, brief = by_kind["insights"], by_kind["briefing"]
    assert ins["params"] == AREA and ins["priority"] == 200 and ins["max_attempts"] == 2
    assert ins["dedupe_key"] == "insights:10013:25:*" and ins["status"] == "queued"
    assert brief["params"] == {} and brief["priority"] == 150 and brief["dedupe_key"] == "briefing:*:*:*"
    again = await execute(fake_settings(), repo, "tag", AREA)
    assert again["follow_up"] == {"insights": None, "briefing": None}  # merged into the open jobs
    assert len(open_jobs(repo)) == 2


async def test_without_a_provider_a_refresh_queues_nothing(repo):
    seeded(repo)
    out = await execute(offline_settings(), repo, "tag", AREA)
    assert out["follow_up"] == {"insights": "skipped", "briefing": "skipped"}
    assert open_jobs(repo) == []


async def test_insights_on_refresh_can_be_turned_off(repo, monkeypatch):
    seeded(repo)
    monkeypatch.setenv("LEADMAKER_INSIGHTS_ON_REFRESH", "0")
    out = await execute(fake_settings(), repo, "tag", AREA)
    assert out["follow_up"]["insights"] == "skipped" and isinstance(out["follow_up"]["briefing"], int)


async def test_a_refresh_without_an_area_queues_stale_insights(repo):
    seeded(repo)
    out = await execute(fake_settings(), repo, "tag", {})
    assert isinstance(out["follow_up"]["insights"], int)
    (ins,) = [j for j in open_jobs(repo) if j["kind"] == "insights"]
    assert ins["params"] == {"stale": True} and ins["dedupe_key"] == "insights:*:*:*"


async def test_signals_queues_only_the_briefing(repo, monkeypatch):
    import leadmaker.pipeline.signals as signals

    async def fake_signals(settings, repo, **kw):
        return {"status": "succeeded"}

    monkeypatch.setattr(signals, "run_signals", fake_signals)
    out = await execute(fake_settings(), repo, "signals", {})
    assert out["signals"] == {"status": "succeeded"} and "insights" not in out["follow_up"]
    assert [j["kind"] for j in open_jobs(repo)] == ["briefing"]


async def test_an_enqueue_failure_never_fails_the_refresh(repo, monkeypatch):
    seeded(repo)

    def boom(self, *a, **k):
        raise RuntimeError("jobs table locked")

    monkeypatch.setattr(JobQueue, "enqueue", boom)
    out = await execute(fake_settings(), repo, "tag", AREA)
    assert out["tag"]["tagged"] == 6 and out["follow_up"] == {"insights": "error", "briefing": "error"}


async def test_a_broken_provider_setting_does_not_fail_the_refresh(repo):
    seeded(repo)
    out = await execute(offline_settings(llm_provider_setting="nonsense"), repo, "tag", AREA)
    assert out["follow_up"]["insights"] == "skipped"


def test_briefing_on_refresh_modes(repo, monkeypatch):
    assert briefing_on_refresh(repo, offline_settings()) is False  # auto: no LLM, no briefs yet
    assert briefing_on_refresh(repo, fake_settings()) is True  # auto: an LLM is configured
    with repo.engine.begin() as conn:
        conn.execute(territory_briefs.insert().values(scope="team", digest={}, digest_text="", digest_hash="h"))
    assert briefing_on_refresh(repo, offline_settings()) is True  # auto: briefs are in use
    monkeypatch.setenv("LEADMAKER_BRIEFING_ON_REFRESH", "0")
    assert briefing_on_refresh(repo, fake_settings()) is False
    monkeypatch.setenv("LEADMAKER_BRIEFING_ON_REFRESH", "1")
    with repo.engine.begin() as conn:
        conn.execute(territory_briefs.delete())
    assert briefing_on_refresh(repo, offline_settings()) is True


def test_follow_ups_directly(repo):
    out = enqueue_ai_follow_ups(repo, fake_settings(), {"postal_code": "07030", "radius_miles": 10.0})
    assert isinstance(out["insights"], int)
    (ins,) = [j for j in open_jobs(repo) if j["kind"] == "insights"]
    assert ins["params"] == {"postal_code": "07030", "radius_miles": 10.0} and ins["dedupe_key"] == "insights:07030:10:*"


def test_ai_schedules_are_idempotent(repo):
    q = JobQueue(repo)
    first = ensure_ai_schedules(q)
    with repo.engine.connect() as conn:
        rows = {r.name: dict(r._mapping) for r in conn.execute(select(schedules))}
    assert set(first) == set(AI_SCHEDULES) == {"insights-stale", "briefing"}
    assert rows["insights-stale"]["kind"] == "insights" and rows["insights-stale"]["params"] == {"stale": True}
    assert rows["insights-stale"]["every_hours"] == 0.25 and rows["briefing"]["every_hours"] == 1.0
    q.set_schedule_enabled("briefing", False)  # an operator's choice survives a restart
    assert ensure_ai_schedules(q) == first
    with repo.engine.connect() as conn:
        again = {r.name: dict(r._mapping) for r in conn.execute(select(schedules))}
    assert again["insights-stale"]["next_run_at"] == rows["insights-stale"]["next_run_at"]
    assert again["briefing"]["enabled"] in (False, 0)
    q.add_schedule("insights-stale", "insights", {"stale": True}, 6)  # drifted: reset to the default
    ensure_ai_schedules(q)
    assert {s["name"]: s["every_hours"] for s in q.list_schedules()}["insights-stale"] == 0.25


async def test_the_worker_creates_ai_schedules_only_when_asked(repo, monkeypatch):
    await work(offline_settings(), repo, once=True)
    assert JobQueue(repo).list_schedules() == []
    monkeypatch.setenv("LEADMAKER_AI_SCHEDULES", "1")
    monkeypatch.setattr(jobs_mod.JobQueue, "enqueue_due_schedules", lambda self, now=None: [])  # create, don't fire
    await work(offline_settings(), repo, once=True)
    assert sorted(s["name"] for s in JobQueue(repo).list_schedules()) == ["briefing", "insights-stale"]


async def test_the_worker_runs_a_queued_insights_job(repo):
    seeded(repo)
    q = JobQueue(repo)
    q.enqueue("insights", {**AREA, "limit": 1}, priority=200, max_attempts=2)
    assert await work(fake_settings(), repo, once=True) == 1
    (done,) = q.list("succeeded")
    assert done["result"]["insights"]["generated"] == 1
