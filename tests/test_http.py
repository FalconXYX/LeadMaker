"""Offline tests for the shared HttpClient (leadmaker.http).

The network is faked at the curl_cffi AsyncSession boundary; the module's clock, sleep and jitter
are replaced by a virtual clock so backoff and politeness timing are asserted exactly and instantly.
"""

from __future__ import annotations

import asyncio
import types
from dataclasses import replace
from typing import Any, Callable

import pytest
from curl_cffi.requests.errors import RequestsError

from leadmaker import http as lhttp
from leadmaker.config import Settings
from leadmaker.http import IMPERSONATE_PROFILES, HttpClient, HttpError, Response

JITTER = 0.25


class VirtualClock:
    """time.monotonic + asyncio.sleep stand-in: sleeping advances virtual time instantly."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(round(seconds, 6))
        self.now += seconds
        await asyncio.sleep(0)  # still yield to the event loop


class FakeCurlResponse:
    def __init__(self, status: int, text: str = "", url: str = "", headers: dict[str, str] | None = None,
                 content: bytes | None = None):
        self.status_code = status
        self.text = text
        self.url = url
        self.headers = headers or {"Content-Type": "text/html"}
        self.content = content if content is not None else text.encode()


Script = Callable[[str, str, dict[str, Any]], Any]


class FakeSession:
    """Stands in for curl_cffi's AsyncSession; replies come from the test's `script`."""

    def __init__(self, script: Script, clock: VirtualClock, **init_kw: Any):
        self.script = script
        self.clock = clock
        self.init_kw = init_kw
        self.calls: list[dict[str, Any]] = []
        self.closed = False

    async def request(self, method: str, url: str, **kw: Any) -> FakeCurlResponse:
        self.calls.append({"method": method, "url": url, "at": self.clock.now, **kw})
        out = self.script(method, url, kw)
        if asyncio.iscoroutine(out):
            out = await out
        if isinstance(out, BaseException):
            raise out
        if isinstance(out, int):
            out = FakeCurlResponse(out, url=url)
        if not out.url:
            out.url = url
        return out

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> VirtualClock:
    c = VirtualClock()
    jitter_args: list[tuple[float, float]] = []

    def uniform(a: float, b: float) -> float:
        jitter_args.append((a, b))
        return JITTER

    monkeypatch.setattr(lhttp, "time", types.SimpleNamespace(monotonic=c.monotonic))
    monkeypatch.setattr(lhttp, "asyncio", types.SimpleNamespace(
        Semaphore=asyncio.Semaphore, Lock=asyncio.Lock, sleep=c.sleep))
    monkeypatch.setattr(lhttp, "random", types.SimpleNamespace(uniform=uniform))
    c.jitter_args = jitter_args  # type: ignore[attr-defined]
    return c


@pytest.fixture
def make_client(monkeypatch: pytest.MonkeyPatch, clock: VirtualClock):
    sessions: list[FakeSession] = []

    def factory(script: Script | list[Any], **settings_over: Any) -> tuple[HttpClient, list[FakeSession]]:
        if isinstance(script, list):
            queue = list(script)
            script_fn: Script = lambda m, u, kw: queue.pop(0)  # noqa: E731
        else:
            script_fn = script
        monkeypatch.setattr(lhttp, "AsyncSession", lambda **kw: sessions.append(
            FakeSession(script_fn, clock, **kw)) or sessions[-1])
        base = dict(max_retries=4, per_host_interval_s=0.5, concurrency=6, http_timeout_s=30.0)
        base.update(settings_over)
        return HttpClient(replace(Settings(), **base)), sessions

    return factory


def impersonations(session: FakeSession) -> list[str]:
    return [c["impersonate"] for c in session.calls]


# --------------------------------------------------------------------------- Response / HttpError


def test_response_ok_json_and_content():
    r = Response(url="https://a.com/x", status=200, text='{"rows": [1, 2]}', headers={})
    assert r.ok and r.json() == {"rows": [1, 2]} and r.content == b""
    assert [Response("u", s, "", {}).ok for s in (199, 200, 204, 299, 300, 404)] == [
        False, True, True, True, False, False]
    with pytest.raises(ValueError):
        Response("u", 200, "<html>", {}).json()


def test_http_error_carries_status_and_url():
    e = HttpError("HTTP 503 for https://a.com/", status=503, url="https://a.com/")
    assert str(e) == "HTTP 503 for https://a.com/" and e.status == 503 and e.url == "https://a.com/"
    assert HttpError("network").status is None


# --------------------------------------------------------------------------- session lifecycle


async def test_request_outside_context_manager_raises(make_client):
    client, _ = make_client([200])
    with pytest.raises(RuntimeError, match="async context manager"):
        await client.get("https://a.com/")


async def test_context_manager_opens_impersonating_session_and_closes_it(make_client):
    client, sessions = make_client([200], http_timeout_s=12.0)
    async with client as c:
        assert c is client
        assert sessions[0].init_kw == {"impersonate": IMPERSONATE_PROFILES[0], "timeout": 12.0}
    assert sessions[0].closed and client._session is None
    await client.__aexit__(None, None, None)  # closing twice is harmless


# --------------------------------------------------------------------------- happy path / pass-through


async def test_success_returns_final_url_headers_text_and_bytes(make_client, clock):
    body = b"\x1f\x8b\x08\x00binary"
    reply = FakeCurlResponse(200, text='{"ok": true}', url="https://www.a.com/final",
                             headers={"Content-Type": "application/json"}, content=body)
    client, sessions = make_client([reply])
    async with client:
        r = await client.get("https://a.com/start", headers={"Accept": "application/json"}, params={"q": "x"})
    assert (r.url, r.status, r.headers, r.content) == (
        "https://www.a.com/final", 200, {"Content-Type": "application/json"}, body)
    assert r.json() == {"ok": True}
    call = sessions[0].calls[0]
    assert call["method"] == "GET" and call["url"] == "https://a.com/start"
    assert call["headers"] == {"Accept": "application/json"} and call["params"] == {"q": "x"}
    assert call["json"] is None and call["data"] is None
    assert call["impersonate"] == "chrome" and call["timeout"] == 30.0 and call["allow_redirects"] is True
    assert client.stats == {"requests": 1, "retries": 0, "failures": 0}
    assert clock.sleeps == []


async def test_post_sends_body_and_per_call_timeout(make_client):
    client, sessions = make_client([201])
    async with client:
        r = await client.post("https://api.a.com/v1", json={"k": 1}, data=None, timeout=7.5)
    assert r.status == 201
    call = sessions[0].calls[0]
    assert call["method"] == "POST" and call["json"] == {"k": 1} and call["timeout"] == 7.5


# --------------------------------------------------------------------------- status handling


async def test_non_retryable_status_raises_immediately(make_client, clock):
    client, sessions = make_client([404, 200])
    async with client:
        with pytest.raises(HttpError) as ei:
            await client.get("https://a.com/missing")
    assert ei.value.status == 404 and ei.value.url == "https://a.com/missing"
    assert len(sessions[0].calls) == 1 and clock.sleeps == []
    assert client.stats["requests"] == 1 and client.stats["retries"] == 0


@pytest.mark.parametrize("status", [404, 503])
async def test_allowed_statuses_are_returned_without_retry(make_client, clock, status: int):
    client, sessions = make_client([status, 200])
    async with client:
        r = await client.get("https://a.com/x", allow_statuses=(404, 503))
    assert r.status == status and not r.ok
    assert len(sessions[0].calls) == 1 and clock.sleeps == []


async def test_501_is_not_retried_but_502_is(make_client):
    client, sessions = make_client([501, 502, 200])
    async with client:
        with pytest.raises(HttpError, match="HTTP 501"):
            await client.get("https://a.com/x")
        assert (await client.get("https://b.com/y")).status == 200
    assert [c["url"] for c in sessions[0].calls] == ["https://a.com/x", "https://b.com/y", "https://b.com/y"]


# --------------------------------------------------------------------------- retries / backoff


async def test_retryable_statuses_back_off_exponentially_with_jitter(make_client, clock):
    client, sessions = make_client([503, 429, 502, 200])
    async with client:
        r = await client.get("https://a.com/x")
    assert r.status == 200 and len(sessions[0].calls) == 4
    assert clock.sleeps == [1.0 + JITTER, 2.0 + JITTER, 4.0 + JITTER]
    assert clock.jitter_args == [(0, 0.5)] * 3  # type: ignore[attr-defined]
    assert client.stats == {"requests": 4, "retries": 3, "failures": 0}


async def test_backoff_is_capped_at_30s_and_last_error_is_raised(make_client, clock):
    client, sessions = make_client(lambda m, u, kw: 500)
    async with client:
        with pytest.raises(HttpError) as ei:
            await client.get("https://a.com/x", retries=7)
    assert ei.value.status == 500 and len(sessions[0].calls) == 8
    assert clock.sleeps == [b + JITTER for b in (1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0)]
    assert client.stats == {"requests": 8, "retries": 7, "failures": 1}


async def test_default_retry_budget_comes_from_settings(make_client):
    client, sessions = make_client(lambda m, u, kw: 503, max_retries=2)
    async with client:
        with pytest.raises(HttpError):
            await client.get("https://a.com/x")
        with pytest.raises(HttpError):
            await client.get("https://a.com/y", retries=0)
    urls = [c["url"] for c in sessions[0].calls]
    assert urls.count("https://a.com/x") == 3 and urls.count("https://a.com/y") == 1


async def test_network_errors_are_retried_then_wrapped(make_client, clock):
    client, sessions = make_client([RequestsError("Connection reset by peer"), 200])
    async with client:
        assert (await client.get("https://a.com/x")).status == 200
    assert clock.sleeps == [1.0 + JITTER]

    client2, _ = make_client(lambda m, u, kw: RequestsError("Could not resolve host: nope.invalid"))
    async with client2:
        with pytest.raises(HttpError) as ei:
            await client2.get("https://nope.invalid/", retries=1)
    assert ei.value.status is None and ei.value.url == "https://nope.invalid/"
    assert "network error" in str(ei.value) and "Could not resolve host" in str(ei.value)
    assert client2.stats == {"requests": 2, "retries": 1, "failures": 1}


# --------------------------------------------------------------------------- fingerprint rotation


async def test_403_rotates_impersonation_profile_and_rotation_persists(make_client):
    client, sessions = make_client([403, 403, 200, 200])
    async with client:
        assert (await client.get("https://www.gaf.com/a")).status == 200
        await client.get("https://www.gaf.com/b")
    assert impersonations(sessions[0]) == ["chrome", "chrome131", "safari", "safari"]


async def test_rate_limits_do_not_rotate_profile(make_client):
    client, sessions = make_client([429, 503, 200])
    async with client:
        await client.get("https://a.com/x")
    assert impersonations(sessions[0]) == ["chrome"] * 3


async def test_profile_rotation_wraps_around(make_client):
    client, sessions = make_client(lambda m, u, kw: 403)
    async with client:
        with pytest.raises(HttpError) as ei:
            await client.get("https://a.com/x", retries=4)
    assert ei.value.status == 403
    assert impersonations(sessions[0]) == ["chrome", "chrome131", "safari", "edge", "chrome"]


# --------------------------------------------------------------------------- politeness


async def test_same_host_requests_keep_the_minimum_interval(make_client, clock):
    client, sessions = make_client(lambda m, u, kw: 200, per_host_interval_s=0.5)
    async with client:
        await client.get("https://a.com/1")
        await client.get("https://A.COM/2")  # host match is case-insensitive
        await client.get("https://b.com/1")  # other hosts are not delayed
    assert clock.sleeps == [0.5]
    assert [c["at"] for c in sessions[0].calls] == [1000.0, 1000.5, 1000.5]


async def test_host_interval_override_applies_to_that_host_only(make_client, clock):
    client, _ = make_client(lambda m, u, kw: 200, per_host_interval_s=0.5)
    client.set_host_interval("web.archive.org", 1.5)
    async with client:
        await client.get("https://web.archive.org/cdx/search/cdx")
        await client.get("https://web.archive.org/cdx/search/cdx")
        await client.get("https://a.com/")
        await client.get("https://a.com/")
    assert clock.sleeps == [1.5, 0.5]


async def test_concurrent_requests_to_one_host_are_spaced_out(make_client):
    client, sessions = make_client(lambda m, u, kw: 200, per_host_interval_s=2.0)
    async with client:
        await asyncio.gather(*(client.get(f"https://a.com/{i}") for i in range(3)))
    assert sorted(c["at"] for c in sessions[0].calls) == [1000.0, 1002.0, 1004.0]


async def test_retry_waits_for_both_backoff_and_host_interval(make_client, clock):
    client, _ = make_client([503, 200], per_host_interval_s=5.0)
    async with client:
        await client.get("https://a.com/x")
    # 1.25 s backoff, then the remaining 3.75 s of the host's 5 s spacing
    assert clock.sleeps == [1.0 + JITTER, 5.0 - (1.0 + JITTER)]


async def test_global_concurrency_cap(make_client):
    in_flight = 0
    peak = 0

    async def slow(method: str, url: str, kw: dict[str, Any]) -> int:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        for _ in range(5):
            await asyncio.sleep(0)
        in_flight -= 1
        return 200

    client, sessions = make_client(slow, concurrency=2)
    async with client:
        rs = await asyncio.gather(*(client.get(f"https://h{i}.com/") for i in range(6)))
    assert [r.status for r in rs] == [200] * 6
    assert peak == 2 and len(sessions[0].calls) == 6


async def test_concurrency_setting_below_one_still_allows_requests_one_at_a_time(make_client):
    in_flight = 0
    peak = 0

    async def slow(method: str, url: str, kw: dict[str, Any]) -> int:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        for _ in range(3):
            await asyncio.sleep(0)
        in_flight -= 1
        return 200

    client, sessions = make_client(slow, concurrency=0)
    async with client:
        # a zero-permit semaphore would block forever: bound the wait so a regression fails, not hangs
        rs = await asyncio.wait_for(asyncio.gather(*(client.get(f"https://h{i}.com/") for i in range(3))), 2.0)
    assert [r.status for r in rs] == [200] * 3
    assert peak == 1 and len(sessions[0].calls) == 3
