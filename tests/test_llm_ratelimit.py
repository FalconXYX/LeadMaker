"""Client-side LLM rate limiter: RPM spacing, daily budget, provider-reported exhaustion, persistence."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from leadmaker.llm import LlmQuotaExceeded
from leadmaker.llm.ratelimit import RateLimiter, get_limiter, reset_limiters


class FakeTime:
    """Monotonic clock + wall clock + sleep that only advances virtual time."""

    def __init__(self, wall: datetime):
        self.t = 1000.0
        self.wall = wall
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.t

    def now(self) -> datetime:
        return self.wall

    async def sleep(self, s: float) -> None:
        self.sleeps.append(round(s, 3))
        self.t += s


def limiter(ft: FakeTime, rpm: int = 0, rpd: int = 0, state_path: str | None = None) -> RateLimiter:
    return RateLimiter("gemini:test-model", rpm, rpd, state_path=state_path, clock=ft.clock, now=ft.now,
                       sleep=ft.sleep)


# 2026-10-18 20:00 UTC is 13:00 Pacific (PDT).
NOON_PT = datetime(2026, 10, 18, 20, 0, tzinfo=timezone.utc)


async def test_rpm_spaces_requests_evenly():
    ft = FakeTime(NOON_PT)
    lim = limiter(ft, rpm=6)
    for _ in range(3):
        await lim.acquire()
    assert ft.sleeps == [10.0, 10.0]  # 60/6 s between starts, first one immediate


async def test_backoff_delays_every_caller():
    ft = FakeTime(NOON_PT)
    lim = limiter(ft)  # unlimited RPM
    await lim.acquire()
    lim.backoff(7)
    await lim.acquire()
    assert ft.sleeps == [7.0]


async def test_daily_budget_raises_quota_with_reset_time():
    ft = FakeTime(NOON_PT)
    lim = limiter(ft, rpd=2)
    await lim.acquire()
    await lim.acquire()
    assert lim.remaining_today == 0
    with pytest.raises(LlmQuotaExceeded) as ei:
        await lim.acquire()
    assert ei.value.scope == "daily" and ei.value.provider == "gemini"
    # Next midnight Pacific (PDT, UTC-7) = 07:00 UTC on Oct 19.
    assert ei.value.resets_at == datetime(2026, 10, 19, 7, 0, tzinfo=timezone.utc)
    assert "budget of 2" in str(ei.value)


async def test_budget_resets_at_pacific_midnight():
    ft = FakeTime(NOON_PT)
    lim = limiter(ft, rpd=1)
    await lim.acquire()
    ft.wall = datetime(2026, 10, 19, 6, 59, tzinfo=timezone.utc)  # 23:59 PT, same quota day
    with pytest.raises(LlmQuotaExceeded):
        await lim.acquire()
    ft.wall = datetime(2026, 10, 19, 7, 1, tzinfo=timezone.utc)  # 00:01 PT, new day
    await lim.acquire()
    assert lim.used_today == 1


async def test_mark_exhausted_blocks_until_next_day():
    ft = FakeTime(NOON_PT)
    lim = limiter(ft)  # no client budget: only the server's word counts
    await lim.acquire()
    lim.mark_exhausted()
    assert lim.remaining_today == 0
    with pytest.raises(LlmQuotaExceeded, match="provider"):
        await lim.acquire()
    ft.wall = datetime(2026, 10, 19, 8, 0, tzinfo=timezone.utc)
    await lim.acquire()


async def test_usage_persists_across_processes(tmp_path):
    path = str(tmp_path / "usage.json")
    ft = FakeTime(NOON_PT)
    first = limiter(ft, rpd=3, state_path=path)
    await first.acquire()
    await first.acquire()
    state = json.loads((tmp_path / "usage.json").read_text())
    assert state["gemini:test-model"] == {"day": "2026-10-18", "count": 2, "exhausted": False}

    second = limiter(ft, rpd=3, state_path=path)  # e.g. a second pipeline run the same day
    await second.acquire()
    with pytest.raises(LlmQuotaExceeded):
        await second.acquire()

    ft.wall = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
    third = limiter(ft, rpd=3, state_path=path)
    assert third.used_today == 0


def test_unwritable_state_file_does_not_raise(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    lim = RateLimiter("k:m", 0, 1, state_path=str(blocker / "usage.json"))  # parent is a file
    lim.mark_exhausted()  # logs a warning, keeps working in memory
    assert lim.remaining_today == 0


def test_get_limiter_shares_per_key_and_rebuilds_on_new_limits():
    reset_limiters()
    a = get_limiter("gemini:m", 5, 100)
    assert get_limiter("gemini:m", 5, 100) is a
    assert get_limiter("gemini:m", 10, 100) is not a
    assert get_limiter("anthropic:m", 5, 100) is not a
    reset_limiters()
