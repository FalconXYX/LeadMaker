"""ZIP -> lat/lng.

GAF's page geocodes with Google; using Google here (when GOOGLE_MAPS_API_KEY is
set) reproduces GAF's result set exactly. Without a key we fall back to the free
zippopotam.us service; its ZIP centroid differs slightly, which can move a couple
of contractors across the radius boundary (e.g. 424 vs 426 for 10013 @ 25mi).
"""

from __future__ import annotations

import logging

from ..http import HttpClient, HttpError
from ..models import SearchArea

log = logging.getLogger(__name__)

# Last-resort offline centroids for ZIPs we care about.
BUILTIN_CENTROIDS: dict[tuple[str, str], tuple[float, float]] = {
    ("US", "10013"): (40.7185, -74.0025),
}


class GeocodeError(Exception):
    pass


async def geocode_postal_code(
    http: HttpClient,
    postal_code: str,
    country: str = "US",
    radius_miles: float = 25,
    google_api_key: str | None = None,
) -> SearchArea:
    country = country.upper()
    if google_api_key:
        try:
            resp = await http.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={"components": f"postal_code:{postal_code}|country:{country}", "key": google_api_key},
                retries=2,
            )
            data = resp.json()
            if data.get("status") == "OK":
                loc = data["results"][0]["geometry"]["location"]
                return SearchArea(
                    postal_code=postal_code, country=country, radius_miles=radius_miles,
                    latitude=loc["lat"], longitude=loc["lng"], geocoder="google",
                )
            log.warning("google geocode status=%s; falling back", data.get("status"))
        except (HttpError, KeyError, ValueError) as e:
            log.warning("google geocode failed (%s); falling back", e)
    try:
        resp = await http.get(
            f"https://api.zippopotam.us/{country.lower()}/{postal_code}", retries=2, allow_statuses=(404,)
        )
        if resp.status == 200:
            place = resp.json()["places"][0]
            return SearchArea(
                postal_code=postal_code, country=country, radius_miles=radius_miles,
                latitude=float(place["latitude"]), longitude=float(place["longitude"]), geocoder="zippopotam",
            )
    except (HttpError, KeyError, ValueError, IndexError) as e:
        log.warning("zippopotam geocode failed (%s)", e)
    if (country, postal_code) in BUILTIN_CENTROIDS:
        lat, lng = BUILTIN_CENTROIDS[(country, postal_code)]
        return SearchArea(
            postal_code=postal_code, country=country, radius_miles=radius_miles,
            latitude=lat, longitude=lng, geocoder="builtin",
        )
    raise GeocodeError(f"could not geocode {country} {postal_code}; pass --lat/--lng explicitly")
