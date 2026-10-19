"""Section 1 acceptance -- Contact Discovery and size-appropriate decision-makers.

Requirements (docs/OpeningRequirements.MD, Section 1):
  "Secondary Business Sources: ... size-appropriate decision-makers (e.g., Owner/Boss for smaller shops vs.
   Office/Purchasing Manager for larger companies), defaulting to the owner when no other decision-maker
   can be found."
  "Contact Discovery: Better Business Bureau profiles supply owner and manager names and titles ..."
"""

from __future__ import annotations

from leadmaker.enrich.bbb import parse_profile
from leadmaker.models import Contact, ContractorProfile
from leadmaker.pipeline.enrich import EnrichOptions, run_enrich
from leadmaker.pipeline.tag import run_tagging

from dbutil import cid, leads_by_gaf
from fakes import FIX, PeopleSource, RoutedHttp, offline_settings, seed_area


HAYDEN, JERSEY, GOLOVIN, GEMZ = "61620", "1141159", "7158181", "7158488"


def _bbb_people(fixture: str) -> list[Contact]:
    """Names and titles from a real BBB profile page, mapped the way BbbEnricher maps them."""
    p = parse_profile((FIX / fixture).read_text())
    assert p is not None
    url = "https://www.bbb.org/us/nj/x/profile/roofing-contractors/high-caliber"
    return [Contact(name=x["name"], title=x["title"], source="bbb", source_url=url, confidence=0.81)
            for x in p["people"]]


def _target(repo, gaf_id):
    tags = {t["key"]: t for t in leads_by_gaf(repo, [gaf_id])[0]["tags"]}
    return tags["target_contact"], tags["decision_maker"]


async def test_target_contact_follows_company_size_with_owner_fallback(repo, use_http, use_enrichers):
    """Small shop -> the owner; larger company -> the office/purchasing manager; nobody credible found ->
    the Owner role on the company's main line; each choice states why."""
    seed_area(repo)
    repo.save_profile(cid(repo, HAYDEN), ContractorProfile(gaf_id=HAYDEN, employees_range="1-5"))  # small shop
    owner_and_manager = _bbb_people("bbb_profile_high_caliber.html")  # Owner + Manager (real BBB page)
    assert [(c.name, c.title) for c in owner_and_manager] == [("Mary Cuppari", "Owner"), ("Frank Cuppari", "Manager")]
    office = Contact(name="Dana Ledger", title="Office Manager", source="bbb", confidence=0.81)
    PeopleSource.people = {
        HAYDEN: [*owner_and_manager, office],  # small: owner wins over the office manager
        JERSEY: [*owner_and_manager, office],  # 474 reviews -> large: the office manager wins
        GEMZ: [Contact(name="Sam Maybe", title="Owner", source="website", confidence=0.3)],  # too shaky to target
    }
    use_http(RoutedHttp([]))
    use_enrichers(PeopleSource)
    rep = await run_enrich(offline_settings(), repo, EnrichOptions(postal_code="10013"))
    assert rep.stats["by_source"]["bbb"] == {"ok": 3, "no_match": 3}
    run_tagging(repo, "10013", 25)

    small, small_dm = _target(repo, HAYDEN)
    assert small["contact"]["size"] == "small" and small["value"] == "owner"
    assert small["contact"]["name"] == "Mary Cuppari" and small["contact"]["source"] == "bbb"
    assert small_dm["value"] == "identified" and "size=small → owner" in small["reason"]

    large, large_dm = _target(repo, JERSEY)
    assert large["contact"]["size"] == "large" and large["value"] == "office"
    assert large["contact"]["name"] == "Dana Ledger" and large["contact"]["phone"] == "(201) 982-2718"
    assert large["contact"]["phone_is_main_line"] is True
    assert large_dm["value"] == "identified" and "purchasing/office" in large["reason"]

    nobody, nobody_dm = _target(repo, GOLOVIN)
    assert nobody["value"] == "owner" and nobody["contact"]["name"] is None
    assert nobody["contact"]["fallback"] is True and nobody["contact"]["phone"] == "(959) 237-0800"
    assert nobody_dm["value"] == "none" and "ask for the Owner" in nobody["reason"]

    shaky, shaky_dm = _target(repo, GEMZ)
    assert shaky["contact"]["fallback"] is True and shaky["contact"]["name"] is None
    assert shaky["contact"]["hint"]["name"] == "Sam Maybe" and shaky_dm["value"] == "weak"


async def test_discovered_people_keep_source_title_and_confidence(repo, use_http, use_enrichers):
    """BBB-supplied owner and manager names and titles are stored per company with source and confidence,
    and re-discovering the same person does not duplicate them."""
    seed_area(repo)
    PeopleSource.people = {HAYDEN: _bbb_people("bbb_profile_high_caliber.html")}
    use_http(RoutedHttp([]))
    use_enrichers(PeopleSource)
    await run_enrich(offline_settings(), repo, EnrichOptions(postal_code="10013"))
    await run_enrich(offline_settings(), repo, EnrichOptions(postal_code="10013", force=True))

    (lead,) = [l for l in repo.lead_records("10013", 25) if l["gaf_id"] == HAYDEN]
    people = sorted((c["name"], c["title"], c["source"], c["confidence"], c["source_url"]) for c in lead["contacts"])
    url = "https://www.bbb.org/us/nj/x/profile/roofing-contractors/high-caliber"
    assert people == [("Frank Cuppari", "Manager", "bbb", 0.81, url), ("Mary Cuppari", "Owner", "bbb", 0.81, url)]
    assert repo.summary()["contacts"] == 2
