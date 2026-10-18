"""Client-side LLM rate limiting: requests-per-minute spacing plus a requests-per-day budget.

Free tiers (Gemini) enforce RPM and RPD per project and model; going over just returns 429s, but
hammering a spent quota wastes the run. So every provider call first `acquire()`s a slot:
  * RPM is enforced as an even spacing (60/rpm s between request starts), like HttpClient's per-host
    interval, so a burst of concurrent leads never trips the per-minute quota.
  * RPD counts requests per quota day (Gemini resets at midnight Pacific). When the budget is used up,
    or the server says the daily quota is gone (`mark_exhausted`), acquire() raises LlmQuotaExceeded
    immediately, so the enricher records a "quota" skip and the next run picks the rest up.
  * `backoff(seconds)` (after a 429 with Retry-After) pushes the next slot out for every caller.
The day counter is persisted to a small JSON file so two runs on the same day share one budget.
It is per process; a multi-worker deployment would move this to the Redis token bucket (design doc).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

from .base import LlmQuotaExceeded

log = logging.getLogger(__name__)

PACIFIC = ZoneInfo("America/Los_Angeles")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RateLimiter:
    def __init__(
        self,
        key: str,
        rpm: int = 0,
        rpd: int = 0,
        *,
        state_path: str | None = None,
        day_tz: ZoneInfo = PACIFIC,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] = _utcnow,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ):
        self.key = key
        self.rpm = max(0, rpm)
        self.rpd = max(0, rpd)
        self.state_path = state_path or None
        self.day_tz = day_tz
        self._clock, self._now, self._sleep = clock, now, sleep
        self._next_at = 0.0
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None
        self._day = self._today()
        self._count = 0
        self._exhausted = False
        self._load()

    # -- quota day -------------------------------------------------------------
    def _today(self) -> str:
        return self._now().astimezone(self.day_tz).date().isoformat()

    def resets_at(self) -> datetime:
        """Next quota-day boundary (midnight in day_tz), in UTC."""
        local = self._now().astimezone(self.day_tz)
        nxt = datetime.combine(local.date() + timedelta(days=1), dtime(0), tzinfo=self.day_tz)
        return nxt.astimezone(timezone.utc)

    def _roll_day(self) -> None:
        today = self._today()
        if today != self._day:
            self._day, self._count, self._exhausted = today, 0, False

    @property
    def used_today(self) -> int:
        self._roll_day()
        return self._count

    @property
    def remaining_today(self) -> int | None:
        """Requests left in today's client budget (None = unlimited); 0 once the server said so."""
        self._roll_day()
        if self._exhausted:
            return 0
        return None if not self.rpd else max(0, self.rpd - self._count)

    # -- persistence -------------------------------------------------------------
    def _load(self) -> None:
        if not self.state_path:
            return
        try:
            entry = json.loads(Path(self.state_path).read_text()).get(self.key) or {}
        except (OSError, ValueError, AttributeError):
            return
        if entry.get("day") == self._day:
            self._count = int(entry.get("count") or 0)
            self._exhausted = bool(entry.get("exhausted"))

    def _save(self) -> None:
        if not self.state_path:
            return
        path = Path(self.state_path)
        try:
            try:
                state = json.loads(path.read_text())
                state = state if isinstance(state, dict) else {}
            except (OSError, ValueError):
                state = {}
            state[self.key] = {"day": self._day, "count": self._count, "exhausted": self._exhausted}
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
            os.replace(tmp, path)
        except OSError as e:  # a read-only checkout must not break the pipeline
            log.warning("could not persist LLM usage to %s: %s", path, e)

    # -- acquiring ----------------------------------------------------------------
    def _get_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:  # asyncio locks are bound to one loop
            self._lock, self._lock_loop = asyncio.Lock(), loop
        return self._lock

    def _quota_error(self, why: str) -> LlmQuotaExceeded:
        provider = self.key.split(":", 1)[0]
        return LlmQuotaExceeded(
            f"{why} for {self.key} ({self._count} requests on {self._day}); resets {self.resets_at().isoformat()}",
            provider=provider, resets_at=self.resets_at(), scope="daily",
        )

    async def acquire(self, abort: Callable[[], BaseException | None] | None = None) -> None:
        """Wait for the next request slot; raise LlmQuotaExceeded when today's budget is spent.

        `abort()` returning an exception (e.g. the provider's remembered auth failure) raises it instead
        of taking the slot, so leads queued behind a bad key neither wait out their slot nor use budget.
        """
        async with self._get_lock():
            self._roll_day()
            if abort is not None and (err := abort()) is not None:
                raise err
            if self._exhausted:
                raise self._quota_error("daily quota exhausted (provider)")
            if self.rpd and self._count >= self.rpd:
                raise self._quota_error(f"daily request budget of {self.rpd} used")
            while (wait := self._next_at - self._clock()) > 0:
                await self._sleep(wait)
            if abort is not None and (err := abort()) is not None:
                raise err
            self._next_at = self._clock() + (60.0 / self.rpm if self.rpm else 0.0)
            self._count += 1
            self._save()

    def backoff(self, seconds: float) -> None:
        """Server asked us to slow down: no caller starts a request for `seconds`."""
        self._next_at = max(self._next_at, self._clock() + max(0.0, seconds))

    def mark_exhausted(self) -> None:
        """The provider reported the daily quota as spent; refuse further calls until the day rolls."""
        self._roll_day()
        self._exhausted = True
        self._save()


# One limiter per provider+model per process, shared by the pipeline and (later) the chat service.
_LIMITERS: dict[str, RateLimiter] = {}


def get_limiter(key: str, rpm: int, rpd: int, state_path: str | None = None) -> RateLimiter:
    lim = _LIMITERS.get(key)
    if lim is None or (lim.rpm, lim.rpd, lim.state_path) != (max(0, rpm), max(0, rpd), state_path or None):
        lim = _LIMITERS[key] = RateLimiter(key, rpm, rpd, state_path=state_path)
    return lim


def reset_limiters() -> None:
    """Forget process-wide limiters (tests)."""
    _LIMITERS.clear()


__all__ = ["PACIFIC", "RateLimiter", "get_limiter", "reset_limiters"]
