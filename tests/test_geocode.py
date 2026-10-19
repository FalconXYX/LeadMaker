"""ZIP -> search-area geocoding: Google (keyed), zippopotam.us (free) and the built-in fallback.

Fixtures:
  geocode_zippopotam_us_10013.json   -- zippopotam.us answer shape; coordinates are the ones the
                                        live scrape runs recorded for 10013 (geocoder=zippopotam);
  geocode_google_10013.json          -- Google Geocoding API "OK" response shape for 10013;
  geocode_google_request_denied.json -- what Google returns (HTTP 200) for a bad key;
  geocode_google_zero_results.json   -- Google's answer for an unknown postal code.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from leadmaker.http import HttpError, Response
from leadmaker.sources.geocode import BUILTIN_CENTROIDS, GeocodeError, geocode_postal_code

FIX = Path(__file__).parent / "fixtures"
GOOGLE = "https://maps.googleapis.com/maps/api/geocode/json"
ZIPPO = "https://api.zippopotam.us/"


def _fixture(name: str) -> str:
    return (FIX / name).read_text()


def _resp(url: str, text: str, status: int = 200) -> Response:
    return Response(url=url, status=status, text=text, headers={})


class FakeHttp:
    """Answers by URL prefix with a Response, or raises the given exception; records every call."""

    def __init__(self, google: Any = None, zippo: Any = None):
        self.routes = {GOOGLE: google, ZIPPO: zippo}
        self.calls: list[dict[str, Any]] = []

    async def get(self, url: str, params: dict[str, Any] | None = None, **kw: Any) -> Response:
        self.calls.append({"url": url, "params": dict(params or {}), "kw": kw})
        answer = next(a for prefix, a in self.routes.items() if url.startswith(prefix))
        if answer is None:
            raise AssertionError(f"unexpected request to {url}")
        if isinstance(answer, Exception):
            raise answer
        return _resp(url, *answer) if isinstance(answer, tuple) else _resp(url, answer)

    def hosts(self) -> list[str]:
        return ["google" if c["url"].startswith(GOOGLE) else "zippopotam" for c in self.calls]


ZIPPO_OK = _fixture("geocode_zippopotam_us_10013.json")
GOOGLE_OK = _fixture("geocode_google_10013.json")


async def test_google_key_uses_google_and_skips_zippopotam():
    http = FakeHttp(google=GOOGLE_OK)
    area = await geocode_postal_code(http, "10013", "us", 25, google_api_key="k-123")  # type: ignore[arg-type]
    assert (area.latitude, area.longitude, area.geocoder) == (40.7217861, -74.0094471, "google")
    assert (area.postal_code, area.country, area.radius_miles) == ("10013", "US", 25)
    (call,) = http.calls
    assert call["url"] == GOOGLE
    assert call["params"] == {"components": "postal_code:10013|country:US", "key": "k-123"}
    assert call["kw"] == {"retries": 2}


async def test_without_key_google_is_never_called():
    http = FakeHttp(zippo=ZIPPO_OK)
    area = await geocode_postal_code(http, "10013", radius_miles=10)  # type: ignore[arg-type]
    assert http.hosts() == ["zippopotam"]
    assert (area.latitude, area.longitude, area.geocoder, area.radius_miles) == (40.7185, -74.0025, "zippopotam", 10)
    assert isinstance(area.latitude, float) and isinstance(area.longitude, float)  # strings in the payload


async def test_zippopotam_url_uses_lowercase_country_and_tolerates_404():
    http = FakeHttp(zippo=ZIPPO_OK)
    await geocode_postal_code(http, "10013", "US")  # type: ignore[arg-type]
    (call,) = http.calls
    assert call["url"] == "https://api.zippopotam.us/us/10013"
    assert call["kw"] == {"retries": 2, "allow_statuses": (404,)}


@pytest.mark.parametrize("google", [
    _fixture("geocode_google_request_denied.json"),
    _fixture("geocode_google_zero_results.json"),
    "<html>502 Bad Gateway</html>",                        # not JSON -> ValueError
    json.dumps({"status": "OK", "results": [{"geometry": {}}]}),  # missing location -> KeyError
    HttpError("HTTP 403 for google", status=403, url=GOOGLE),
], ids=["request_denied", "zero_results", "not_json", "missing_location", "http_error"])
async def test_google_failure_falls_back_to_zippopotam(google):
    http = FakeHttp(google=google, zippo=ZIPPO_OK)
    area = await geocode_postal_code(http, "10013", google_api_key="bad-key")  # type: ignore[arg-type]
    assert http.hosts() == ["google", "zippopotam"]
    assert area.geocoder == "zippopotam" and (area.latitude, area.longitude) == (40.7185, -74.0025)


@pytest.mark.parametrize("zippo", [
    ("{}", 404),                                           # unknown ZIP
    HttpError("network error for zippopotam", url=ZIPPO),  # service down
    json.dumps({"post code": "10013", "places": []}),      # empty places -> IndexError
    json.dumps({"places": [{"latitude": "n/a", "longitude": "-74.0"}]}),  # bad number -> ValueError
], ids=["404", "http_error", "no_places", "bad_number"])
async def test_known_zip_falls_back_to_builtin_centroid(zippo):
    http = FakeHttp(zippo=zippo)
    area = await geocode_postal_code(http, "10013", radius_miles=30)  # type: ignore[arg-type]
    assert area.geocoder == "builtin" and area.radius_miles == 30
    assert (area.latitude, area.longitude) == BUILTIN_CENTROIDS[("US", "10013")]


async def test_all_sources_failing_falls_through_google_and_zippopotam_to_builtin():
    http = FakeHttp(google=_fixture("geocode_google_request_denied.json"), zippo=("{}", 404))
    area = await geocode_postal_code(http, "10013", google_api_key="bad")  # type: ignore[arg-type]
    assert http.hosts() == ["google", "zippopotam"] and area.geocoder == "builtin"


async def test_unknown_zip_with_no_source_raises_with_manual_hint():
    http = FakeHttp(zippo=("{}", 404))
    with pytest.raises(GeocodeError, match=r"could not geocode US 99999; pass --lat/--lng explicitly"):
        await geocode_postal_code(http, "99999")  # type: ignore[arg-type]


async def test_builtin_centroid_is_country_specific():
    http = FakeHttp(zippo=("{}", 404))
    with pytest.raises(GeocodeError, match="CA 10013"):
        await geocode_postal_code(http, "10013", "ca")  # type: ignore[arg-type]
    assert http.calls[0]["url"] == "https://api.zippopotam.us/ca/10013"
