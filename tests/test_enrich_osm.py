"""Offline tests for the OSM / Overpass enricher (fixtures captured from live Overpass runs)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from leadmaker.config import Settings
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.osm import (
    OsmEnricher,
    OsmPoi,
    build_query,
    contractor_bbox,
    element_phones,
    normalize_url,
    parse_overpass,
    phone_regex,
    strict_similarity,
    website_from_email,
)
from leadmaker.http import HttpError, Response
from leadmaker.models import EnrichmentStatus

FIX = Path(__file__).parent / "fixtures"


def _load(name: str) -> Any:
    return json.loads((FIX / name).read_text())


@pytest.fixture(scope="module")
def payload() -> dict[str, Any]:
    return _load("osm_overpass_sample.json")


@pytest.fixture(scope="module")
def contractors() -> dict[str, dict[str, Any]]:
    return {r["name"]: r for r in _load("osm_contractors_sample.json")}


@pytest.fixture(scope="module")
def enricher(payload: dict[str, Any]) -> OsmEnricher:
    e = OsmEnricher(Settings())
    e.load(parse_overpass(payload))
    return e


def run(coro):  # noqa: ANN001, ANN201
    return asyncio.run(coro)


def enrich(e: OsmEnricher, row: dict[str, Any]):  # noqa: ANN201
    return run(e.enrich(LeadContext(contractor=row), None))  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tags,expected",
    [
        ({"phone": "+1-718-767-6950"}, ["7187676950"]),
        ({"phone": "+1-855-624-6655;+1-973-202-7788"}, ["8556246655", "9732027788"]),
        ({"contact:phone": "(201) 275-9185"}, ["2012759185"]),
        ({"phone": "+1 929 370 1552 ext 12"}, ["9293701552"]),
        ({"phone": "+1 201-275-9185", "contact:phone": "201.275.9185"}, ["2012759185"]),
        ({"phone": "+44 20 7946 0958"}, []),
        ({"phone": "911"}, []),
        ({}, []),
    ],
)
def test_element_phones(tags: dict[str, str], expected: list[str]) -> None:
    assert element_phones(tags) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("www.baschnagel.com", "https://www.baschnagel.com"),
        ("https://seciinc.com/", "https://seciinc.com"),
        ("HTTP://Example.COM/About", "http://example.com/About"),
        ("example.com/page?x=1#frag", "https://example.com/page?x=1"),
        ("//cdn.example.com", "https://cdn.example.com"),
        ("https://a.com;https://b.com", "https://a.com"),
        ("mailto:info@x.com", None),
        ("info@x.com", None),
        ("not a url", None),
        ("localhost", None),
        ("", None),
        (None, None),
    ],
)
def test_normalize_url(raw: str | None, expected: str | None) -> None:
    assert normalize_url(raw) == expected


def test_website_from_email() -> None:
    assert website_from_email("support@alterphaseroofing.com") == "https://alterphaseroofing.com"
    assert website_from_email("Info@SECIINC.com") == "https://seciinc.com"
    assert website_from_email("bob.roofer@gmail.com") is None
    assert website_from_email("someone@optonline.net") is None
    assert website_from_email("not-an-email") is None
    assert website_from_email(None) is None


def test_strict_similarity_rejects_place_and_trade_overlap() -> None:
    assert strict_similarity("Top Roofing LLC", "Top NJ Construction") < 0.8
    assert strict_similarity("Westbury Roofing Corp", "Sunbird Carpet Cleaning Westbury NY") < 0.8
    assert strict_similarity("Gibraltar Home Improvements", "Gibraltar Home Improvement") >= 0.9
    assert strict_similarity("American Roofing", "American Roofing & Siding") >= 0.8  # 2-token containment
    assert strict_similarity("Seci Construction Inc", "Seci Construction, Inc.") == 1.0


def test_bbox_and_query() -> None:
    rows = [{"latitude": 40.4, "longitude": -74.4}, {"latitude": 41.0, "longitude": -73.6},
            {"latitude": None, "longitude": None}]
    assert contractor_bbox(rows) == (40.35, -74.45, 41.05, -73.55)
    assert contractor_bbox([{"latitude": None}]) is None
    q = build_query((40.35, -74.45, 41.05, -73.55), ["(201) 275-9185", "bad", "+1 201 275 9185"])
    assert q.startswith("[out:json][timeout:")
    assert "out tags center;" in q
    assert '"craft"~"^(roofer|' in q
    assert '[!"highway"]' in q
    assert q.count("201[^0-9]*275[^0-9]*9185") == 2  # deduped; phone + contact:phone
    assert "(40.35,-74.45,41.05,-73.55)" in q
    assert "phone" not in build_query((1, 2, 3, 4), [])
    assert phone_regex(["nope"]) is None


def test_parse_overpass_timeout_remark_raises() -> None:
    with pytest.raises(ValueError, match="timed out"):
        parse_overpass(_load("osm_overpass_timeout.json"))
    with pytest.raises(ValueError):
        parse_overpass({"remark": "x"})


def test_parse_overpass_ways_use_center(payload: dict[str, Any]) -> None:
    pois = parse_overpass(payload)
    assert pois and all(p.names for p in pois)
    way = next(p for p in pois if p.name == "Preserv Building Restoration Management")
    assert way.osm_type == "way" and way.lat is not None and way.lon is not None
    assert way.url == f"https://www.openstreetmap.org/way/{way.osm_id}"
    # duplicates collapse
    dup = {"elements": payload["elements"][:3] + payload["elements"][:3]}
    assert len(parse_overpass(dup)) == len(parse_overpass({"elements": payload["elements"][:3]}))


def test_poi_alt_names() -> None:
    p = OsmPoi.from_element({"type": "node", "id": 1, "lat": 1.0, "lon": 2.0,
                             "tags": {"name": "ABC Roofing", "alt_name": "ABC Exteriors;ABC Roofing"}})
    assert p is not None and p.names == ["ABC Roofing", "ABC Exteriors"]
    assert OsmPoi.from_element({"type": "area", "id": 1}) is None


# ---------------------------------------------------------------------------
# matching against real Overpass data
# ---------------------------------------------------------------------------


def test_phone_match_with_website_and_email(enricher: OsmEnricher, contractors: dict[str, Any]) -> None:
    r = enrich(enricher, contractors["Alter Phase Roofing"])
    assert r.status == EnrichmentStatus.OK
    assert r.confidence >= 0.95
    assert r.website == "https://alterphaseroofing.com"
    d = r.data
    for k in ("website", "email", "phone", "osm_url", "opening_hours", "tags"):
        assert k in d
    assert d["email"] == "support@alterphaseroofing.com"
    assert d["website_from_email"] is False
    assert d["osm_url"].startswith("https://www.openstreetmap.org/node/")
    assert d["match"]["method"] == "phone" and d["match"]["phone_match"] is True
    assert r.source_urls == [d["osm_url"]]


def test_phone_match_second_number_in_list(enricher: OsmEnricher, contractors: dict[str, Any]) -> None:
    row = dict(contractors["Magnolia Home Remodeling Group"], phone="(973) 202-7788")
    r = enrich(enricher, row)
    assert r.status == EnrichmentStatus.OK and r.data["match"]["method"] == "phone"
    assert r.website == "https://magnoliahomeremodeling.com/".rstrip("/")


def test_phone_match_different_listing_name(enricher: OsmEnricher, contractors: dict[str, Any]) -> None:
    # GAF "A Real Advantage Inc" vs OSM "A Real Advantage Construction"
    r = enrich(enricher, contractors["A Real Advantage Inc"])
    assert r.status == EnrichmentStatus.OK
    assert r.data["osm_name"] == "A Real Advantage Construction"
    assert r.website == "https://www.arealadvantageconstruction.com"


@pytest.mark.parametrize("name", ["Gibraltar Home Improvements", "Allied Brothers Home Corporation",
                                  "FM Construction Group LLC", "Brothers Aluminum Home Improvements Corp"])
def test_name_matches(enricher: OsmEnricher, contractors: dict[str, Any], name: str) -> None:
    r = enrich(enricher, contractors[name])
    assert r.status == EnrichmentStatus.OK, name
    assert r.data["match"]["method"] == "name"
    assert r.data["match"]["distance_miles"] <= 0.75
    assert 0.5 <= r.confidence <= 0.95


@pytest.mark.parametrize(
    "name",
    [
        "Maspeth Roofing & Siding",  # -> Maspeth NY Garage Door (place-name overlap)
        "Top Roofing LLC",  # -> Top NJ Construction 0.83 mi
        "Top Shield Construction",
        "Island Roofing Inc",  # -> Island Auto Electric
        "Westbury Roofing Corp",  # -> Sunbird Carpet Cleaning Westbury NY
        "Window Depot USA of Lower NY",  # -> The Home Depot
        "Tri-Star Construction & Home Improvement",  # -> Tri-Star Plumbing 1.4 mi
        "B&B Contracting Corp",
        "Anderson Contracting Group Inc",
    ],
)
def test_known_false_positives_rejected(enricher: OsmEnricher, contractors: dict[str, Any], name: str) -> None:
    r = enrich(enricher, contractors[name])
    assert r.status == EnrichmentStatus.NO_MATCH, (name, r.data.get("osm_name"))


def test_no_coordinates_phone_only(enricher: OsmEnricher, contractors: dict[str, Any]) -> None:
    row = dict(contractors["Gibraltar Home Improvements"], latitude=None, longitude=None)
    assert enrich(enricher, row).status == EnrichmentStatus.NO_MATCH
    row = dict(contractors["Seci Construction Inc"], latitude=None, longitude=None)
    r = enrich(enricher, row)
    assert r.status == EnrichmentStatus.OK and r.data["match"]["distance_miles"] is None


def test_website_from_email_when_no_website_tag() -> None:
    e = OsmEnricher(Settings())
    e.load([OsmPoi.from_element({"type": "node", "id": 42, "lat": 40.0, "lon": -74.0, "tags": {
        "name": "Acme Roofing", "craft": "roofer", "phone": "+1 201 555 0100",
        "email": "info@acmeroofingnj.com", "contact:facebook": "https://www.facebook.com/acmeroof"}}),
        OsmPoi.from_element({"type": "node", "id": 43, "lat": 40.0, "lon": -74.0, "tags": {
            "name": "Joe Roofing", "phone": "+1 201 555 0101", "email": "joe@gmail.com",
            "website": "https://facebook.com/joeroof"}})])
    r = enrich(e, {"gaf_id": "x", "name": "Acme Roofing LLC", "phone": "201-555-0100",
                   "latitude": 40.0, "longitude": -74.0})
    assert r.website == "https://acmeroofingnj.com" and r.data["website_from_email"] is True
    assert r.data["social"]["facebook"] == "https://www.facebook.com/acmeroof"
    r = enrich(e, {"gaf_id": "y", "name": "Joe Roofing", "phone": "201-555-0101"})
    assert r.website is None and r.data["website_from_email"] is False  # free mail; FB is not a website
    assert r.data["social"]["facebook"] == "https://facebook.com/joeroof"


def test_enrich_before_prepare_is_error() -> None:
    r = enrich(OsmEnricher(Settings()), {"gaf_id": "x", "name": "A"})
    assert r.status == EnrichmentStatus.ERROR


# ---------------------------------------------------------------------------
# prepare(): endpoint fallback (mocked HTTP)
# ---------------------------------------------------------------------------


class FakeHttp:
    def __init__(self, outcomes: list[Any]):
        self.outcomes = outcomes
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def post(self, url: str, **kw: Any) -> Response:
        self.calls.append((url, kw))
        out = self.outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return Response(url=url, status=200, text=json.dumps(out), headers={})


def test_prepare_falls_back_to_mirror(payload: dict[str, Any], contractors: dict[str, Any]) -> None:
    http = FakeHttp([HttpError("HTTP 504", status=504), _load("osm_overpass_timeout.json"), payload])
    e = OsmEnricher(Settings())
    run(e.prepare(http, list(contractors.values())))  # type: ignore[arg-type]
    assert e.loaded and len(e.pois) > 100
    assert e.endpoint_used == e.endpoints[2]
    url, kw = http.calls[0]
    assert "LeadMaker" in kw["headers"]["User-Agent"]
    assert "out tags center;" in kw["data"]["data"]
    assert kw["timeout"] > 60


def test_prepare_all_fail_raises(contractors: dict[str, Any]) -> None:
    http = FakeHttp([HttpError("x")] * len(OsmEnricher.endpoints))
    with pytest.raises(RuntimeError, match="all overpass endpoints failed"):
        run(OsmEnricher(Settings()).prepare(http, list(contractors.values())))  # type: ignore[arg-type]


def test_prepare_without_coordinates_skips_query() -> None:
    http = FakeHttp([])
    e = OsmEnricher(Settings())
    run(e.prepare(http, [{"gaf_id": "x", "latitude": None, "longitude": None}]))  # type: ignore[arg-type]
    assert e.loaded and e.pois == [] and http.calls == []
