"""Offline tests for the Google Places (New) enricher.

Fixtures: `google_places_error_invalid_key_400.json` and `..._unregistered_403.json`
are real responses captured from places.googleapis.com; the success payloads are
hand-built to Google's documented Place / SearchTextResponse JSON shape (no API
key was available) for a fictional contractor with 555-01xx phone numbers.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

import pytest

from leadmaker.config import Settings
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.google_places import (
    DETAILS_FIELD_MASK,
    SEARCH_FIELD_MASK,
    SEARCH_URL,
    GoogleApiError,
    GooglePlacesEnricher,
    _clean_website,
    _is_social,
    _zip_from_address,
    maps_url_for,
    pick_best,
)
from leadmaker.http import HttpError, Response
from leadmaker.models import EnrichmentStatus

FIX = Path(__file__).parent / "fixtures"
KEY = "test-key-123"


def fx(name: str) -> str:
    return (FIX / f"google_places_{name}.json").read_text()


def resp(status: int, body: str | dict, url: str = "https://places.googleapis.com/") -> Response:
    text = body if isinstance(body, str) else json.dumps(body)
    return Response(url=url, status=status, text=text, headers={"content-type": "application/json"})


class FakeHttp:
    """Mimics HttpClient: statuses in allow_statuses are returned, other non-2xx raise HttpError."""

    def __init__(self, handler: Callable[[str, str, dict[str, Any]], Response | Exception]):
        self.handler = handler
        self.calls: list[dict[str, Any]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    async def request(self, method: str, url: str, **kw: Any) -> Response:
        self.calls.append({"method": method, "url": url, **kw})
        out = self.handler(method, url, kw)
        if isinstance(out, Exception):
            raise out
        if not out.ok and out.status not in kw.get("allow_statuses", ()):
            raise HttpError(f"HTTP {out.status} for {url}", status=out.status, url=url)
        return out

    async def get(self, url: str, **kw: Any) -> Response:
        return await self.request("GET", url, **kw)

    async def post(self, url: str, **kw: Any) -> Response:
        return await self.request("POST", url, **kw)


def router(details: Response | Exception | None = None, searches: list[Response] | None = None):
    queue = list(searches or [])

    def handle(method: str, url: str, kw: dict[str, Any]):
        if method == "GET":
            assert details is not None, f"unexpected details call {url}"
            return details
        assert url == SEARCH_URL
        assert queue, "unexpected extra text search"
        return queue.pop(0)

    return handle


def contractor(**over: Any) -> dict[str, Any]:
    row = {
        "gaf_id": "T1", "name": "Acme Roofing & Siding", "dba": None, "legal_name": "Acme Exteriors LLC",
        "address": "100 Main St Hoboken, NJ 07030", "street": "100 Main St", "city": "Hoboken", "state": "NJ",
        "postal_code": "07030", "country": "USA", "phone": "(201) 555-0142",
        "latitude": 40.7440, "longitude": -74.0324, "google_place_id": "ChIJTestAcmeRoofingHoboken01",
    }
    row.update(over)
    return row


def enricher(key: str | None = KEY) -> GooglePlacesEnricher:
    return GooglePlacesEnricher(replace(Settings(), google_maps_api_key=key))


# --------------------------------------------------------------------------- keyless


async def test_keyless_with_place_id_returns_maps_link_without_network():
    e = enricher(None)
    assert e.is_enabled() == (True, "")
    http = FakeHttp(lambda *a: pytest.fail("no network in keyless mode"))
    r = await e.enrich(LeadContext(contractor()), http)
    assert r.status == EnrichmentStatus.OK
    assert r.confidence == 1.0
    assert r.data == {
        "place_id": "ChIJTestAcmeRoofingHoboken01",
        "google_maps_url": "https://www.google.com/maps/place/?q=place_id:ChIJTestAcmeRoofingHoboken01",
        "api": False,
        "maps_search_url": "https://www.google.com/maps/search/?api=1&query=Acme%20Roofing%20%26%20Siding%2C%20"
                           "100%20Main%20St%20Hoboken%2C%20NJ%2007030&query_place_id=ChIJTestAcmeRoofingHoboken01",
    }
    assert r.website is None
    assert r.source_urls == [r.data["google_maps_url"]]
    assert http.calls == []


@pytest.mark.parametrize("pid", [None, "", "   "])
async def test_keyless_without_place_id_is_skipped(pid):
    r = await enricher(None).enrich(LeadContext(contractor(google_place_id=pid)), FakeHttp(lambda *a: pytest.fail()))
    assert r.status == EnrichmentStatus.SKIPPED
    assert r.data == {"reason": "no GOOGLE_MAPS_API_KEY"}


def test_blank_key_counts_as_keyless():
    assert enricher("  ").api_key is None
    assert enricher(KEY).is_enabled() == (True, "")


# --------------------------------------------------------------------------- place details


async def test_details_full_contract_and_request_shape():
    e = enricher()
    http = FakeHttp(router(details=resp(200, fx("details_ok"))))
    await e.prepare(http, [])
    assert http.intervals["places.googleapis.com"] > 0
    r = await e.enrich(LeadContext(contractor()), http)
    assert r.status == EnrichmentStatus.OK, r.error
    assert r.confidence == 1.0
    d = r.data
    for k in ("website", "google_maps_url", "rating", "user_rating_count", "business_status", "primary_type",
              "types", "phone", "formatted_address", "opening_hours"):
        assert k in d, k
    assert d["place_id"] == "ChIJTestAcmeRoofingHoboken01"
    assert d["website"] == "https://www.acmeroofing.example/"  # utm_* stripped
    assert r.website == d["website"]
    assert d["google_maps_url"] == "https://maps.google.com/?cid=11223344556677889900"
    assert d["rating"] == 4.8 and d["user_rating_count"] == 57
    assert d["business_status"] == "OPERATIONAL" and d["primary_type"] == "roofing_contractor"
    assert "roofing_contractor" in d["types"]
    assert d["phone"] == "(201) 555-0142"
    assert d["formatted_address"] == "100 Main St, Hoboken, NJ 07030, USA"
    assert len(d["opening_hours"]) == 7 and d["opening_hours"][-1] == "Sunday: Closed"
    assert d["api"] is True and d["method"] == "place_id"
    assert d["match"]["phone_match"] is True

    (call,) = http.calls
    assert call["method"] == "GET"
    assert call["url"] == "https://places.googleapis.com/v1/places/ChIJTestAcmeRoofingHoboken01"
    assert call["headers"]["X-Goog-Api-Key"] == KEY
    assert call["headers"]["X-Goog-FieldMask"] == DETAILS_FIELD_MASK
    assert 404 in call["allow_statuses"] and 403 in call["allow_statuses"]
    assert all(KEY not in u for u in r.source_urls)  # key goes in a header, never a stored URL


def test_field_masks():
    assert DETAILS_FIELD_MASK == (
        "id,displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri,googleMapsUri,"
        "rating,userRatingCount,businessStatus,primaryType,types,regularOpeningHours.weekdayDescriptions,"
        "pureServiceAreaBusiness,location"
    )
    parts = SEARCH_FIELD_MASK.split(",")
    assert all(p.startswith("places.") for p in parts)
    assert "places.location" in parts and "places.regularOpeningHours.weekdayDescriptions" in parts
    assert " " not in SEARCH_FIELD_MASK


async def test_details_uncorroborated_gaf_place_id_gets_lower_confidence():
    place = json.loads(fx("details_ok"))
    place["displayName"]["text"] = "Totally Different Plumbing"
    place["nationalPhoneNumber"] = "(212) 555-0100"
    place.pop("internationalPhoneNumber")
    r = await enricher().enrich(LeadContext(contractor()), FakeHttp(router(details=resp(200, place))))
    assert r.status == EnrichmentStatus.OK
    assert r.confidence == 0.85
    assert r.data["match"]["phone_match"] is False


async def test_social_website_not_promoted():
    place = json.loads(fx("details_ok"))
    place["websiteUri"] = "https://www.facebook.com/acmeroofingnj/"
    r = await enricher().enrich(LeadContext(contractor()), FakeHttp(router(details=resp(200, place))))
    assert r.status == EnrichmentStatus.OK
    assert r.data["website"] is None
    assert r.data["social_url"] == "https://www.facebook.com/acmeroofingnj/"
    assert r.website is None


async def test_details_missing_optional_fields():
    place = {"id": "ChIJTestSparse", "displayName": {"text": "Acme Roofing & Siding", "languageCode": "en"}}
    r = await enricher().enrich(LeadContext(contractor(google_place_id="ChIJTestSparse")),
                                FakeHttp(router(details=resp(200, place))))
    assert r.status == EnrichmentStatus.OK
    assert r.website is None
    assert r.data["google_maps_url"] == maps_url_for("ChIJTestSparse")
    assert r.data["opening_hours"] is None and r.data["types"] == [] and r.data["rating"] is None


# --------------------------------------------------------------------------- text search


async def test_stale_place_id_404_falls_back_to_text_search():
    http = FakeHttp(router(details=resp(404, fx("error_not_found_404")),
                           searches=[resp(200, fx("text_search"))]))
    r = await enricher().enrich(LeadContext(contractor()), http)
    assert r.status == EnrichmentStatus.OK, r.error
    assert r.data["place_id"] == "ChIJTestAcmeExteriorsHob0001"  # phone match beats the nearby other roofer
    assert r.data["stale_place_id"] == "ChIJTestAcmeRoofingHoboken01"
    assert r.data["method"] == "text_search_stale_id"
    assert r.confidence >= 0.9
    assert r.website == "http://acmeexteriors.example/?ref=gbp"
    get, post = http.calls
    assert post["method"] == "POST"
    assert post["headers"]["X-Goog-FieldMask"] == SEARCH_FIELD_MASK
    body = post["json"]
    assert body["textQuery"] == "Acme Roofing & Siding, 100 Main St Hoboken, NJ 07030"
    assert body["locationBias"] == {"circle": {"center": {"latitude": 40.744, "longitude": -74.0324},
                                               "radius": 2000.0}}
    assert 1 <= body["pageSize"] <= 20


async def test_malformed_place_id_400_falls_back_to_text_search():
    http = FakeHttp(router(details=resp(400, fx("error_invalid_place_id_400")),
                           searches=[resp(200, fx("text_search"))]))
    r = await enricher().enrich(LeadContext(contractor(google_place_id="not-a-place-id")), http)
    assert r.status == EnrichmentStatus.OK
    assert r.data["stale_place_id"] == "not-a-place-id"


async def test_text_search_without_place_id_picks_phone_match():
    http = FakeHttp(router(searches=[resp(200, fx("text_search"))]))
    r = await enricher().enrich(LeadContext(contractor(google_place_id=None)), http)
    assert r.status == EnrichmentStatus.OK
    assert r.data["method"] == "text_search"
    assert "stale_place_id" not in r.data
    assert r.data["match"]["phone_match"] is True
    assert r.data["match"]["distance_miles"] < 0.5
    assert len(http.calls) == 1  # first query was good enough


async def test_text_search_name_and_distance_without_phone():
    # Contractor phone unknown: name similarity + same ZIP must carry the match.
    http = FakeHttp(router(searches=[resp(200, fx("text_search"))]))
    r = await enricher().enrich(LeadContext(contractor(google_place_id=None, phone=None)), http)
    assert r.status == EnrichmentStatus.OK
    assert r.data["place_id"] == "ChIJTestAcmeExteriorsHob0001"  # exact legal-name match, same ZIP
    assert 0.6 <= r.confidence < 0.99


async def test_text_search_empty_tries_legal_name_then_no_match():
    http = FakeHttp(router(searches=[resp(200, fx("text_search_empty")), resp(200, fx("text_search_empty"))]))
    r = await enricher().enrich(LeadContext(contractor(google_place_id=None)), http)
    assert r.status == EnrichmentStatus.NO_MATCH
    assert [c["json"]["textQuery"] for c in http.calls] == [
        "Acme Roofing & Siding, 100 Main St Hoboken, NJ 07030",
        "Acme Exteriors LLC, 100 Main St Hoboken, NJ 07030",
    ]
    assert r.data["candidates"] == 0


async def test_text_search_weak_candidates_rejected():
    http = FakeHttp(router(searches=[resp(200, fx("text_search_weak")), resp(200, fx("text_search_weak"))]))
    r = await enricher().enrich(LeadContext(contractor(google_place_id=None)), http)
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data["best_rejected"]["confidence"] < 0.6
    assert r.data["candidates"] == 2  # deduped across both queries


async def test_text_search_without_coordinates_omits_location_bias():
    http = FakeHttp(router(searches=[resp(200, fx("text_search"))]))
    row = contractor(google_place_id=None, latitude=None, longitude=None)
    r = await enricher().enrich(LeadContext(row), http)
    assert "locationBias" not in http.calls[0]["json"]
    assert r.status == EnrichmentStatus.OK  # phone still matches
    assert r.data["match"]["distance_miles"] is None


def test_pick_best_prefers_phone_then_proximity():
    ctx = LeadContext(contractor())
    places = json.loads(fx("text_search"))["places"]
    best = pick_best(ctx, places)
    assert best is not None and best.place["id"] == "ChIJTestAcmeExteriorsHob0001"
    # Without the true record, the same-name business 40mi away must not pass the threshold.
    rest = [p for p in places if p["id"] != "ChIJTestAcmeExteriorsHob0001"]
    alt = pick_best(LeadContext(contractor(legal_name=None)), rest)
    assert alt is not None and alt.confidence < 0.6
    assert pick_best(ctx, []) is None
    assert pick_best(ctx, [{"displayName": {"text": "no id"}}]) is None


# --------------------------------------------------------------------------- errors


async def test_invalid_key_errors_and_trips_breaker():
    e = enricher()
    http = FakeHttp(router(details=resp(400, fx("error_invalid_key_400"))))
    r1 = await e.enrich(LeadContext(contractor()), http)
    assert r1.status == EnrichmentStatus.ERROR
    assert "API_KEY_INVALID" in r1.error
    r2 = await e.enrich(LeadContext(contractor(gaf_id="T2", google_place_id=None)), http)
    assert r2.status == EnrichmentStatus.ERROR
    assert len(http.calls) == 1  # breaker: no further API calls this run


@pytest.mark.parametrize("fixture", ["error_unregistered_403", "error_service_disabled_403"])
async def test_permission_denied_is_auth_error(fixture):
    e = enricher()
    http = FakeHttp(router(searches=[resp(403, fx(fixture))]))
    r = await e.enrich(LeadContext(contractor(google_place_id=None)), http)
    assert r.status == EnrichmentStatus.ERROR and "auth" in r.error
    assert e._fatal


async def test_quota_429_errors_then_breaker():
    e = enricher()
    err = HttpError("HTTP 429 for x", status=429, url=SEARCH_URL)
    http = FakeHttp(lambda *a: err)
    for _ in range(3):
        r = await e.enrich(LeadContext(contractor(google_place_id=None)), http)
        assert r.status == EnrichmentStatus.ERROR and "quota" in r.error
    assert len(http.calls) == 3
    r = await e.enrich(LeadContext(contractor(google_place_id=None)), http)
    assert r.status == EnrichmentStatus.ERROR
    assert len(http.calls) == 3  # stopped calling


async def test_quota_counter_resets_on_success():
    e = enricher()
    seq = [HttpError("429", status=429), HttpError("429", status=429), resp(200, fx("details_ok")),
           HttpError("429", status=429), HttpError("429", status=429)]
    http = FakeHttp(lambda *a: seq.pop(0))
    statuses = [(await e.enrich(LeadContext(contractor()), http)).status for _ in range(5)]
    assert statuses.count(EnrichmentStatus.OK) == 1
    assert e._fatal is None


async def test_quota_body_returned_as_429_response():
    # If a caller allowed 429 through, the parsed body still reads as non-auth, non-stale.
    err = GoogleApiError.from_response(resp(429, fx("error_quota_429")))
    assert err.code == "RESOURCE_EXHAUSTED" and not err.is_auth and not err.is_stale_id


async def test_network_error_and_bad_json_never_raise():
    e = enricher()
    r = await e.enrich(LeadContext(contractor()), FakeHttp(lambda *a: HttpError("network error: reset")))
    assert r.status == EnrichmentStatus.ERROR and "network" in r.error
    r = await e.enrich(LeadContext(contractor()), FakeHttp(lambda *a: resp(200, "<html>oops</html>")))
    assert r.status == EnrichmentStatus.ERROR
    assert e._fatal is None


async def test_server_error_on_details_is_error_not_fallback():
    http = FakeHttp(lambda *a: HttpError("HTTP 503", status=503))
    r = await enricher().enrich(LeadContext(contractor()), http)
    assert r.status == EnrichmentStatus.ERROR
    assert len(http.calls) == 1


def test_google_api_error_parsing():
    bad_key = GoogleApiError.from_response(resp(400, fx("error_invalid_key_400")))
    assert bad_key.is_auth and not bad_key.is_stale_id and bad_key.reasons[0] == "API_KEY_INVALID"
    nf = GoogleApiError.from_response(resp(404, fx("error_not_found_404")))
    assert nf.is_stale_id and not nf.is_auth and nf.code == "NOT_FOUND"
    junk = GoogleApiError.from_response(resp(502, "<html>Bad Gateway</html>"))
    assert junk.status == 502 and "Bad Gateway" in junk.message


# --------------------------------------------------------------------------- helpers


def test_helpers():
    assert _zip_from_address("1314 8th St, North Bergen, NJ 07047, USA") == "07047"
    assert _zip_from_address("54-30 44th St, Maspeth, NY 11378-1023, USA") == "11378"
    assert _zip_from_address(None) is None
    assert _clean_website("https://x.example/a?utm_source=gmb&id=3&gclid=z") == "https://x.example/a?id=3"
    assert _clean_website("https://x.example/") == "https://x.example/"
    assert _clean_website(None) is None
    assert _is_social("https://m.facebook.com/foo") and _is_social("https://www.instagram.com/foo")
    assert not _is_social("https://acmeroofing.example/") and not _is_social(None)
    assert maps_url_for("abc") == "https://www.google.com/maps/place/?q=place_id:abc"


async def test_concurrent_workers_with_bad_key_send_one_request():
    import asyncio

    e = enricher()

    class SlowHttp(FakeHttp):
        async def request(self, method, url, **kw):
            await asyncio.sleep(0.01)
            return await super().request(method, url, **kw)

    http = SlowHttp(lambda *a: resp(400, fx("error_invalid_key_400")))
    rows = [contractor(gaf_id=f"T{i}") for i in range(12)]
    results = await asyncio.gather(*(e.enrich(LeadContext(r), http) for r in rows))
    assert all(r.status == EnrichmentStatus.ERROR for r in results)
    assert len(http.calls) == 1


async def test_concurrent_workers_with_good_key_all_succeed():
    import asyncio

    e = enricher()
    http = FakeHttp(lambda *a: resp(200, fx("details_ok")))
    results = await asyncio.gather(*(e.enrich(LeadContext(contractor(gaf_id=f"T{i}")), http) for i in range(8)))
    assert [r.status for r in results] == [EnrichmentStatus.OK] * 8
    assert len(http.calls) == 8


async def test_details_refreshed_place_id_recorded():
    place = json.loads(fx("details_ok"))
    place["id"] = "ChIJTestRefreshedId"
    r = await enricher().enrich(LeadContext(contractor()), FakeHttp(router(details=resp(200, place))))
    assert r.data["place_id"] == "ChIJTestRefreshedId"
    assert r.data["requested_place_id"] == "ChIJTestAcmeRoofingHoboken01"


def test_search_queries_dedupe_legal_suffix_variants():
    e = enricher()
    q = e.search_queries(LeadContext(contractor(name="Acme Roofing", legal_name="Acme Roofing LLC", dba="ACME Roofing")))
    assert q == ["Acme Roofing, 100 Main St Hoboken, NJ 07030", "Acme Roofing, Hoboken, NJ"]
    q = e.search_queries(LeadContext(contractor(address=None)))
    assert q[0] == "Acme Roofing & Siding, Hoboken, NJ, 07030" and len(q) == 2


async def test_service_area_business_matched_by_phone():
    # SABs hide their street address: Google returns only locality and an approximate pin.
    sab = {"places": [{
        "id": "ChIJTestSabAcme", "displayName": {"text": "Acme Roofing NJ", "languageCode": "en"},
        "pureServiceAreaBusiness": True,  # no location / street address returned for pure SABs
        "nationalPhoneNumber": "(201) 555-0142", "internationalPhoneNumber": "+1 201-555-0142",
        "businessStatus": "OPERATIONAL", "primaryType": "roofing_contractor", "types": ["roofing_contractor"],
        "googleMapsUri": "https://maps.google.com/?cid=42",
    }]}
    r = await enricher().enrich(LeadContext(contractor(google_place_id=None)),
                                FakeHttp(router(searches=[resp(200, sab)])))
    assert r.status == EnrichmentStatus.OK
    assert r.data["match"]["phone_match"] is True and r.data["match"]["same_zip"] is False
    assert r.data["match"]["distance_miles"] is None
    assert r.data["pure_service_area_business"] is True
    assert r.confidence >= 0.9


async def test_name_only_match_needs_locality():
    far_same_name = {"places": [{
        "id": "ChIJTestFarTwin", "displayName": {"text": "Acme Roofing & Siding", "languageCode": "en"},
        "formattedAddress": "12 Oak Ave, Albany, NY 12203, USA", "location": {"latitude": 42.6803, "longitude": -73.8370},
        "nationalPhoneNumber": "(518) 555-0123",
    }]}
    sab_same_name = {"places": [{
        "id": "ChIJTestSabTwin", "displayName": {"text": "Acme Roofing & Siding", "languageCode": "en"},
        "pureServiceAreaBusiness": True,
    }]}
    for payload in (far_same_name, sab_same_name):
        http = FakeHttp(router(searches=[resp(200, payload), resp(200, payload)]))
        r = await enricher().enrich(LeadContext(contractor(google_place_id=None)), http)
        assert r.status == EnrichmentStatus.NO_MATCH, payload
    near = json.loads(json.dumps(far_same_name))
    near["places"][0].update(formattedAddress="300 Washington St, Hoboken, NJ 07030, USA",
                             location={"latitude": 40.7420, "longitude": -74.0290})
    r = await enricher().enrich(LeadContext(contractor(google_place_id=None)),
                                FakeHttp(router(searches=[resp(200, near)])))
    assert r.status == EnrichmentStatus.OK and r.confidence >= 0.8  # exact name + same ZIP


async def test_search_body_includes_pure_service_area_businesses():
    http = FakeHttp(router(searches=[resp(200, fx("text_search"))]))
    await enricher().enrich(LeadContext(contractor(google_place_id=None)), http)
    body = http.calls[0]["json"]
    assert body["includePureServiceAreaBusinesses"] is True and body["regionCode"] == "US"


# --------------------------------------------------------------------------- schema conformance
# google_places_discovery_v1_trimmed.json is Google's own published API schema
# (places.googleapis.com/$discovery/rest?version=v1, trimmed), so these tests pin
# our requests and hand-built fixtures to the real wire format.

SCHEMA = json.loads((FIX / "google_places_discovery_v1_trimmed.json").read_text())["schemas"]


def _validate(obj: Any, schema_name: str, path: str = "") -> None:
    props = SCHEMA[schema_name]["properties"]
    assert isinstance(obj, dict), path
    for k, v in obj.items():
        assert k in props, f"{path}.{k} not in {schema_name}"
        spec = props[k]
        if "$ref" in spec:
            _validate(v, spec["$ref"], f"{path}.{k}")
        elif spec.get("type") == "array":
            assert isinstance(v, list), f"{path}.{k}"
            item = spec.get("items", {})
            for i, x in enumerate(v):
                if "$ref" in item:
                    _validate(x, item["$ref"], f"{path}.{k}[{i}]")
                elif "enum" in item:
                    assert x in item["enum"], f"{path}.{k}[{i}]={x}"
        else:
            if "enum" in spec:
                assert v in spec["enum"], f"{path}.{k}={v}"
            t = spec.get("type")
            ok = {"string": str, "boolean": bool, "integer": int, "number": (int, float), "object": dict}.get(t)
            if ok:
                assert isinstance(v, ok) and not (t in ("integer", "number") and isinstance(v, bool)), f"{path}.{k}"


def _resolve_mask_path(schema_name: str, dotted: str) -> None:
    cur = schema_name
    for part in dotted.split("."):
        spec = SCHEMA[cur]["properties"][part]  # KeyError -> unknown field
        cur = spec.get("$ref") or spec.get("items", {}).get("$ref") or cur


def test_field_masks_exist_in_published_schema():
    for f in DETAILS_FIELD_MASK.split(","):
        _resolve_mask_path("GoogleMapsPlacesV1Place", f)
    for f in SEARCH_FIELD_MASK.split(","):
        assert f.startswith("places.")
        _resolve_mask_path("GoogleMapsPlacesV1SearchTextResponse", f)


@pytest.mark.parametrize("name", ["text_search", "text_search_weak", "text_search_empty"])
def test_search_fixtures_match_published_schema(name):
    _validate(json.loads(fx(name)), "GoogleMapsPlacesV1SearchTextResponse")


def test_details_fixture_matches_published_schema():
    _validate(json.loads(fx("details_ok")), "GoogleMapsPlacesV1Place")


async def test_search_request_body_matches_published_schema():
    http = FakeHttp(router(searches=[resp(200, fx("text_search_empty")), resp(200, fx("text_search_empty"))]))
    await enricher().enrich(LeadContext(contractor(google_place_id=None)), http)
    for call in http.calls:
        _validate(call["json"], "GoogleMapsPlacesV1SearchTextRequest")
        assert call["json"]["locationBias"]["circle"]["radius"] <= 50000.0


def test_schema_validator_rejects_wrong_shapes():
    with pytest.raises(AssertionError):
        _validate({"places": [{"phoneNumber": "x"}]}, "GoogleMapsPlacesV1SearchTextResponse")
    with pytest.raises(AssertionError):
        _validate({"businessStatus": "OPEN"}, "GoogleMapsPlacesV1Place")
    with pytest.raises(AssertionError):
        _validate({"displayName": "plain string"}, "GoogleMapsPlacesV1Place")
    with pytest.raises(KeyError):
        _resolve_mask_path("GoogleMapsPlacesV1Place", "regularOpeningHours.weekdayText")


def test_input_hash_changes_when_key_is_added():
    # A keyless OK/SKIPPED row must not stay "fresh" for the TTL once a key is configured.
    ctx = LeadContext(contractor())
    keyless, keyed = enricher(None), enricher()
    assert keyless.mode == "keyless" and keyed.mode == "api"
    assert keyless.input_hash(ctx) != keyed.input_hash(ctx)
    assert keyed.input_hash(ctx) == enricher("other-key").input_hash(ctx)  # key rotation is not a change
    assert keyless.input_hash(ctx) == enricher(None).input_hash(ctx)
    assert keyless.input_hash(ctx) != keyless.input_hash(LeadContext(contractor(google_place_id="ChIJOther")))
