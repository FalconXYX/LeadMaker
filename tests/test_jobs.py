"""Job queue / scheduler / worker (offline)."""

import json
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import event, select, text, update

from leadmaker.config import Settings
from leadmaker.db.repository import as_utc, utcnow
from leadmaker.db.schema import jobs, schedules
from leadmaker.jobs import JobQueue, JobRateLimitError, area_dedupe_key, work
from leadmaker.models import SearchArea, SearchHit
from leadmaker.sources.gaf.parse import parse_coveo_result

from dbutil import add_user

FIX = Path(__file__).parent / "fixtures"


def test_enqueue_dedupes_active_jobs(repo):
    q = JobQueue(repo)
    a = q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25})
    b = q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25})
    c = q.enqueue("scrape", {"postal_code": "07030", "radius_miles": 25})
    assert a and c and b is None
    with pytest.raises(ValueError):
        q.enqueue("nope", {})


def test_claim_is_exclusive_and_ordered_by_priority(repo):
    q = JobQueue(repo)
    low = q.enqueue("tag", {"postal_code": "1"}, priority=200)
    high = q.enqueue("tag", {"postal_code": "2"}, priority=10)
    j1 = q.claim("w1")
    j2 = q.claim("w2")
    assert j1["id"] == high and j2["id"] == low
    assert j1["status"] == "running" and j1["attempts"] == 1 and j1["locked_by"] == "w1"
    assert q.claim("w3") is None


def test_fail_backoff_then_dead_then_retry(repo):
    q = JobQueue(repo)
    jid = q.enqueue("tag", {}, max_attempts=2)
    q.claim("w")
    assert q.fail(jid, "boom") == "queued"
    assert q.claim("w") is None  # backoff: run_after is in the future
    with repo.engine.begin() as conn:
        conn.execute(update(jobs).where(jobs.c.id == jid).values(run_after=utcnow() - timedelta(seconds=1)))
    q.claim("w")
    assert q.fail(jid, "boom again") == "dead"
    assert q.list("dead")[0]["error"] == "boom again"
    assert q.retry_dead() == 1 and q.claim("w")["id"] == jid


def test_stale_running_jobs_are_requeued(repo):
    q = JobQueue(repo)
    jid = q.enqueue("tag", {})
    q.claim("crashed-worker")
    with repo.engine.begin() as conn:
        conn.execute(update(jobs).where(jobs.c.id == jid).values(locked_at=utcnow() - timedelta(hours=3)))
    assert q.requeue_stale() == 1
    assert q.claim("w2")["id"] == jid


def test_schedules_enqueue_once_per_slot(repo):
    q = JobQueue(repo)
    q.add_schedule("nyc-daily", "pipeline", {"postal_code": "10013", "radius_miles": 25}, every_hours=24)
    first = q.enqueue_due_schedules()
    assert len(first) == 1
    assert q.enqueue_due_schedules() == []  # next slot is tomorrow
    s = q.list_schedules()[0]
    assert s["last_enqueued_at"] is not None
    # Far in the future: missed slots collapse into one job (no burst), and dedupe holds while queued.
    assert len(q.enqueue_due_schedules(now=utcnow() + timedelta(days=5))) == 0  # job 1 still queued
    assert q.set_schedule_enabled("nyc-daily", False)


async def test_worker_runs_tag_job_end_to_end(repo):
    cs = [parse_coveo_result(x) for x in json.loads((FIX / "coveo_search_response.json").read_text())["results"]]
    repo.upsert_contractors(cs)
    run = repo.start_run("gaf_ingest", {})
    area = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7, longitude=-74.0)
    repo.record_search_hits(run, area, [SearchHit(company_id=repo.company_id(c.gaf_id), distance_miles=1, rank=i + 1)
                                        for i, c in enumerate(cs)])
    q = JobQueue(repo)
    q.enqueue("tag", {"postal_code": "10013", "radius_miles": 25})
    n = await work(Settings(database_url="sqlite://"), repo, once=True)
    assert n == 1
    done = q.list("succeeded")[0]
    assert done["result"]["tag"]["tagged"] == len(cs)
    assert all(r["segment"] for r in repo.get_companies())


# ------------------------------------------------------------- duplicate-job guard
def _status(repo, job_id):
    with repo.engine.connect() as conn:
        return conn.execute(select(jobs.c.status).where(jobs.c.id == job_id)).scalar()


def _kill(q, job_id):
    """Run a job to 'dead' (max_attempts=1 jobs die on their first failure)."""
    assert q.claim("w")["id"] == job_id
    assert q.fail(job_id, "boom") == "dead"


