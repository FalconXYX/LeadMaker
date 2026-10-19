"""Section 1 acceptance -- Rate Limiting & Queuing.

Requirement (docs/OpeningRequirements.MD, Section 1):
  "Uses job queues to manage scraping and LLM rate limits safely when scaling across large territories."
Covered here: HttpClient's per-host minimum interval and retry/backoff (real HttpClient, fake transport
and an injected virtual clock), the LLM requests-per-minute / per-day limiter, and the queue's
duplicate-job guard and exclusive claims.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import event, inspect

from leadmaker import http as http_mod
from leadmaker.db.repository import utcnow
from leadmaker.db.schema import jobs
from leadmaker.http import HttpClient, HttpError
from leadmaker.jobs import JobQueue
from leadmaker.llm import LlmQuotaExceeded
from leadmaker.llm.ratelimit import RateLimiter, get_limiter
from leadmaker.sources.gaf.client import GafClient

from fakes import FakeAsyncSession, FakeClock, offline_settings


class _AsyncioWithClock:
    """The asyncio module as HttpClient sees it, with sleep() on the virtual clock."""

    def __init__(self, clock: FakeClock):
        self._clock = clock

    def __getattr__(self, name):
        return getattr(asyncio, name)

    async def sleep(self, seconds):
        await self._clock.sleep(seconds)


@pytest.fixture
def clock(monkeypatch) -> FakeClock:
    c = FakeClock()
    FakeAsyncSession.log, FakeAsyncSession.script, FakeAsyncSession.clock = [], {}, c
    monkeypatch.setattr(http_mod, "AsyncSession", FakeAsyncSession)
    monkeypatch.setattr(http_mod, "time", SimpleNamespace(monotonic=c.monotonic))
    monkeypatch.setattr(http_mod, "asyncio", _AsyncioWithClock(c))
    monkeypatch.setattr(http_mod, "random", SimpleNamespace(uniform=lambda a, b: 0.0))  # no jitter
    yield c
    FakeAsyncSession.clock = None


def _times(host: str) -> list[float]:
    return [t for t, _, url in FakeAsyncSession.log if url.split("/")[2] == host]


async def test_http_client_enforces_a_minimum_interval_per_host(clock):
    """Requests to one host are spaced by at least the politeness interval; other hosts are not held up,
    and a source can be slowed down further per host."""
    async with HttpClient(offline_settings(per_host_interval_s=0.5)) as http:
        http.set_host_interval("slow.example", 2.0)
        await asyncio.gather(
            *(http.get(f"https://a.example/p{i}") for i in range(3)),
            *(http.get(f"https://b.example/p{i}") for i in range(2)),
            *(http.get(f"https://slow.example/p{i}") for i in range(3)),
        )
    a, b, slow = _times("a.example"), _times("b.example"), _times("slow.example")
    assert (len(a), len(b), len(slow)) == (3, 2, 3)
    assert all(y - x >= 0.5 - 1e-9 for x, y in zip(a, a[1:]))
    assert all(y - x >= 0.5 - 1e-9 for x, y in zip(b, b[1:]))
    assert all(y - x >= 2.0 - 1e-9 for x, y in zip(slow, slow[1:]))
    # Other hosts went out while host a still had requests waiting: no cross-host queueing.
    assert b[0] < a[-1] and slow[0] < a[-1] and a[0] == 1000.0
    assert http.stats["requests"] == 8 and http.stats["retries"] == 0


async def test_gaf_scraper_registers_a_gentler_interval_for_gaf_com(clock):
    """gaf.com itself gets a slower per-host interval than the default."""
    async with HttpClient(offline_settings(per_host_interval_s=0.25)) as http:
        GafClient(http)
        for i in range(3):
            await http.get(f"https://www.gaf.com/en-us/roofing-contractors/residential/p{i}")
    t = _times("www.gaf.com")
    assert [round(y - x, 6) for x, y in zip(t, t[1:])] == [1.0, 1.0]


async def test_http_client_retries_throttling_with_backoff_but_not_client_errors(clock):
    """429/5xx are retried with exponential backoff; a 404 fails at once (or is returned when allowed)."""
    FakeAsyncSession.script = {"https://api.example/x": [429, 503], "https://api.example/missing": [404, 404]}
    async with HttpClient(offline_settings(max_retries=3)) as http:
        ok = await http.get("https://api.example/x")
        assert ok.status == 200 and json.loads(ok.text) == {"ok": True}
        assert http.stats["retries"] == 2 and clock.sleeps == [1.0, 2.0]
        with pytest.raises(HttpError) as err:
            await http.get("https://api.example/missing")
        assert err.value.status == 404 and http.stats["retries"] == 2  # not retried
        allowed = await http.get("https://api.example/missing", allow_statuses=(404,))
        assert allowed.status == 404
    assert [u for _, _, u in FakeAsyncSession.log].count("https://api.example/x") == 3

    FakeAsyncSession.script = {"https://api.example/down": [503] * 10}
    async with HttpClient(offline_settings(max_retries=2)) as http:
        with pytest.raises(HttpError) as err:
            await http.get("https://api.example/down")
        assert err.value.status == 503 and http.stats == {"requests": 3, "retries": 2, "failures": 1}


# ---------------------------------------------------------------------------- LLM limiter
class _Time:
    def __init__(self):
        self.t, self.sleeps = 0.0, []
        self.wall = datetime(2026, 10, 18, 20, 0, tzinfo=timezone.utc)  # 13:00 Pacific

    def clock(self):
        return self.t

    def now(self):
        return self.wall

    async def sleep(self, s):
        self.sleeps.append(round(s, 3))
        self.t += s


async def test_llm_limiter_spaces_requests_per_minute_and_caps_requests_per_day(tmp_path):
    """LLM calls are spaced to the provider's RPM and stop at the daily budget with a reset time; the
    budget is shared by every run on the same quota day."""
    ft = _Time()
    state = str(tmp_path / "llm_usage.json")
    lim = RateLimiter("gemini:flash", rpm=30, rpd=3, state_path=state, clock=ft.clock, now=ft.now, sleep=ft.sleep)
    for _ in range(3):
        await lim.acquire()
    assert ft.sleeps == [2.0, 2.0]  # 60/30 s between request starts
    with pytest.raises(LlmQuotaExceeded) as exc:
        await lim.acquire()
    assert exc.value.scope == "daily" and exc.value.resets_at == datetime(2026, 10, 19, 7, 0, tzinfo=timezone.utc)

    # A second run the same day starts from the persisted count and is refused straight away.
    later = RateLimiter("gemini:flash", rpm=30, rpd=3, state_path=state, clock=ft.clock, now=ft.now, sleep=ft.sleep)
    assert later.used_today == 3 and later.remaining_today == 0
    with pytest.raises(LlmQuotaExceeded):
        await later.acquire()
    # A provider-reported exhaustion stops calls even under the client budget.
    fresh = RateLimiter("gemini:other", rpm=0, rpd=100, clock=ft.clock, now=ft.now, sleep=ft.sleep)
    fresh.mark_exhausted()
    with pytest.raises(LlmQuotaExceeded):
        await fresh.acquire()
    # One limiter per provider+model per process.
    assert get_limiter("gemini:m", 10, 100) is get_limiter("gemini:m", 10, 100)


# ------------------------------------------------------------------------------ job queue
def test_queue_has_a_database_level_guard_against_duplicate_open_jobs(repo):
    """The duplicate-job guard holds even for writers that bypass enqueue(): a unique partial index allows
    one queued/running job per dedupe key, and the key frees up once that job finishes."""
    idx = {i["name"]: i for i in inspect(repo.engine).get_indexes("jobs")}
    assert idx["jobs_open_dedupe_key"]["unique"] and idx["jobs_open_dedupe_key"]["column_names"] == ["dedupe_key"]
    q = JobQueue(repo)
    jid = q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 25})
    row = dict(kind="scrape", params={}, dedupe_key="scrape:10013:25:*", status="queued",
               run_after=utcnow(), created_at=utcnow())
    with pytest.raises(Exception, match="UNIQUE"):
        with repo.engine.begin() as conn:
            conn.execute(jobs.insert().values(**row))
    q.claim("w1")
    q.complete(jid, {})
    with repo.engine.begin() as conn:  # finished: a new open job for the key is fine
        conn.execute(jobs.insert().values(**row))
    assert len(q.list("queued")) == 1


def test_workers_claim_jobs_exclusively_in_priority_order(repo):
    """Several workers draining one queue never get the same job, and urgent work goes first."""
    q = JobQueue(repo)
    ids = [q.enqueue("tag", {"postal_code": str(z)}, priority=p) for z, p in ((1, 100), (2, 10), (3, 50), (4, 100))]
    claimed = []
    workers = ["w1", "w2", "w3"]
    while (job := q.claim(workers[len(claimed) % 3])) is not None:
        claimed.append((job["id"], job["locked_by"], job["attempts"]))
    assert [c[0] for c in claimed] == [ids[1], ids[2], ids[0], ids[3]]
    assert len({c[0] for c in claimed}) == 4 and all(c[2] == 1 for c in claimed)
    assert [c[1] for c in claimed] == ["w1", "w2", "w3", "w1"]
    assert {j["status"] for j in q.list()} == {"running"}


def test_a_worker_that_loses_the_claim_race_takes_the_next_job_instead_of_the_same_one(repo):
    """Two workers that read the same queued job at once: the claim is a conditional update, so only one
    of them gets it and the other moves on to the next job -- no job runs twice."""
    q = JobQueue(repo)
    urgent = q.enqueue("tag", {"postal_code": "1"}, priority=10)
    later = q.enqueue("tag", {"postal_code": "2"}, priority=20)
    rival: list = []

    @event.listens_for(repo.engine, "before_cursor_execute")
    def rival_claims_first(conn, cursor, statement, *a):
        # w2 claims between w1's read of the queue and w1's update of the row it read.
        if statement.startswith("UPDATE jobs SET status") and not rival:
            rival.append(None)
            rival[0] = JobQueue(repo).claim("w2")

    try:
        mine = q.claim("w1")
    finally:
        event.remove(repo.engine, "before_cursor_execute", rival_claims_first)
    assert rival[0]["id"] == urgent and rival[0]["locked_by"] == "w2"
    assert mine["id"] == later and mine["locked_by"] == "w1"
    assert {j["id"]: (j["locked_by"], j["attempts"]) for j in q.list("running")} == {
        urgent: ("w2", 1), later: ("w1", 1)}
