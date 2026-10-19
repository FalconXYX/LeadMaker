"""Audit logging (Section 1: 'all additions, updates and tags are logged') and incremental re-runs."""

from pathlib import Path


from leadmaker.config import Settings
from leadmaker.enrich.base import Enricher
from leadmaker.models import Contact, SearchArea, SearchHit
from leadmaker.pipeline import enrich as enrich_mod
from leadmaker.pipeline.enrich import EnrichOptions, run_enrich
from leadmaker.sources.gaf.parse import parse_profile_html

from dbutil import cid
from fakes import fixture_contractors

FIX = Path(__file__).parent / "fixtures"
AREA = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7185, longitude=-74.0025)


def _events(repo, **kw):
    return list(reversed(repo.audit_log(limit=10_000, **kw)))


def test_contractor_created_and_field_level_updates(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs, run_id=1)
    created = [e for e in _events(repo) if e["entity_type"] == "company"]
    assert len(created) == len(cs) and all(e["action"] == "created" for e in created)
    assert all(e["actor_type"] == "pipeline" and e["entity_id"] == e["company_id"] for e in created)
    assert {e["changes"]["gaf_id"][1] for e in created} == {c.gaf_id for c in cs}

    cs[0].review_count += 5
    cs[0].tier = cs[0].tier  # unchanged
    repo.upsert_contractors(cs, run_id=2)
    upd = _events(repo, run_id=2)
    assert len(upd) == 1 and upd[0]["action"] == "updated"
    assert upd[0]["company_id"] == cid(repo, cs[0].gaf_id)
    assert set(upd[0]["changes"]) == {"review_count"}

    repo.upsert_contractors(cs, run_id=3)  # no change -> no events
    assert _events(repo, run_id=3) == []


def test_profile_and_reviews_audited(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    p = parse_profile_html((FIX / "gaf_profile_master_elite.html").read_text(), cs[0].gaf_id)
    company = cid(repo, cs[0].gaf_id)
    repo.save_profile(company, p, run_id=7)
    kinds = {(e["entity_type"], e["action"]) for e in _events(repo, run_id=7)}
    assert ("profile", "created") in kinds and ("reviews", "created") in kinds
    repo.save_profile(company, p, run_id=8)  # identical -> nothing logged
    assert _events(repo, run_id=8) == []
    p.employees_range = "More than 50"
    repo.save_profile(company, p, run_id=9)
    ev = _events(repo, run_id=9)
    assert ev[0]["changes"]["employees_range"] == ["More than 5", "More than 50"]


def test_tags_and_delisting_audited(repo):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    company = cid(repo, cs[0].gaf_id)
    repo.save_tags(company, [{"key": "gaf_tier", "value": "certified"}], "growth", 50.0, run_id=101)
    repo.save_tags(company, [{"key": "gaf_tier", "value": "master_elite"}], "strategic", 80.0, run_id=102)
    ch = _events(repo, run_id=102)[0]["changes"]
    assert ch["segment"] == ["growth", "strategic"]
    assert ch["tags_added"][1] == ["gaf_tier=master_elite"] and ch["tags_removed"][0] == ["gaf_tier=certified"]

    r1 = repo.start_run("gaf_ingest", {})
    repo.record_search_hits(r1, AREA, [SearchHit(company_id=cid(repo, c.gaf_id), distance_miles=1.0, rank=i + 1)
                                       for i, c in enumerate(cs)])
    assert repo.record_delisted(r1, AREA, [c.gaf_id for c in cs]) == []  # first run: nothing to compare
    r2 = repo.start_run("gaf_ingest", {})
    gone = repo.record_delisted(r2, AREA, [c.gaf_id for c in cs[1:]])
    assert gone == [company]
    assert _events(repo, run_id=r2)[0]["action"] == "delisted"


class CountingEnricher(Enricher):
    name = "osm"
    calls = 0

    async def enrich(self, ctx, http):
        CountingEnricher.calls += 1
        return self.ok({"seen_name": ctx.get("legal_name")}, 0.8,
                       contacts=[Contact(name="Alex Boss", title="Owner", source="osm")])


async def test_input_change_reruns_inside_ttl_and_logs(repo, monkeypatch):
    cs = fixture_contractors()
    repo.upsert_contractors(cs)
    run = repo.start_run("gaf_ingest", {})
    repo.record_search_hits(run, AREA, [SearchHit(company_id=cid(repo, c.gaf_id), distance_miles=1.0, rank=i + 1)
                                        for i, c in enumerate(cs)])
    monkeypatch.setattr(enrich_mod, "load_enrichers", lambda s, names=None: [CountingEnricher(s)])
    settings = Settings(database_url="sqlite://", concurrency=2)
    CountingEnricher.calls = 0

    await run_enrich(settings, repo, EnrichOptions())
    assert CountingEnricher.calls == len(cs)
    assert sum(1 for e in _events(repo) if e["entity_type"] == "contact") == len(cs)

    await run_enrich(settings, repo, EnrichOptions())  # nothing changed -> all fresh
    assert CountingEnricher.calls == len(cs)

    # A newly learned legal name changes the enricher's inputs -> re-run just that contractor.
    p = parse_profile_html((FIX / "gaf_profile_master_elite.html").read_text(), cs[0].gaf_id)
    repo.save_profile(cid(repo, cs[0].gaf_id), p)
    report = await run_enrich(settings, repo, EnrichOptions())
    assert CountingEnricher.calls == len(cs) + 1
    assert report.stats["by_source"]["osm"]["input_changed"] == 1
    upd = [e for e in _events(repo) if e["entity_type"] == "enrichment" and e["action"] == "updated"]
    assert upd and upd[-1]["changes"]["data_keys_changed"][1] == ["seen_name"]
