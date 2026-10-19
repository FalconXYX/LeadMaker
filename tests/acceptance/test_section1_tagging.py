"""Section 1 acceptance -- Tagging & Categorization Logic.

Requirements (docs/OpeningRequirements.MD, Section 1):
  "Structured Tagging: Maps raw fields into filterable tags (GAF Master Elite status, rating tiers,
   years in business)."
  "Service & Material Tagging: Extracts roof material specialties (metal, asphalt shingles, flat/TPO) and
   work types (new construction vs. storm/emergency repair)."
  (Custom User Tagging is covered in test_section1_customization.py.)
Every tag must be explainable: it carries a reason and a source.
"""

from __future__ import annotations

import json

from leadmaker.models import ContractorProfile
from leadmaker.pipeline.enrich import EnrichOptions, run_enrich
from leadmaker.pipeline.tag import run_tagging
from leadmaker.tagging.rules import CURRENT_YEAR

from dbutil import cid
from fakes import FIX, PagesSource, RoutedHttp, offline_settings, seed_area


JERSEY, HAYDEN, GOLOVIN, GEMZ = "1141159", "61620", "7158181", "7158488"
SNIPPETS = json.loads((FIX / "website_crawl_service_snippets.json").read_text())["snippets"]
STORM_PAGE = {
    "url": "https://golovinroofing.example/services",
    "title": "Services",
    "text": "We install metal roofing and asphalt shingles. 24/7 emergency storm damage repair and insurance "
            "claims help for homeowners across Queens.",
}


def _page(i: int) -> dict:
    s = SNIPPETS[i]
    return {"url": s["url"], "title": "", "text": s["text"]}


async def _tagged(repo, use_http, use_enrichers) -> dict[str, dict[str, dict]]:
    seed_area(repo)
    repo.save_profile(cid(repo, JERSEY),
                      ContractorProfile(gaf_id=JERSEY, in_business_since=2015, employees_range="More than 5"))
    PagesSource.pages = {
        JERSEY: [_page(0)],  # real commercial-roofing page: TPO membranes
        HAYDEN: [_page(7)],  # real page: new construction
        GOLOVIN: [STORM_PAGE],
    }
    use_http(RoutedHttp([]))
    use_enrichers(PagesSource)
    await run_enrich(offline_settings(), repo, EnrichOptions(postal_code="10013"))
    out = run_tagging(repo, "10013", 25)
    assert out["failed"] == 0 and out["tagged"] == 6
    return {r["gaf_id"]: {t["key"]: t for t in r["tags"]} for r in repo.get_companies()}


async def test_structured_fields_map_to_filterable_tags(repo, use_http, use_enrichers):
    """'GAF Master Elite status, rating tiers, years in business' become tags with stable keys/values."""
    tags = await _tagged(repo, use_http, use_enrichers)
    j = tags[JERSEY]
    assert (j["gaf_tier"]["value"], j["gaf_tier"]["label"]) == ("master_elite", "GAF Master Elite")
    assert j["reputation"]["value"] == "excellent" and j["review_volume"]["value"] == "very_high"
    age = CURRENT_YEAR - 2015
    assert j["maturity"]["value"] == ("established" if age < 25 else "veteran")
    assert "since 2015 (per gaf)" in j["maturity"]["reason"]
    assert j["presidents_club"]["value"] >= 1
    h = tags[HAYDEN]
    assert h["gaf_tier"]["value"] == "certified" and h["reputation"]["value"] == "good"  # 5.0 on 7 reviews
    assert h["review_volume"]["value"] == "low" and "maturity" not in h  # no founding year known
    assert tags[GEMZ]["review_volume"]["value"] == "none" and "reputation" not in tags[GEMZ]


async def test_materials_and_work_types_come_from_website_text(repo, use_http, use_enrichers):
    """Roof materials (metal, asphalt shingles, flat/TPO) and work types (new construction vs storm /
    emergency repair) are tagged from the crawled site text, with the evidence named in the reason."""
    tags = await _tagged(repo, use_http, use_enrichers)

    tpo = tags[JERSEY]
    assert {"service:tpo_roofing", "service:single_ply_roofing", "service:flat_roofing"} <= set(tpo)
    assert tpo["focus"]["value"] == "residential_and_commercial"
    assert "work_type:new_construction" not in tpo and "work_type:storm_emergency" not in tpo

    build = tags[HAYDEN]
    assert build["service:new_construction"]["source"] == "website"
    assert build["work_type:new_construction"]["category"] == "work_type"
    assert "new_construction found" in build["work_type:new_construction"]["reason"]
    assert "work_type:storm_emergency" not in build

    storm = tags[GOLOVIN]
    assert {"service:metal_roofing", "service:shingle_roofing", "service:storm_damage",
            "service:emergency_service", "service:insurance_claims"} <= set(storm)
    assert storm["storm_insurance"]["value"] is True and storm["premium_materials"]["value"] is True
    assert "storm_damage" in storm["work_type:storm_emergency"]["reason"]
    assert "work_type:new_construction" not in storm

    assert not [k for k in tags[GEMZ] if k.startswith(("service:", "work_type:"))]  # no site, no claims


async def test_every_tag_has_a_reason_and_a_source(repo, use_http, use_enrichers):
    """Every generated tag on every lead says why (reason) and where it came from (source)."""
    tags = await _tagged(repo, use_http, use_enrichers)
    for gid, by_key in tags.items():
        for key, t in by_key.items():
            assert t.get("reason") and str(t["reason"]).strip(), (gid, key)
            assert t.get("source") and str(t["source"]).strip(), (gid, key)
            assert t.get("label") and t.get("category"), (gid, key)
        assert {"gaf_tier", "review_volume", "decision_maker", "target_contact", "priority_drivers"} <= set(by_key)
    rows = repo.get_companies()
    assert all(0 <= r["priority_score"] <= 100 and r["segment"] for r in rows)
    jersey = next(r for r in rows if r["gaf_id"] == JERSEY)
    assert jersey["segment"] == "strategic"  # Master Elite
