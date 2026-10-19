"""Shared fakes for the tests, mainly the Section 1 acceptance tests (tests/acceptance) and tests/pg.

Everything here stands in for the network only: the real pipeline functions (run_scrape,
run_enrich, run_tagging, run_signals, JobQueue/work) run unchanged against a temp SQLite DB.
Responses are built from the saved real fixtures in tests/fixtures/.
"""

from __future__ import annotations

import asyncio
import copy
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from leadmaker.config import Settings
from leadmaker.enrich.base import Enricher, LeadContext
from leadmaker.http import HttpError, Response
from leadmaker.models import Contact, Contractor, SearchArea, SearchHit
from leadmaker.sources.gaf.client import LISTING_URL
from leadmaker.sources.gaf.parse import parse_coveo_result

from dbutil import cid

FIX = Path(__file__).resolve().parent / "fixtures"
EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
COVEO = json.loads((FIX / "coveo_search_response.json").read_text())
PROFILE_HTML = (FIX / "gaf_profile_master_elite.html").read_text()

# Fake ZIP centroids served by the zippopotam stand-in (any US ZIP the tests use).
CENTROIDS: dict[str, tuple[float, float]] = {
    "10013": (40.7185, -74.0025),
    "07030": (40.745, -74.032),
    "11550": (40.6843, -73.6152),
}
LLM_HOSTS = ("generativelanguage.googleapis.com", "api.anthropic.com", "localhost:11434")


def offline_settings(**kw: Any) -> Settings:
    """Settings with every key, limit and env-dependent knob pinned (no network, no LLM unless asked)."""
    base: dict[str, Any] = dict(
        database_url="sqlite://", google_maps_api_key=None, anthropic_api_key=None, socrata_app_token=None,
        llm_provider_setting="auto", gemini_api_key=None, llm_model_override=None, llm_base_url=None,
        llm_api_key=None, llm_rpm=0, llm_rpd=0, llm_usage_file="", extraction_slots_path=None,
        http_timeout_s=5.0, max_retries=0, per_host_interval_s=0.0, concurrency=2,
        profile_ttl_hours=24 * 7, enrichment_ttl_hours=24 * 30, user_agent_contact="LeadMaker tests",
    )
    base.update(kw)
    return Settings(**base)


# ------------------------------------------------------------------------------- GAF / Coveo
def coveo_result(i: int, distance: float, **raw: Any) -> dict[str, Any]:
    """A real Coveo result (cycled from the fixture) re-keyed to GAF id 900000+i at `distance` miles."""
    r = copy.deepcopy(COVEO["results"][i % len(COVEO["results"])])
    r["raw"]["gaf_contractor_id"] = 900000 + i
    r["raw"]["distanceinmiles"] = distance
    r["raw"].update(raw)
    return r


def area_results(ids: range | list[int], first_distance: float = 0.5, step: float = 1.25) -> list[dict[str, Any]]:
    """Distance-sorted results for an area: contractor 900000+i for each i, nearest first."""
    return [coveo_result(i, round(first_distance + n * step, 3)) for n, i in enumerate(ids)]


def gid(i: int) -> str:
    return str(900000 + i)


def fixture_contractors() -> list[Contractor]:
    """The 6 real Coveo results as fresh Contractors (raw payloads copied, so tests may mutate them)."""
    return [parse_coveo_result(copy.deepcopy(r)) for r in COVEO["results"]]


def seed_area(repo: Any, contractors: list[Contractor] | None = None, postal_code: str = "10013",
              radius: float = 25) -> list[Contractor]:
    """Store contractors plus one completed area read for them (distance = rank miles)."""
    cs = contractors if contractors is not None else fixture_contractors()
    repo.upsert_contractors(cs)
    lat, lng = CENTROIDS.get(postal_code, (40.7, -74.0))
    area = SearchArea(postal_code=postal_code, radius_miles=radius, latitude=lat, longitude=lng)
    run = repo.start_run("gaf_ingest", {})
    repo.record_search_hits(run, area, [SearchHit(company_id=cid(repo, c.gaf_id), distance_miles=float(i + 1),
                                                  rank=i + 1) for i, c in enumerate(cs)])
    repo.finish_run(run, "succeeded", {})
    return cs


