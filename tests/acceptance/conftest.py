"""Fixtures for the Section 1 acceptance tests: a temp SQLite DB, pinned settings, and helpers that
drive the real pipeline entry points with the network faked out."""

from __future__ import annotations

import shutil
from typing import Any

import pytest

from leadmaker.llm.ratelimit import reset_limiters
from leadmaker.pipeline import enrich as enrich_mod
from leadmaker.pipeline import scrape as scrape_mod
from leadmaker.pipeline import signals as signals_mod
from leadmaker.pipeline.scrape import ScrapeOptions, ScrapeReport, run_scrape
from leadmaker.signals import counties

from fakes import FIX, FakeGaf, fresh_class_state, offline_settings

ENV_KNOBS = (
    "LEADMAKER_TAG_RULES", "LEADMAKER_USER_JOBS_PER_HOUR", "LEADMAKER_EXTRACTION_SLOTS", "GEMINI_API_KEY",
    "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "LEADMAKER_LLM_PROVIDER", "LEADMAKER_LLM_BASE_URL",
    "BRAVE_SEARCH_API_KEY", "SERPAPI_KEY",  # read by website_discovery directly, not via Settings
)


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    """No env knob from the developer's shell leaks in; process-wide limiters and fake state reset."""
    for k in ENV_KNOBS:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("LEADMAKER_CACHE_DIR", str(tmp_path / "cache"))
    reset_limiters()
    fresh_class_state()
    yield
    reset_limiters()
    fresh_class_state()


@pytest.fixture
def settings():
    return offline_settings()


@pytest.fixture
def use_http(monkeypatch):
    """Route every pipeline stage's HttpClient(settings) to one fake."""

    def install(fake: Any) -> Any:
        factory = fake if callable(fake) and not isinstance(fake, FakeGaf) else (lambda s: fake)
        monkeypatch.setattr(scrape_mod, "HttpClient", factory)
        monkeypatch.setattr(enrich_mod, "HttpClient", factory)
        monkeypatch.setattr(signals_mod, "HttpClient", factory)
        return fake

    return install


@pytest.fixture
def zcta_cache(tmp_path):
    """The Census ZCTA-to-county file, already cached (trimmed fixture rows), as after a first download."""
    cache = tmp_path / "cache"
    cache.mkdir(exist_ok=True)
    shutil.copy(FIX / "zcta_county_sample.txt", cache / counties.REL_FILE)
    return cache


@pytest.fixture
def scrape(repo, settings, use_http):
    """await scrape(fake, postal_code=..., radius_miles=..., **opts) -> ScrapeReport via run_scrape."""

    async def go(fake: FakeGaf, **opts: Any) -> ScrapeReport:
        use_http(fake)
        return await run_scrape(settings, repo, ScrapeOptions(**opts))

    return go


@pytest.fixture
def use_enrichers(monkeypatch):
    """Make run_enrich load exactly these enricher classes (instantiated with the run's settings)."""

    def install(*classes: type) -> None:
        monkeypatch.setattr(enrich_mod, "load_enrichers", lambda s, names=None: [c(s) for c in classes])

    return install
