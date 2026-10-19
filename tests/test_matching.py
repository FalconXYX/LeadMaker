from leadmaker.enrich.matching import (
    haversine_miles,
    match_confidence,
    name_similarity,
    normalize_name,
    phone_digits,
    same_phone,
    zip5,
)


def test_normalize_name_strips_legal_and_filler():
    assert normalize_name("ADH Group, Inc.") == "adh"
    assert normalize_name("ADH Group, Inc.", strict=True) == "adh group"
    assert normalize_name("Roofing Company") == "roofing"  # all-filler names keep their words
    assert normalize_name("Smith & Sons Roofing LLC") == "smith sons"


def test_name_similarity():
    assert name_similarity("MAKABAD CORP.", "Makabad Corp") == 1.0
    assert name_similarity("Jersey Roofing LLC", "Jersey Roofing") == 1.0
    assert name_similarity("ABC Roofing", "XYZ Siding") < 0.5
    assert name_similarity(None, "x") == 0.0


def test_phone_helpers():
    assert phone_digits("(929) 215-3378") == "9292153378"
    assert phone_digits("+1-718-767-6950") == "7187676950"
    assert phone_digits("12345") is None
    assert same_phone("(929) 215-3378", "929.215.3378")
    assert not same_phone(None, "929.215.3378")


def test_geo_and_zip():
    assert abs(haversine_miles(40.7185, -74.0025, 40.7185, -74.0025)) < 1e-9
    assert 10 < haversine_miles(40.7185, -74.0025, 40.871635, -74.11342) < 13
    assert zip5("07026-1234") == "07026" and zip5(None) is None


def test_match_confidence_ordering():
    phone_only = match_confidence(name_sim=0.2, phone_match=True)
    name_local = match_confidence(name_sim=1.0, same_zip=True)
    name_only = match_confidence(name_sim=0.75)
    both = match_confidence(name_sim=1.0, phone_match=True, same_zip=True)
    assert both > phone_only >= name_local > name_only
    assert both <= 0.99
