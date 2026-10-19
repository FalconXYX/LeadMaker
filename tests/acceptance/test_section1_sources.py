"""Section 1 acceptance -- Sources & Raw Data Scope (primary and secondary sources, provenance).

Requirements (docs/OpeningRequirements.MD, Section 1):
  "Primary Source: GAF residential contractor directory (ratings, certifications, years in business,
   location, contact info, roof types)."
  "Secondary Business Sources: Contractor websites and public business listings to extract missing
   context and size-appropriate decision-makers ..."
The enricher contract (leadmaker/enrich/base.py) requires every result to carry provenance: status,
match confidence and the source URLs read; people carry their source and confidence.
"""

from __future__ import annotations

import json

import pytest

from leadmaker.enrich import REGISTRY, load_enricher_class, load_enrichers
from leadmaker.enrich.base import Enricher
from leadmaker.models import Contact, Contractor, ContractorProfile, EnrichmentStatus
from leadmaker.pipeline.enrich import EnrichOptions, run_enrich

from dbutil import cid, enrichments_by_gaf, leads_by_gaf
from fakes import FIX, FakeGaf, RoutedHttp, area_results, offline_settings, seed_area


DCWP_URL = "https://data.cityofnewyork.us/resource/w7w3-xahh.json"
DCWP_ROWS = json.loads((FIX / "nyc_dcwp_hic_sample.json").read_text())


async def test_primary_source_fields_are_stored_from_listing_and_profile(repo, scrape):
    """'GAF residential contractor directory (ratings, certifications, years in business, location,
    contact info, roof types)' all land on the contractor row after a scrape."""
    listing = area_results([3])  # Jersey Roofing LLC listing (real Coveo record) ...
    # ... plus roof types in both of GAF's specialty fields (codes as GAF serves them; the saved record has none).
    listing[0]["raw"].update(gaf_f_contractor_specialties_residential=["METAL"],
                             gaf_f_contractor_raq_specialties_residential=["SOLAR", "METAL"])
    fake = FakeGaf({"10013": listing})
    rep = await scrape(fake, postal_code="10013", radius_miles=25)
    assert rep.status == "succeeded"
    (row,) = leads_by_gaf(repo)
    assert row["name"] == "Jersey Roofing LLC"
    assert (row["rating"], row["review_count"]) == (5.0, 474)  # ratings
    assert row["tier"] == "master_elite" and "GAF Master Elite® - Certification" in row["certifications"]
    assert row["presidents_club_stars"] == 1  # President's Club award
    assert row["in_business_since"] == 2015 and row["employees_range"] == "More than 5"  # profile page
    assert (row["city"], row["state"], row["postal_code"]) == ("Garfield", "NJ", "07026")  # location
    assert row["latitude"] and row["longitude"]
    assert row["phone"] == "(201) 982-2718"  # contact info
    assert row["specialties"] == ["METAL", "SOLAR"]  # roof types, merged from both fields and de-duplicated
    assert row["raw"]["gaf_contractor_id"] == 900003  # the raw record is kept for re-parsing


@pytest.mark.parametrize("name", sorted(REGISTRY))
def test_every_registered_enricher_stamps_its_results_with_provenance(name):
    """Each registered secondary source loads, declares only registered dependencies, and every result
    constructor it uses (ok / no_match / skipped / error) names its source and carries a status and
    confidence. (What each source's real enrich() returns is covered per source in tests/test_enrich_*.py;
    persisted provenance end to end is covered below with the NYC DCWP source.)"""
    cls = load_enricher_class(name)
    assert issubclass(cls, Enricher) and cls.name == name
    assert set(cls.depends_on) <= set(REGISTRY)
    e = cls(offline_settings())
    ok = e.ok({"k": 1}, 0.87654, contacts=[Contact(name="Pat Doe", title="Owner", source=name, confidence=0.7)],
              website="https://example.com/", source_urls=["https://example.com/about"])
    assert (ok.source, ok.status, ok.confidence) == (name, EnrichmentStatus.OK, 0.877)
    assert ok.source_urls == ["https://example.com/about"] and ok.contacts[0].source == name
    nm = e.no_match(source_urls=["https://example.com/search?q=x"])
    assert (nm.source, nm.status, nm.confidence, nm.source_urls) == (
        name, EnrichmentStatus.NO_MATCH, 0.0, ["https://example.com/search?q=x"])
    sk = e.skipped("not applicable")
    assert (sk.source, sk.status, sk.data["reason"]) == (name, EnrichmentStatus.SKIPPED, "not applicable")
    er = e.error("x" * 5000)
    assert (er.source, er.status, len(er.error)) == (name, EnrichmentStatus.ERROR, 2000)
    enabled, why = e.is_enabled()
    assert enabled or why  # a disabled source always says why (e.g. a missing key)


