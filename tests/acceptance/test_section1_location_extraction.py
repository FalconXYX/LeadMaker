"""Section 1 acceptance -- Location-Based Extraction.

Requirement (docs/OpeningRequirements.MD, Section 1):
  "Given a location and radius, the system collects all roofing contractors, extracts their details,
   generates tags and notes, and triggers AI summaries."
Plus Section 2's "overlapping radius searches do not cause data desync" and the build checklist's
completeness guard ("don't mark leads delisted after a cut-short read").
"""

from __future__ import annotations

from sqlalchemy import inspect, select

from leadmaker.db.schema import companies, search_hits
from leadmaker.pipeline.tag import run_tagging

from dbutil import gaf_ids, leads_by_gaf, with_gaf
from fakes import CENTROIDS, FakeGaf, area_results, gid



def _hits(repo, run_id):
    with repo.engine.connect() as conn:
        return with_gaf(repo, [dict(r._mapping) for r in conn.execute(
            select(search_hits).where(search_hits.c.run_id == run_id).order_by(search_hits.c.rank))])


async def test_any_zip_and_radius_collects_contractors_with_query_relative_distance(repo, scrape):
    """'Given a location and radius, the system collects all roofing contractors, extracts their details':
    a ZIP never seen before is geocoded, Coveo is queried around that point for that radius, every
    contractor is stored, and distance/rank live on the per-query search hit, not the contractor."""
    fake = FakeGaf({"07030": area_results(range(5), first_distance=0.8, step=2.0)})
    rep = await scrape(fake, postal_code="07030", radius_miles=10)

    assert rep.status == "succeeded"
    assert rep.area.geocoder == "zippopotam"
    assert (rep.area.latitude, rep.area.longitude) == CENTROIDS["07030"]
    body = fake.searches[0]
    assert "<= 10" in body["aq"] and body["sortCriteria"].endswith("ascending")
    assert f"{CENTROIDS['07030'][0]}, {CENTROIDS['07030'][1]}" in body["queryFunctions"][0]["function"]

    hits = _hits(repo, rep.run_id)
    assert [h["gaf_id"] for h in hits] == [gid(i) for i in range(5)]
    assert [h["distance_miles"] for h in hits] == [0.8, 2.8, 4.8, 6.8, 8.8]
    assert [h["rank"] for h in hits] == [1, 2, 3, 4, 5]
    assert {(h["postal_code"], h["radius_miles"]) for h in hits} == {("07030", 10)}
    assert [h["gaf_recommended_rank"] for h in hits] == [1, 2, None, None, None]
    assert "distance_miles" not in {c["name"] for c in inspect(repo.engine).get_columns("companies")}

    # Details: the listing plus the profile page of every contractor.
    assert rep.stats["profiles"] == {"due": 5, "fetched": 5, "failed": 0, "skipped_fresh": 0}
    assert len(fake.profile_gets) == 5
    rows = {r["gaf_id"]: r for r in leads_by_gaf(repo)}
    assert len(rows) == 5
    for r in rows.values():
        assert r["profile_scraped_at"] is not None and r["profile_error"] is None
        assert r["legal_name"] == "Makabad Corp" and r["in_business_since"] == 2015
        assert r["employees_range"] == "More than 5"
    assert repo.summary()["reviews"] == 3 * 5  # the profile's reviews, per contractor

    # ... and tags + notes (tag reasons) for the area's leads.
    out = run_tagging(repo, "07030", 10)
    assert out["tagged"] == 5 and out["failed"] == 0
    leads = repo.lead_records("07030", 10)
    assert [l["distance_miles"] for l in leads] == [0.8, 2.8, 4.8, 6.8, 8.8]
    for lead in leads:
        band = next(t for t in lead["tags"] if t["key"] == "distance_band")
        assert band["reason"] == f"{lead['distance_miles']:.1f} mi from search origin"


async def test_overlapping_areas_keep_one_record_per_gaf_id_and_their_own_distances(repo, scrape):
    """Overlapping radius searches never duplicate a contractor: one company per GAF id, while each
    area keeps its own distance to that contractor."""
    nyc = area_results(range(0, 6), first_distance=1.0, step=1.0)  # 900000..900005
    hob = area_results(range(3, 9), first_distance=0.5, step=0.5)  # 900003..900008 (3 shared)
    fake = FakeGaf({"10013": nyc, "07030": hob})
    first = await scrape(fake, postal_code="10013", radius_miles=25, fetch_profiles=False)
    second = await scrape(fake, postal_code="07030", radius_miles=10, fetch_profiles=False)

    assert first.stats["upsert"] == {"new": 6, "changed": 0, "unchanged": 0}
    assert second.stats["upsert"] == {"new": 3, "changed": 0, "unchanged": 3}
    with repo.engine.connect() as conn:
        company_ids = conn.execute(select(companies.c.id)).scalars().all()
    ids = gaf_ids(repo, company_ids)
    assert len(ids) == len(company_ids) and sorted(ids) == sorted(gid(i) for i in range(9))
    created = with_gaf(repo, [e for e in repo.audit_log(limit=1000)
                               if e["entity_type"] == "company" and e["action"] == "created"])
    assert sorted(e["gaf_id"] for e in created) == sorted(ids)  # one creation per contractor, ever

    by_area = {
        z: {l["gaf_id"]: l["distance_miles"] for l in repo.lead_records(z, r)}
        for z, r in (("10013", 25), ("07030", 10))
    }
    assert by_area["10013"][gid(4)] == 5.0 and by_area["07030"][gid(4)] == 1.0
    assert len(by_area["10013"]) == 6 and len(by_area["07030"]) == 6
    # Neither area's read delisted the other's contractors.
    assert first.stats["delisted"] == 0 and second.stats["delisted"] == 0


async def test_contractors_are_delisted_only_after_a_complete_read(repo, scrape):
    """Delisting needs a COMPLETE area read: a cut-short read logs nothing as delisted and keeps the area's
    lead list; the next complete read delists exactly the contractors that are gone."""
    full = area_results(range(6))
    fake = FakeGaf({"10013": full})
    base = await scrape(fake, postal_code="10013", radius_miles=25, fetch_profiles=False)
    assert base.status == "succeeded" and base.stats["completeness"]["complete"] is True

    fake.areas["10013"], fake.totals["10013"] = full[:3], 6  # Coveo stops early: 3 of the 6 it reports
    short = await scrape(fake, postal_code="10013", radius_miles=25, fetch_profiles=False)
    assert short.status == "partial" and short.stats["completeness"]["reason"] == "count_mismatch"
    assert short.stats["delisted"] is None
    assert [e for e in repo.audit_log(limit=1000) if e["action"] == "delisted"] == []
    assert len(gaf_ids(repo, repo.area_company_ids("10013", 25))) == 6

    fake.areas["10013"], fake.totals = full[:5], {}  # complete read; one contractor really left
    done = await scrape(fake, postal_code="10013", radius_miles=25, fetch_profiles=False)
    assert done.status == "succeeded" and done.stats["delisted"] == 1
    (ev,) = with_gaf(repo, [e for e in repo.audit_log(limit=1000) if e["action"] == "delisted"])
    assert ev["gaf_id"] == gid(5) and ev["run_id"] == done.run_id
    assert ev["changes"]["previous_run"][0] == base.run_id  # compared against the last complete read
    assert gaf_ids(repo, repo.area_company_ids("10013", 25)) == [gid(i) for i in range(5)]
    assert len(leads_by_gaf(repo, [gid(5)])) == 1  # history is kept; the row is not deleted
