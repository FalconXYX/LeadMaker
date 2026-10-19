"""Shared plumbing for the opt-in live drift checks (`pytest -m live`).

The default run excludes them (pyproject addopts = -m "not live"). Each live test
sends a few polite requests through the production HttpClient and runs the real
parsers on the response, so a format change at a source fails here, loudly, instead
of silently emptying a column in the next pipeline run.

Politeness rules enforced for every test in this package:
  * max_retries=1 and >= 1 s between requests to the same host, kept across tests
    (the per-host clock is shared by every client this package creates);
  * at most MAX_REQUESTS_PER_TEST logical requests per test, and at most MAX_REQUESTS_TOTAL
    HTTP attempts (retries included) per session -- exceeding either fails the test before
    the request is sent;
  * a per-source ledger (method, host, status, size, attempts) is printed in the terminal summary.
"""

from __future__ import annotations

import dataclasses
import time
from collections import defaultdict
from typing import Any
from urllib.parse import urlsplit

import pytest

from leadmaker.config import Settings
from leadmaker.http import HttpClient, HttpError, Response

MAX_REQUESTS_PER_TEST = 3
MAX_REQUESTS_TOTAL = 25
HOST_INTERVAL_S = 1.0


@dataclasses.dataclass
class Call:
    test: str
    method: str
    host: str
    status: int | str
    bytes: int
    seconds: float
    attempts: int = 0  # HTTP attempts actually sent, including the one allowed retry
    headers: dict[str, str] = dataclasses.field(default_factory=dict, repr=False)  # as sent by the caller
    response: Response | None = dataclasses.field(default=None, repr=False)  # raw reply, for envelope checks


LEDGER: list[Call] = []
NOTES: dict[str, list[str]] = defaultdict(list)  # test -> observed facts (counts, names) for the summary
# host -> earliest monotonic time of the next request; shared so spacing survives across tests.
_SHARED_HOST_CLOCK: dict[str, float] = {}


class LiveHttp(HttpClient):
    """HttpClient with a request budget and a ledger; behaviour is otherwise the production client's."""

    def __init__(self, settings: Settings, test_id: str):
        super().__init__(settings)
        self._host_next_at = _SHARED_HOST_CLOCK
        self.test_id = test_id
        self.calls: list[Call] = []

    async def request(self, method: str, url: str, **kw: Any) -> Response:
        if len(self.calls) >= MAX_REQUESTS_PER_TEST:
            raise AssertionError(f"live test exceeded its budget of {MAX_REQUESTS_PER_TEST} requests: {url}")
        if sum(c.attempts for c in LEDGER) >= MAX_REQUESTS_TOTAL:
            raise AssertionError(f"live suite exceeded its budget of {MAX_REQUESTS_TOTAL} requests: {url}")
        call = Call(self.test_id, method, urlsplit(url).netloc.lower(), "?", 0, 0.0,
                    headers=dict(kw.get("headers") or {}))
        self.calls.append(call)
        LEDGER.append(call)
        started, sent_before = time.monotonic(), self.stats["requests"]
        try:
            resp = await super().request(method, url, **kw)
        except HttpError as e:
            call.status = e.status or "network-error"
            raise
        finally:
            call.seconds = time.monotonic() - started
            call.attempts = self.stats["requests"] - sent_before
        call.status, call.bytes, call.response = resp.status, len(resp.content or b""), resp
        return resp


@pytest.fixture
def live_settings(tmp_path) -> Settings:
    """Production settings (env included, so LEADMAKER_CONTACT reaches NWS) with polite overrides."""
    base = Settings()
    return dataclasses.replace(
        base,
        max_retries=1,
        per_host_interval_s=max(HOST_INTERVAL_S, base.per_host_interval_s),
        concurrency=2,
        http_timeout_s=max(60.0, base.http_timeout_s),
        cache_dir=str(tmp_path / "cache"),
        llm_usage_file="",
    )


@pytest.fixture
async def http(live_settings, request):
    async with LiveHttp(live_settings, request.node.name) as client:
        yield client


@pytest.fixture
def note(request):
    """note("totalCount=424") -- record an observed fact; printed under the test in the summary."""
    return lambda text: NOTES[request.node.name].append(str(text))


@pytest.fixture(scope="session")
def memo() -> dict[str, Any]:
    """Results one live test can hand to the next (Coveo config, a profile URL) to save requests."""
    return {}


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    if not LEDGER:
        return
    tr = terminalreporter
    attempts = sum(c.attempts for c in LEDGER)
    tr.write_sep("-", f"live requests: {len(LEDGER)}, HTTP attempts incl. retries: {attempts} "
                      f"(budget {MAX_REQUESTS_TOTAL})")
    by_test: dict[str, list[Call]] = defaultdict(list)
    for c in LEDGER:
        by_test[c.test].append(c)
    for test, calls in by_test.items():
        parts = ", ".join(
            f"{c.method} {c.host} -> {c.status} ({c.bytes:,} B, {c.seconds:.1f}s"
            f"{f', {c.attempts} attempts' if c.attempts > 1 else ''})" for c in calls
        )
        tr.write_line(f"{test}: {parts}")
        if NOTES.get(test):
            tr.write_line(f"    observed: {'; '.join(NOTES[test])}")
