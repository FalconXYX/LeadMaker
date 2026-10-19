"""Section 1 acceptance -- Incremental Updates.

Requirement (docs/OpeningRequirements.MD, Section 1):
  "Avoids re-scraping or re-computing from scratch; only new or changed records, records past their
   source's refresh window, and records affected by newly added parameters are processed to save compute."
Mechanics: GAF profiles have a TTL; each enrichment has a TTL plus an input hash of everything it read;
errors are always retried; a quota skip never replaces a good earlier result.
"""

from __future__ import annotations

from collections import Counter
from datetime import timedelta

from sqlalchemy import update

from leadmaker.db.repository import as_utc, utcnow
from leadmaker.db.schema import companies, enrichments
from leadmaker.enrich.base import Enricher
from leadmaker.pipeline.enrich import EnrichOptions, run_enrich

from dbutil import cid, enrichments_by_gaf, leads_by_gaf
from fakes import CountingSource, FakeGaf, PeopleSource, RoutedHttp, area_results, gid, offline_settings



async def test_rescrape_skips_unchanged_listings_and_fresh_profiles(repo, scrape):
    """Unchanged listings are not rewritten and profiles inside their refresh window are not re-fetched;
    a profile past its window, or a changed listing, is."""
    fake = FakeGaf({"10013": area_results(range(4))})
    first = await scrape(fake, postal_code="10013", radius_miles=25)
    assert first.stats["upsert"]["new"] == 4 and first.stats["profiles"]["fetched"] == 4

    again = await scrape(fake, postal_code="10013", radius_miles=25)
    assert again.stats["upsert"] == {"new": 0, "changed": 0, "unchanged": 4}
    assert again.stats["profiles"] == {"due": 0, "fetched": 0, "failed": 0, "skipped_fresh": 4}
    assert len(fake.profile_gets) == 4  # no new profile requests

    with repo.engine.begin() as conn:  # one profile is now 8 days old (TTL 7 days)
        conn.execute(update(companies).where(companies.c.id == cid(repo, gid(2)))
                     .values(profile_scraped_at=utcnow() - timedelta(days=8)))
    fake.areas["10013"] = area_results(range(4))
    fake.areas["10013"][0]["raw"]["gaf_number_of_reviews"] = 99  # one listing changed
    third = await scrape(fake, postal_code="10013", radius_miles=25)
    assert third.stats["upsert"] == {"new": 0, "changed": 1, "unchanged": 3}
    assert third.stats["profiles"]["fetched"] == 1 and len(fake.profile_gets) == 5
    refreshed = as_utc(leads_by_gaf(repo, [gid(2)])[0]["profile_scraped_at"])
    assert refreshed > utcnow() - timedelta(minutes=1)  # the stale one is the one re-fetched

    forced = await scrape(fake, postal_code="10013", radius_miles=25, force_profiles=True)
    assert forced.stats["profiles"]["fetched"] == 4


async def test_enrichment_reruns_only_changed_stale_failed_or_new_work(repo, scrape, use_http, use_enrichers):
    """Fresh enrichments with unchanged inputs are skipped; a changed input (new phone), a result past the
    source's refresh window, and every error are re-run; a newly added source runs alone."""
    fake = FakeGaf({"10013": area_results(range(5))})
    await scrape(fake, postal_code="10013", radius_miles=25, fetch_profiles=False)
    settings = offline_settings()
    use_enrichers(CountingSource)
    CountingSource.fail_ids = {gid(4)}

    r1 = await run_enrich(settings, repo, EnrichOptions())
    assert r1.stats["by_source"]["osm"] == {"ok": 4, "error": 1} and r1.status == "partial"

    CountingSource.calls = []
    r2 = await run_enrich(settings, repo, EnrichOptions())
    assert r2.stats["by_source"]["osm"] == {"fresh": 4, "error": 1}
    assert CountingSource.calls == [gid(4)]  # only the error was retried

    # A listing change (new phone) for one contractor and an expired result for another.
    fake.areas["10013"][1]["raw"]["gaf_phone"] = "(201) 555-0199"
    await scrape(fake, postal_code="10013", radius_miles=25, fetch_profiles=False)
    with repo.engine.begin() as conn:
        conn.execute(update(enrichments).where(enrichments.c.company_id == cid(repo, gid(3)),
                                               enrichments.c.source == "osm")
                     .values(fetched_at=utcnow() - timedelta(days=31)))
    CountingSource.fail_ids = set()
    CountingSource.calls = []
    r3 = await run_enrich(settings, repo, EnrichOptions())
    assert sorted(CountingSource.calls) == [gid(1), gid(3), gid(4)]
    assert r3.stats["by_source"]["osm"] == {"fresh": 2, "input_changed": 1, "ok": 3}
    stored = enrichments_by_gaf(repo, [gid(1)])[gid(1)]["osm"]
    assert stored["data"]["seen_phone"] == "(201) 555-0199"

    # A newly added source: only it runs; the existing source stays fresh.
    use_enrichers(CountingSource, PeopleSource)
    CountingSource.calls = []
    r4 = await run_enrich(settings, repo, EnrichOptions())
    assert CountingSource.calls == []
    assert r4.stats["by_source"] == {"osm": {"fresh": 5}, "bbb": {"no_match": 5}}

    # force re-runs everything.
    r5 = await run_enrich(settings, repo, EnrichOptions(sources=["osm"], force=True))
    assert Counter(CountingSource.calls) == Counter(gid(i) for i in range(5))
    assert r5.stats["by_source"]["osm"]["ok"] == 5


class QuotaLimited(Enricher):
    """Behaves like llm_extract on a spent free tier: SKIPPED with retry=True."""

    name = "llm_extract"
    spent = False

    async def enrich(self, ctx, http):
        if QuotaLimited.spent:
            r = self.skipped("quota")
            r.data["retry"] = True
            return r
        return self.ok({"summary": f"summary for {ctx.gaf_id}"}, 0.9)

    def input_hash(self, ctx):
        return f"{super().input_hash(ctx)}:{'spent' if QuotaLimited.spent else 'open'}"  # forces a re-check


async def test_quota_skip_never_replaces_a_good_earlier_result(repo, scrape, use_http, use_enrichers):
    """A run that cannot call the model (quota spent) defers instead of wiping the stored good result."""
    await scrape(FakeGaf({"10013": area_results(range(2))}), postal_code="10013", radius_miles=25,
                 fetch_profiles=False)
    use_http(RoutedHttp([]))
    use_enrichers(QuotaLimited)
    QuotaLimited.spent = False
    await run_enrich(offline_settings(), repo, EnrichOptions())
    QuotaLimited.spent = True
    try:
        rep = await run_enrich(offline_settings(), repo, EnrichOptions())
    finally:
        QuotaLimited.spent = False
    assert rep.stats["by_source"]["llm_extract"] == {"input_changed": 2, "deferred": 2}
    for g in (gid(0), gid(1)):
        row = enrichments_by_gaf(repo, [g])[g]["llm_extract"]
        assert row["status"] == "ok" and row["data"]["summary"] == f"summary for {g}"
