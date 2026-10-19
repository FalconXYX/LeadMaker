import json
from pathlib import Path

from leadmaker.models import Tier
from leadmaker.sources.gaf.parse import (
    CoveoConfig,
    looks_blocked,
    parse_coveo_result,
    parse_listing_config,
    parse_profile_html,
    presidents_club_stars,
    street_from_address,
    tier_from_codes,
)

FIX = Path(__file__).parent / "fixtures"


def _results():
    return json.loads((FIX / "coveo_search_response.json").read_text())["results"]


def test_listing_config_discovered_from_page():
    cfg = parse_listing_config((FIX / "gaf_listing.html").read_text())
    assert cfg is not None and cfg.discovered
    assert cfg.organization_id == "gafmaterialscorporationproduction3yalqk12"
    assert cfg.search_hub == "prod-gaf-recommended-residential-contractors"
    assert cfg.api_key.startswith("xx")
    assert cfg.fields["latitudeField"] == "gaf_latitude"
    assert cfg.fields["distanceInMiles"] == "distanceinmiles"
    assert cfg.recommended_context == {"sortingStrategy": "gafrecommended-initial"}
    assert cfg.endpoint == "https://gafmaterialscorporationproduction3yalqk12.org.coveo.com/rest/search/v2"


def test_listing_config_missing_returns_none():
    assert parse_listing_config("<html><body>nothing</body></html>") is None
    assert CoveoConfig.default().discovered is False


def test_parse_coveo_results_all_fixtures():
    contractors = [parse_coveo_result(r) for r in _results()]
    assert len({c.gaf_id for c in contractors}) == len(contractors)
    for c in contractors:
        assert c.gaf_id.isdigit()
        assert c.name
        assert c.profile_url.startswith("https://www.gaf.com/en-us/roofing-contractors/")
        assert c.country == "USA"


def test_parse_master_elite_with_place_id_and_presidents_club():
    jersey = next(parse_coveo_result(r) for r in _results() if r["raw"]["gaf_contractor_id"] == "1141159")
    assert jersey.name == "Jersey Roofing LLC"
    assert jersey.tier == Tier.MASTER_ELITE
    assert jersey.presidents_club_stars == 1
    assert jersey.gaf_leads_enrolled is True
    assert jersey.google_place_id
    assert jersey.rating == 5.0 and jersey.review_count == 474
    assert jersey.street == "411 River Dr"
    assert jersey.image_url and jersey.image_url.startswith("https://")


def test_zero_reviews_means_no_rating_and_placeholder_image_dropped():
    gemz = next(parse_coveo_result(r) for r in _results() if r["raw"]["gaf_contractor_id"] == "7158488")
    assert gemz.review_count == 0 and gemz.rating is None
    assert gemz.image_url is None
    assert gemz.tier == Tier.CERTIFIED
    assert gemz.street == "133-38 Denis St"


def test_tier_and_stars_helpers():
    assert tier_from_codes(["CERTIFIED^_^RESIDENTIAL^_^C", "MASTER_ELITE^_^RESIDENTIAL^_^C"]) == Tier.MASTER_ELITE
    assert tier_from_codes(["CERTIFIED_PLUS^_^Residential^_^C"]) == Tier.CERTIFIED_PLUS
    assert tier_from_codes(["GAF Leads^_^RESIDENTIAL^_^P"]) == Tier.NONE
    assert presidents_club_stars({}, ["President’s Club 2 Star^_^RESIDENTIAL^_^A"]) == 2
    assert presidents_club_stars({"gaf_residential_presidents_club_stars_count": 3}, []) == 3


def test_street_from_address_variants():
    assert street_from_address("4266 Kissena Blvd Ste 3 Flushing, NY 11355", "Flushing", "NY", "11355") == (
        "4266 Kissena Blvd Ste 3"
    )
    assert street_from_address("1 Main St, Springfield, NJ 07081", None, None, None) == "1 Main St"
    assert street_from_address(None, "X", "NY", "1") is None


def test_profile_master_elite():
    p = parse_profile_html((FIX / "gaf_profile_master_elite.html").read_text(), "1136285")
    assert p.legal_name == "Makabad Corp"  # listed as "ADH Group" on GAF
    assert p.in_business_since == 2015
    assert p.employees_range == "More than 5"
    assert p.distinctions == ["GAF Master Elite® - Certification"]
    assert len(p.reviews) == 3
    assert all(r.source == "Google" and r.published_at is not None for r in p.reviews)
    assert p.details["Contractor ID"] == "1136285"


def test_profile_sparse_certified():
    p = parse_profile_html((FIX / "gaf_profile_certified.html").read_text(), "7158488")
    assert p.legal_name == "Gemz Construction Corp"
    assert p.in_business_since is None and p.employees_range is None
    assert p.reviews == []


def test_normalize_employees():
    from leadmaker.sources.gaf.parse import normalize_employees

    assert normalize_employees("1 - 5") == "1-5"
    assert normalize_employees("More than 5") == "More than 5"
    assert normalize_employees("None") is None and normalize_employees(None) is None


def test_blocked_page_detection():
    assert looks_blocked("<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>")
    assert not looks_blocked((FIX / "gaf_profile_certified.html").read_text())
