"""Storage idempotency + enrichment orchestration, offline (SQLite in a temp dir, fake enrichers)."""

from pathlib import Path

import pytest

from leadmaker.config import Settings
from leadmaker.db import Repository
from leadmaker.enrich import topo_order
from leadmaker.enrich.base import Enricher, LeadContext
from leadmaker.models import Contact, SearchArea, SearchHit
from leadmaker.pipeline import enrich as enrich_mod
from leadmaker.pipeline.enrich import EnrichOptions, run_enrich
from leadmaker.pipeline.tag import run_tagging
from leadmaker.sources.gaf.parse import parse_profile_html

from dbutil import cid, cids
from fakes import fixture_contractors

FIX = Path(__file__).parent / "fixtures"
AREA = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7185, longitude=-74.0025)


@pytest.fixture
def repo(tmp_path):
    r = Repository(f"sqlite:///{tmp_path / 'test.db'}")
    r.ensure_schema()  # idempotent
    return r


def _seed(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    run_id = repo.start_run("gaf_ingest", {})
    repo.record_search_hits(
        run_id, AREA, [SearchHit(company_id=cid(repo, c.gaf_id), distance_miles=float(i), rank=i + 1)
                       for i, c in enumerate(cs)]
    )
    repo.finish_run(run_id, "succeeded", {})
    return cs


def test_upsert_is_idempotent_and_detects_changes(repo):
    cs = fixture_contractors()
    assert repo.upsert_contractors(cs) == {"new": len(cs), "changed": 0, "unchanged": 0}
    assert repo.upsert_contractors(cs) == {"new": 0, "changed": 0, "unchanged": len(cs)}
    first = repo.get_companies([cid(repo, cs[0].gaf_id)])[0]
    assert first["gaf_id"] == cs[0].gaf_id and first["name"] == cs[0].name
    cs[0].review_count += 10
    assert repo.upsert_contractors(cs)["changed"] == 1
    after = repo.get_companies([cid(repo, cs[0].gaf_id)])[0]
    assert after["review_count"] == first["review_count"] + 10
    assert after["first_seen_at"] == first["first_seen_at"]
    assert after["content_hash"] != first["content_hash"]
    assert after["company_id"] == first["company_id"]  # same GAF id -> same company


def test_profile_and_reviews_dedupe(repo):
    _seed(repo)
    p = parse_profile_html((FIX / "gaf_profile_master_elite.html").read_text(), fixture_contractors()[0].gaf_id)
    company = cid(repo, p.gaf_id)
    repo.save_profile(company, p)
    repo.save_profile(company, p)  # same reviews again -> no duplicates
    assert repo.summary()["reviews"] == 3
    assert repo.profiles_due([company], ttl_hours=24) == []
    assert repo.profiles_due([company], ttl_hours=24, force=True) == [company]


def test_area_ordering_and_lead_records(repo):
    cs = _seed(repo)
    assert repo.area_company_ids("10013", 25) == cids(repo, [c.gaf_id for c in cs])
    leads = repo.lead_records("10013", 25)
    assert [l["gaf_id"] for l in leads] == [c.gaf_id for c in cs]
    assert [l["company_id"] for l in leads] == cids(repo, [c.gaf_id for c in cs])
    assert "distance_miles" in leads[0] and "raw" not in leads[0]


class FakeWebsite(Enricher):
    name = "website_discovery"

    async def enrich(self, ctx, http):
        if ctx.get("state") == "NJ":
            return self.ok({"website": "https://example-nj.com"}, 0.9, website="https://example-nj.com")
        return self.no_match()


class FakeCrawl(Enricher):
    name = "website_crawl"
    depends_on = ("website_discovery",)
    calls = 0

    def applies_to(self, ctx: LeadContext) -> bool:
        return ctx.best_website() is not None

    async def enrich(self, ctx, http):
        FakeCrawl.calls += 1
        return self.ok(
            {"emails": ["owner@example-nj.com"]}, 0.9,
            contacts=[Contact(name="Pat Owner", title="Owner", source="website", confidence=0.6)],
        )


class Boom(Enricher):
    name = "osm"

    async def enrich(self, ctx, http):
        raise RuntimeError("source down")


def test_topo_order_respects_dependencies():
    order = topo_order({"website_crawl": FakeCrawl, "website_discovery": FakeWebsite, "osm": Boom})
    assert order.index("website_discovery") < order.index("website_crawl")


async def test_enrich_orchestration(repo, monkeypatch):
    cs = _seed(repo)
    settings = Settings(database_url="sqlite://", concurrency=2)
    monkeypatch.setattr(
        enrich_mod, "load_enrichers", lambda s, names=None: [Boom(s), FakeWebsite(s), FakeCrawl(s)]
    )
    FakeCrawl.calls = 0
    report = await run_enrich(settings, repo, EnrichOptions(postal_code="10013", radius_miles=25))
    n_nj = sum(1 for c in cs if c.state == "NJ")
    assert report.status == "partial"  # Boom errors are recorded, not fatal
    by = report.stats["by_source"]
    assert by["osm"]["error"] == len(cs)
    assert by["website_discovery"]["ok"] == n_nj
    assert by["website_crawl"]["ok"] == n_nj and by["website_crawl"]["skipped"] == len(cs) - n_nj
    nj = next(c for c in cs if c.state == "NJ")
    row = repo.get_companies([cid(repo, nj.gaf_id)])[0]
    assert row["website"] == "https://example-nj.com" and row["website_source"] == "website_discovery"
    assert repo.summary()["contacts"] == n_nj

    # Second run: fresh results are reused (TTL), errors are retried.
    report2 = await run_enrich(settings, repo, EnrichOptions(postal_code="10013", radius_miles=25))
    assert FakeCrawl.calls == n_nj
    assert report2.stats["by_source"]["website_crawl"].get("fresh") == len(cs)
    assert report2.stats["by_source"]["osm"]["error"] == len(cs)


def test_tagging_runs_over_leads(repo):
    _seed(repo)
    out = run_tagging(repo, "10013", 25)
    assert out["failed"] == 0 and out["tagged"] == len(fixture_contractors())
    row = repo.get_companies()[0]
    assert row["tags"] and row["segment"] and row["priority_score"] is not None