def test_registry_loads_in_dependency_order():
    """Website discovery runs before the crawl that reads its website, and the crawl before the LLM step."""
    names = [e.name for e in load_enrichers(offline_settings())]
    assert sorted(names) == sorted(REGISTRY)
    assert names.index("website_discovery") < names.index("website_crawl") < names.index("llm_extract")


def _dcwp_http() -> RoutedHttp:
    def page(method, url, kw):
        p = kw["params"]
        off, lim = int(p["$offset"]), int(p["$limit"])
        return DCWP_ROWS[off: off + lim]

    return RoutedHttp([(DCWP_URL, page)])


def _registry_leads(repo) -> dict[str, str]:
    leads = {
        "adh": Contractor(gaf_id="1136285", name="ADH Group", city="College Point", state="NY", postal_code="11356",
                          phone="(929) 215-3378", latitude=40.783825, longitude=-73.846635,
                          profile_url="https://www.gaf.com/x/adh-1136285"),
        "sole_prop": Contractor(gaf_id="1200001", name="Top Home Improvement", city="Bronx", state="NY",
                                postal_code="10462", phone="646-641-9321", latitude=40.8431, longitude=-73.8602,
                                profile_url="https://www.gaf.com/x/top"),
        "unknown": Contractor(gaf_id="1200002", name="Zzyzx Quantum Roofworks", city="Albany", state="NY",
                              postal_code="12207", phone="(518) 000-0000", latitude=42.658, longitude=-73.747,
                              profile_url="https://www.gaf.com/x/zz"),
    }
    seed_area(repo, list(leads.values()))
    repo.save_profile(cid(repo, "1136285"), ContractorProfile(gaf_id="1136285", legal_name="Makabad Corp"))
    return {k: c.gaf_id for k, c in leads.items()}


async def test_public_listing_enricher_persists_provenance_and_contacts(repo, use_http, monkeypatch):
    """A real public-listing source (NYC DCWP licences, from the saved Socrata rows) run through the
    orchestrator: every stored result has status, match confidence, source URLs, run id and input hash;
    the person it finds is stored with its source and a confidence."""
    ids = _registry_leads(repo)
    http = use_http(_dcwp_http())
    rep = await run_enrich(offline_settings(), repo, EnrichOptions(postal_code="10013", sources=["nyc_dcwp"]))
    assert rep.status == "succeeded"
    assert all(c["url"] == DCWP_URL for c in http.calls)  # bulk-loaded once, matched in memory

    rows = {g: r["nyc_dcwp"] for g, r in enrichments_by_gaf(repo, list(ids.values())).items()}
    adh, sole, unknown = rows[ids["adh"]], rows[ids["sole_prop"]], rows[ids["unknown"]]
    assert adh["status"] == "ok" and adh["confidence"] >= 0.8
    assert adh["data"]["license_number"] == "2083986-DCA" and adh["data"]["match_method"] == "name"
    assert adh["source_urls"] == [f"{DCWP_URL}?license_nbr=2083986-DCA"]
    assert unknown["status"] == "no_match" and unknown["confidence"] == 0.0
    for r in rows.values():
        assert r["source"] == "nyc_dcwp" and r["run_id"] == rep.run_id
        assert r["fetched_at"] is not None and r["input_hash"]

    (lead,) = [l for l in repo.lead_records("10013", 25) if l["gaf_id"] == ids["sole_prop"]]
    (person,) = lead["contacts"]
    assert person["name"] == "Roberto Diaz Jr." and person["source"] == "nyc_dcwp"
    assert person["confidence"] == pytest.approx(sole["confidence"] * 0.9, abs=0.002)