_DIST_FN = re.compile(r"dist\([^,]+,\s*[^,]+,\s*(-?[\d.]+),\s*(-?[\d.]+)\)")


class FakeGaf:
    """HttpClient stand-in for a GAF scrape: zippopotam geocoding, the listing page (down, so the
    built-in Coveo config is used), Coveo search pages per area, and profile pages.

    `areas` maps a ZIP to its distance-sorted Coveo results; the area is recognised from the
    origin coordinates inside the Coveo query, exactly as Coveo itself would see it.
    """

    def __init__(self, areas: dict[str, list[dict[str, Any]]], totals: dict[str, int] | None = None,
                 recommended: int = 2, profile_html: str = PROFILE_HTML):
        self.areas = areas
        self.totals = totals or {}
        self.recommended = recommended
        self.profile_html = profile_html
        self.searches: list[dict[str, Any]] = []
        self.profile_gets: list[str] = []
        self.calls: list[tuple[str, str]] = []
        self.intervals: dict[str, float] = {}
        self.stats = {"requests": 0, "retries": 0, "failures": 0}

    async def __aenter__(self) -> "FakeGaf":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    def _area_for(self, body: dict[str, Any]) -> str:
        m = _DIST_FN.search(body["queryFunctions"][0]["function"])
        assert m, body
        lat, lng = float(m.group(1)), float(m.group(2))
        for z, (zlat, zlng) in CENTROIDS.items():
            if abs(zlat - lat) < 1e-6 and abs(zlng - lng) < 1e-6:
                return z
        raise AssertionError(f"no fake area at {lat},{lng}")

    async def get(self, url: str, params: dict[str, Any] | None = None, **kw: Any) -> Response:
        self.stats["requests"] += 1
        self.calls.append(("GET", url))
        if url.startswith("https://api.zippopotam.us/"):
            z = url.rsplit("/", 1)[1]
            if z not in CENTROIDS:
                return Response(url=url, status=404, text="{}", headers={})
            lat, lng = CENTROIDS[z]
            body = {"places": [{"latitude": str(lat), "longitude": str(lng)}]}
            return Response(url=url, status=200, text=json.dumps(body), headers={})
        if url == LISTING_URL:
            raise HttpError("listing page offline", status=503, url=url)
        if url.startswith(LISTING_URL + "/"):
            self.profile_gets.append(url)
            return Response(url=url, status=200, text=self.profile_html, headers={})
        raise AssertionError(f"unexpected GET {url}")

    async def post(self, url: str, json: dict[str, Any] | None = None, **kw: Any) -> Response:  # noqa: A002
        self.stats["requests"] += 1
        self.calls.append(("POST", url))
        assert json is not None
        z = self._area_for(json)
        items = self.areas[z]
        if "sortCriteria" not in json:  # GAF's own "Most Relevant" ranking request
            page = items[: self.recommended]
        else:
            self.searches.append({"area": z, **json})
            page = items[json["firstResult"]: json["firstResult"] + json["numberOfResults"]]
        body = dict(COVEO, totalCount=self.totals.get(z, len(items)), results=page)
        return Response(url=url, status=200, text=_dumps(body), headers={})


def _dumps(obj: Any) -> str:
    return json.dumps(obj)


# -------------------------------------------------------------------------- generic routing
class RoutedHttp:
    """HttpClient stand-in that routes by URL prefix and records every call.

    routes: [(url_prefix, handler(method, url, kwargs) -> Response | text | dict)]. An unrouted
    URL raises AssertionError, so a test notices any request it did not plan for.
    """

    def __init__(self, routes: list[tuple[str, Callable[..., Any]]]):
        self.routes = routes
        self.calls: list[dict[str, Any]] = []
        self.intervals: dict[str, float] = {}
        self.stats = {"requests": 0, "retries": 0, "failures": 0}

    def __call__(self, settings: Any = None) -> "RoutedHttp":  # usable as a HttpClient(settings) factory
        return self

    async def __aenter__(self) -> "RoutedHttp":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    async def request(self, method: str, url: str, **kw: Any) -> Response:
        self.stats["requests"] += 1
        self.calls.append({"method": method, "url": url, **kw})
        for prefix, handler in self.routes:
            if url.startswith(prefix):
                out = handler(method, url, kw)
                if isinstance(out, Response):
                    return out
                text = out if isinstance(out, str) else json.dumps(out)
                return Response(url=url, status=200, text=text, headers={}, content=text.encode())
        raise AssertionError(f"unexpected {method} {url}")

    async def get(self, url: str, **kw: Any) -> Response:
        return await self.request("GET", url, **kw)

    async def post(self, url: str, **kw: Any) -> Response:
        return await self.request("POST", url, **kw)

    def hosts(self) -> set[str]:
        return {c["url"].split("/")[2] for c in self.calls}