def test_open_dedupe_index_rejects_a_second_open_job(repo):
    q = JobQueue(repo)
    q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25})
    with pytest.raises(Exception, match="UNIQUE"):
        with repo.engine.begin() as conn:
            conn.execute(jobs.insert().values(
                kind="scrape", params={}, dedupe_key="scrape:10013:25:*", status="queued",
                run_after=utcnow(), created_at=utcnow(),
            ))


def test_enqueue_that_loses_a_race_returns_none(repo, caplog):
    """A competing enqueue commits between our dedupe check and our insert."""
    rep_a, rep_b = add_user(repo, "Rep A"), add_user(repo, "Rep B")
    caplog.set_level("INFO", logger="leadmaker.jobs")
    q = JobQueue(repo)
    params = {"postal_code": "10013", "radius_miles": 25}
    raced = []

    @event.listens_for(repo.engine, "before_cursor_execute")
    def competitor(conn, cursor, statement, *a):
        if statement.startswith("INSERT INTO jobs") and not raced:
            raced.append(True)
            with repo.engine.begin() as other:
                other.execute(jobs.insert().values(
                    kind="scrape", params=params, dedupe_key="scrape:10013:25:*", status="queued",
                    run_after=utcnow(), created_at=utcnow(), requested_by=rep_b,
                ))

    assert q.enqueue("scrape", params, requested_by=rep_a) is None
    event.remove(repo.engine, "before_cursor_execute", competitor)
    assert raced and "merged into the open job" in caplog.text  # the IntegrityError path ran
    open_jobs = q.list("queued")
    assert len(open_jobs) == 1 and open_jobs[0]["requested_by"] == rep_b
    assert q.open_job_id("scrape:10013:25:*") == open_jobs[0]["id"]


def test_retry_dead_leaves_job_dead_when_its_key_is_open_again(repo):
    q = JobQueue(repo)
    params = {"postal_code": "10013", "radius_miles": 25}
    old = q.enqueue("scrape", params, max_attempts=1)
    _kill(q, old)
    fresh = q.enqueue("scrape", params)  # the key is free again, so a new job is accepted
    assert fresh and fresh != old
    assert q.retry_dead(old) == 0 and q.retry_dead() == 0  # the old one would duplicate it
    assert _status(repo, old) == "dead" and _status(repo, fresh) == "queued"


def test_retry_dead_with_two_dead_jobs_on_one_key_requeues_the_newest(repo):
    q = JobQueue(repo)
    params = {"postal_code": "10013", "radius_miles": 25}
    first = q.enqueue("scrape", params, max_attempts=1)
    _kill(q, first)
    second = q.enqueue("scrape", params, max_attempts=1)
    _kill(q, second)
    other = q.enqueue("tag", {}, max_attempts=1)
    _kill(q, other)
    assert q.retry_dead() == 2  # used to fail outright with an IntegrityError
    assert _status(repo, second) == "queued" and _status(repo, other) == "queued"
    assert _status(repo, first) == "dead"


def test_stale_job_on_its_last_attempt_goes_dead_instead_of_looping(repo):
    q = JobQueue(repo)
    jid = q.enqueue("tag", {}, max_attempts=1)
    q.claim("crashed-worker")
    with repo.engine.begin() as conn:
        conn.execute(update(jobs).where(jobs.c.id == jid).values(locked_at=utcnow() - timedelta(hours=3)))
    assert q.requeue_stale() == 0
    dead = q.list("dead")[0]
    assert dead["id"] == jid and "lock expired" in dead["error"] and dead["finished_at"]
    # And the key is free for a new job.
    assert q.enqueue("tag", {}) is not None


def test_schedule_slot_is_enqueued_once_even_with_a_stale_read(repo):
    q = JobQueue(repo)
    q.add_schedule("nyc-daily", "pipeline", {"postal_code": "10013", "radius_miles": 25}, every_hours=24)
    with repo.engine.connect() as conn:
        stale = dict(conn.execute(select(schedules)).first()._mapping)  # worker B read it as due
    first = q.enqueue_due_schedules()  # worker A wins the slot
    assert len(first) == 1
    q.complete(first[0], {})  # finishes fast: the dedupe key is free again
    now = utcnow()
    assert q._fire_schedule(stale, now) is None  # B lost the slot: no second run
    assert len(q.list()) == 1
    assert q.list_schedules()[0]["last_enqueued_at"] is not None


def test_schedule_with_hand_edited_timestamp_still_fires_once(repo):
    """A next_run_at written outside SQLAlchemy (no microseconds) must not wedge the slot claim."""
    q = JobQueue(repo)
    q.add_schedule("hand", "tag", {"postal_code": "1"}, every_hours=24)
    with repo.engine.begin() as conn:
        conn.execute(text("UPDATE schedules SET next_run_at = datetime('now', '-1 hour')"))
    assert len(q.enqueue_due_schedules()) == 1
    assert q.enqueue_due_schedules() == []
    assert as_utc(q.list_schedules()[0]["next_run_at"]) > utcnow()


