"""Runs started by a job carry the job on their pipeline.run_completed events (the notifier's refresh_done link);
a requester's job that dies emits one more, of kind 'job' (refresh_failed)."""

import json
from datetime import timedelta
from pathlib import Path

from sqlalchemy import update

from leadmaker.config import Settings
from leadmaker.db.repository import utcnow
from leadmaker.db.schema import jobs
from leadmaker.jobs import JobQueue, job_events, work
from leadmaker.models import SearchArea, SearchHit
from leadmaker.sources.gaf.parse import parse_coveo_result

from dbutil import add_user

FIX = Path(__file__).parent / "fixtures"


def _completed(repo):
    return [e["payload"] for e in repo.outbox("pipeline.run_completed")]


async def test_a_requested_job_stamps_its_run_completed_events(repo):
    rep = add_user(repo)
    cs = [parse_coveo_result(x) for x in json.loads((FIX / "coveo_search_response.json").read_text())["results"]]
    repo.upsert_contractors(cs)
    run = repo.start_run("gaf_ingest", {})
    area = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7, longitude=-74.0)
    repo.record_search_hits(run, area, [SearchHit(company_id=repo.company_id(c.gaf_id), distance_miles=1, rank=i + 1)
                                        for i, c in enumerate(cs)])
    q = JobQueue(repo)
    job_id = q.enqueue("tag", {"postal_code": "10013", "radius_miles": 25}, requested_by=rep)
    assert await work(Settings(database_url="sqlite://"), repo, once=True) == 1
    (done,) = _completed(repo)
    assert done["kind"] == "tag"
    assert {k: done[k] for k in ("job_id", "job_kind", "requested_by", "job_run_ids")} == {
        "job_id": job_id, "job_kind": "tag", "requested_by": rep, "job_run_ids": []}
    # Outside a job, runs emit the plain payload again.
    repo.finish_run(repo.start_run("tag", {}), "succeeded", {})
    assert "job_id" not in _completed(repo)[-1]


def test_later_runs_list_the_jobs_earlier_runs_and_scheduled_jobs_have_no_requester(repo):
    with job_events(repo, {"id": 9, "kind": "scrape", "requested_by": None}):
        first = repo.start_run("gaf_ingest", {})
        repo.finish_run(first, "succeeded", {"upsert": {"new": 2, "changed": 1}})
        second = repo.start_run("tag", {})
        repo.finish_run(second, "succeeded", {})
    a, b = _completed(repo)
    assert (a["job_id"], a["job_run_ids"], a["requested_by"]) == (9, [], None)
    assert (b["job_id"], b["job_kind"], b["job_run_ids"]) == (9, "scrape", [first])
    assert "_emit" not in vars(repo)


async def _failing_scrape(settings, repo, kind, params):
    """A scrape whose run fails (and is recorded, as run_scrape records it) after it started."""
    run = repo.start_run("gaf_ingest", {})
    repo.finish_run(run, "failed", {}, error="RuntimeError: GAF down")
    raise RuntimeError("GAF down")


async def test_a_requested_job_that_dies_emits_a_failed_job_completion(repo, monkeypatch):
    monkeypatch.setattr("leadmaker.jobs.execute", _failing_scrape)
    rep = add_user(repo)
    q = JobQueue(repo)
    job_id = q.enqueue("scrape", {"postal_code": "07030", "radius_miles": 10}, requested_by=rep, max_attempts=2)
    assert await work(Settings(database_url="sqlite://"), repo, once=True) == 1
    # The first failed attempt is retried: only the failed run's own completion so far.
    (run_done,) = _completed(repo)
    assert (run_done["kind"], run_done["status"], run_done["job_id"]) == ("gaf_ingest", "failed", job_id)
    assert q.list("queued")[0]["id"] == job_id
    with repo.engine.begin() as conn:
        conn.execute(update(jobs).where(jobs.c.id == job_id).values(run_after=utcnow() - timedelta(seconds=1)))
    assert await work(Settings(database_url="sqlite://"), repo, once=True) == 1
    assert q.list("dead")[0]["id"] == job_id
    *_, retry_run, dead = _completed(repo)
    assert retry_run["kind"] == "gaf_ingest"
    assert dead == {
        "actor_type": "pipeline", "actor_id": None, "run_id": None, "kind": "job", "status": "failed", "complete": False,
        "changed_companies": 0, "company_ids": [], "company_ids_truncated": False, "job_id": job_id, "job_kind": "scrape",
        "job_status": "dead", "requested_by": rep, "job_run_ids": [retry_run["run_id"]],
    }


async def test_scheduled_jobs_die_silently_and_a_stale_requested_job_dies_with_the_event(repo, monkeypatch):
    monkeypatch.setattr("leadmaker.jobs.execute", _failing_scrape)
    q = JobQueue(repo)
    q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 5}, max_attempts=1)
    await work(Settings(database_url="sqlite://"), repo, once=True)
    assert [e["kind"] for e in _completed(repo)] == ["gaf_ingest"]

    rep = add_user(repo)
    job_id = q.enqueue("tag", {"postal_code": "10013", "radius_miles": 5}, requested_by=rep, max_attempts=1)
    q.claim("crashed-worker")
    with repo.engine.begin() as conn:
        conn.execute(update(jobs).where(jobs.c.id == job_id).values(locked_at=utcnow() - timedelta(hours=3)))
    assert q.requeue_stale() == 0
    dead = _completed(repo)[-1]
    assert (dead["kind"], dead["job_id"], dead["job_kind"], dead["requested_by"], dead["job_run_ids"]) == ("job", job_id, "tag", rep, [])