# ----------------------------------------------------------------------------- fake enrichers
class PeopleSource(Enricher):
    """A BBB-like secondary source: returns the named people configured per GAF id."""

    name = "bbb"
    people: dict[str, list[Contact]] = {}

    async def enrich(self, ctx: LeadContext, http: Any):
        found = self.people.get(ctx.gaf_id)
        url = f"https://www.bbb.org/profile/{ctx.gaf_id}"
        if not found:
            return self.no_match(source_urls=[url])
        return self.ok({"people": [c.model_dump() for c in found]}, 0.9, contacts=found, source_urls=[url])


class PagesSource(Enricher):
    """A website_crawl stand-in: stores the page text configured per GAF id (tagging re-scans it)."""

    name = "website_crawl"
    pages: dict[str, list[dict[str, Any]]] = {}

    async def enrich(self, ctx: LeadContext, http: Any):
        pages = self.pages.get(ctx.gaf_id)
        if not pages:
            return self.no_match()
        site = "https://" + pages[0]["url"].split("/")[2] + "/"
        return self.ok({"pages": pages, "services": []}, 0.85, website=site,
                       source_urls=[p["url"] for p in pages])


class CountingSource(Enricher):
    """Reads the contractor's identity fields; counts calls; can be told to fail for some ids."""

    name = "osm"
    calls: list[str] = []
    fail_ids: set[str] = set()

    async def enrich(self, ctx: LeadContext, http: Any):
        CountingSource.calls.append(ctx.gaf_id)
        if ctx.gaf_id in self.fail_ids:
            raise RuntimeError("overpass timeout")
        return self.ok({"seen_name": ctx.names()[0], "seen_phone": ctx.get("phone")}, 0.8,
                       source_urls=[f"https://www.openstreetmap.org/search?q={ctx.gaf_id}"])


def fresh_class_state() -> None:
    PeopleSource.people = {}
    PagesSource.pages = {}
    CountingSource.calls = []
    CountingSource.fail_ids = set()


# --------------------------------------------------------------------- HttpClient transport
class FakeClock:
    """Virtual monotonic time for HttpClient: sleep() advances it instead of waiting."""

    def __init__(self, start: float = 1000.0):
        self.t = start
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(round(seconds, 6))
        self.t += max(0.0, seconds)
        await asyncio.sleep(0)  # still yield, so concurrent requests interleave


class FakeTransportResponse:
    def __init__(self, url: str, status: int, text: str):
        self.url, self.status_code, self.text = url, status, text
        self.headers = {"content-type": "application/json"}
        self.content = text.encode()


class FakeAsyncSession:
    """Replaces curl_cffi's AsyncSession: records (virtual time, method, url) and answers from a script."""

    log: list[tuple[float, str, str]] = []
    script: dict[str, list[int]] = {}  # url -> statuses to return in order (then 200)
    clock: FakeClock | None = None

    def __init__(self, **kw: Any):
        self.kw = kw

    async def close(self) -> None:
        return None

    async def request(self, method: str, url: str, **kw: Any) -> FakeTransportResponse:
        assert FakeAsyncSession.clock is not None
        FakeAsyncSession.log.append((FakeAsyncSession.clock.t, method, url))
        queue = FakeAsyncSession.script.get(url) or []
        status = queue.pop(0) if queue else 200
        return FakeTransportResponse(url, status, json.dumps({"ok": status == 200}))