# ------------------------------------------------------------ rep-triggered limits
@pytest.fixture
def reps(repo):
    return add_user(repo, "Rep One"), add_user(repo, "Rep Two")


def test_requested_by_is_stored_and_rate_limited_per_requester(repo, reps):
    rep1, rep2 = reps
    q = JobQueue(repo, user_jobs_per_hour=3)
    ids = [q.enqueue("scrape", {"postal_code": z, "radius_miles": 10}, requested_by=rep1)
           for z in ("10001", "10002", "10003")]
    assert all(ids)
    assert {j["requested_by"] for j in q.list()} == {rep1}
    with pytest.raises(JobRateLimitError) as exc:
        q.enqueue("scrape", {"postal_code": "10004", "radius_miles": 10}, requested_by=rep1)
    assert exc.value.limit == 3 and rep1 in str(exc.value)
    retry_at = exc.value.retry_at  # oldest job + 1h, in UTC (usable for a Retry-After header)
    assert retry_at.utcoffset() == timedelta(0) and utcnow() < retry_at <= utcnow() + timedelta(hours=1)
    # Other reps, schedules and the CLI (no requester) are unaffected.
    assert q.enqueue("scrape", {"postal_code": "10004", "radius_miles": 10}, requested_by=rep2)
    assert q.enqueue("scrape", {"postal_code": "10005", "radius_miles": 10})
    assert len(q.list()) == 5


def test_merged_duplicates_are_free_even_at_the_limit(repo, reps):
    rep1, rep2 = reps
    q = JobQueue(repo, user_jobs_per_hour=1)
    params = {"postal_code": "10013", "radius_miles": 25}
    assert q.enqueue("scrape", params, requested_by=rep1)
    for _ in range(5):  # same area again: merged into the open job, never counted or refused
        assert q.enqueue("scrape", params, requested_by=rep1) is None
    assert q.enqueue("scrape", params, requested_by=rep2) is None
    with pytest.raises(JobRateLimitError):
        q.enqueue("scrape", {"postal_code": "07030", "radius_miles": 25}, requested_by=rep1)


def test_rate_limit_window_rolls_and_reads_env(repo, reps, monkeypatch):
    rep1 = reps[0]
    monkeypatch.setenv("LEADMAKER_USER_JOBS_PER_HOUR", "2")
    q = JobQueue(repo)
    assert q.user_jobs_per_hour == 2
    q.enqueue("tag", {"postal_code": "1"}, requested_by=rep1)
    q.enqueue("tag", {"postal_code": "2"}, requested_by=rep1)
    with pytest.raises(JobRateLimitError):
        q.enqueue("tag", {"postal_code": "3"}, requested_by=rep1)
    with repo.engine.begin() as conn:  # both jobs are now just over an hour old
        conn.execute(update(jobs).values(created_at=utcnow() - timedelta(minutes=61)))
    assert q.enqueue("tag", {"postal_code": "3"}, requested_by=rep1)
    assert JobQueue(repo, user_jobs_per_hour=0).enqueue("tag", {"postal_code": "4"}, requested_by=rep1)
    monkeypatch.delenv("LEADMAKER_USER_JOBS_PER_HOUR")
    assert JobQueue(repo).user_jobs_per_hour == 20


def test_requested_by_must_be_a_known_user_id(repo, reps):
    q = JobQueue(repo)
    with pytest.raises(ValueError, match="uuid"):
        q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25}, requested_by="rep42")
    with pytest.raises(ValueError, match="not a known user"):
        q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25},
                  requested_by="00000000-0000-4000-8000-000000000000")
    assert q.list() == []
    assert q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25}, requested_by=reps[0].upper())
    assert q.list()[0]["requested_by"] == reps[0]  # stored in canonical form


def test_dedupe_key_is_canonical_across_callers():
    """The CRM Write Service builds the same key from JSON (25, no sources) as the CLI does from argparse (25.0)."""
    assert area_dedupe_key("scrape", {"postal_code": "10013", "radius_miles": 25.0}) == "scrape:10013:25:*"
    assert area_dedupe_key("scrape", {"postal_code": "10013", "radius_miles": 25}) == "scrape:10013:25:*"
    assert area_dedupe_key("scrape", {"postal_code": "10013", "radius_miles": 12.5}) == "scrape:10013:12.5:*"
    assert (area_dedupe_key("enrich", {"postal_code": "10013", "radius_miles": 25, "sources": ["osm", "bbb"]})
            == "enrich:10013:25:bbb,osm")
    assert area_dedupe_key("tag", {"postal_code": "1"}) == "tag:1:*:*"
