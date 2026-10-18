"""Shared async HTTP client.

One client per pipeline run. It provides:
  * browser TLS/HTTP2 fingerprint impersonation (curl_cffi) -- gaf.com sits behind
    Akamai Bot Manager, which rejects plain python clients and headless Chromium;
  * a global concurrency cap plus a per-host minimum interval (politeness);
  * retries with exponential backoff + jitter on 403/429/5xx/network errors,
    rotating the impersonation profile after a 403.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from curl_cffi.requests import AsyncSession
from curl_cffi.requests.errors import RequestsError

from .config import Settings

log = logging.getLogger(__name__)

IMPERSONATE_PROFILES = ("chrome", "chrome131", "safari", "edge")
RETRY_STATUSES = {403, 408, 425, 429, 500, 502, 503, 504}


@dataclass
class Response:
    url: str
    status: int
    text: str
    headers: dict[str, str]
    content: bytes = b""

    def json(self) -> Any:
        import json

        return json.loads(self.text)

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class HttpError(Exception):
    def __init__(self, message: str, status: int | None = None, url: str | None = None):
        super().__init__(message)
        self.status = status
        self.url = url


class HttpClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._sem = asyncio.Semaphore(max(1, settings.concurrency))
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._host_next_at: dict[str, float] = {}
        self._host_interval: dict[str, float] = {}
        self._profile_idx = 0
        self._session: AsyncSession | None = None
        self.stats = {"requests": 0, "retries": 0, "failures": 0}

    async def __aenter__(self) -> "HttpClient":
        self._session = AsyncSession(impersonate=IMPERSONATE_PROFILES[0], timeout=self.settings.http_timeout_s)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    def set_host_interval(self, host: str, seconds: float) -> None:
        """Override politeness interval for one host (e.g. slower for gaf.com)."""
        self._host_interval[host] = seconds

    async def _wait_for_host(self, host: str) -> None:
        lock = self._host_locks.setdefault(host, asyncio.Lock())
        interval = self._host_interval.get(host, self.settings.per_host_interval_s)
        async with lock:
            now = time.monotonic()
            next_at = self._host_next_at.get(host, 0.0)
            if next_at > now:
                await asyncio.sleep(next_at - now)
            self._host_next_at[host] = time.monotonic() + interval

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json: Any = None,
        data: Any = None,
        params: dict[str, Any] | None = None,
        retries: int | None = None,
        allow_statuses: tuple[int, ...] = (),
        timeout: float | None = None,
    ) -> Response:
        """Perform a request with retries. Statuses in allow_statuses are returned, not raised."""
        if self._session is None:
            raise RuntimeError("HttpClient must be used as an async context manager")
        host = urlsplit(url).netloc.lower()
        max_retries = self.settings.max_retries if retries is None else retries
        attempt = 0
        last_err: Exception | None = None
        while True:
            await self._wait_for_host(host)
            profile = IMPERSONATE_PROFILES[self._profile_idx % len(IMPERSONATE_PROFILES)]
            try:
                async with self._sem:
                    self.stats["requests"] += 1
                    r = await self._session.request(
                        method,
                        url,
                        headers=headers,
                        json=json,
                        data=data,
                        params=params,
                        impersonate=profile,
                        timeout=timeout or self.settings.http_timeout_s,
                        allow_redirects=True,
                    )
                resp = Response(url=str(r.url), status=r.status_code, text=r.text, headers=dict(r.headers),
                                content=r.content)
                if resp.ok or resp.status in allow_statuses:
                    return resp
                last_err = HttpError(f"HTTP {resp.status} for {url}", status=resp.status, url=url)
                if resp.status not in RETRY_STATUSES:
                    raise last_err
                if resp.status == 403:
                    # Bot-manager rejection: switch fingerprint before retrying.
                    self._profile_idx += 1
            except RequestsError as e:  # network-level failure (DNS, TLS, timeout, reset)
                last_err = HttpError(f"network error for {url}: {e}", url=url)
            if attempt >= max_retries:
                self.stats["failures"] += 1
                assert last_err is not None
                raise last_err
            attempt += 1
            self.stats["retries"] += 1
            delay = min(30.0, (2**attempt) * 0.5) + random.uniform(0, 0.5)
            log.debug("retry %d/%d for %s in %.1fs (%s)", attempt, max_retries, url, delay, last_err)
            await asyncio.sleep(delay)

    async def get(self, url: str, **kw: Any) -> Response:
        return await self.request("GET", url, **kw)

    async def post(self, url: str, **kw: Any) -> Response:
        return await self.request("POST", url, **kw)
