"""GAF contractor locator client.

How gaf.com works (reverse-engineered Oct 2026):
  * /en-us/roofing-contractors/residential is server-rendered *chrome only*; the
    contractor list is fetched client-side from Coveo's Search API using a public,
    search-only API key embedded in the page (`data-coveo` attribute).
  * The page geocodes the ZIP (Google) and sends Coveo a query function
    `dist(@gaf_latitude, @gaf_longitude, lat, lng) * 0.000621371` -> @distanceinmiles,
    filtered by `aq = @distanceinmiles <= R AND @gaf_f_country_code == USA`.
  * Profile pages (`uri` field) are server-rendered and sit behind Akamai Bot
    Manager, so they need a browser TLS fingerprint (handled by HttpClient).

Calling the same search API the page uses returns complete structured data in a
single request per ~500 contractors, which is far cheaper and more reliable than
rendering the page in a browser.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ...http import HttpClient, HttpError
from ...models import ContractorProfile, SearchArea
from .parse import CoveoConfig, looks_blocked, parse_listing_config, parse_profile_html

log = logging.getLogger(__name__)

LISTING_URL = "https://www.gaf.com/en-us/roofing-contractors/residential"
COUNTRY_VALUES = {"US": "USA", "CA": "CAN"}
COVEO_MAX_DEPTH = 5000  # Coveo refuses firstResult + numberOfResults beyond this


class GafBlockedError(HttpError):
    pass


@dataclass
class AreaSearch:
    """One paginated area read, plus why pagination stopped.

    stop_reason is "exhausted" (read up to totalCount), "empty_page" (Coveo
    returned no results before totalCount) or "depth_limit" (hit COVEO_MAX_DEPTH).
    Only the first means the read can be complete; the caller decides.
    """

    total: int = 0
    results: list[dict[str, Any]] = field(default_factory=list)
    stop_reason: str = "exhausted"
    pages: int = 0
    duplicates: int = 0  # results repeated across pages (unstable sort)
    missing_ids: int = 0  # results without a gaf_contractor_id (dropped)


class GafClient:
    def __init__(self, http: HttpClient, gaf_interval_s: float = 1.0):
        self.http = http
        self.config: CoveoConfig | None = None
        # Be gentle with gaf.com itself; the Coveo API is a separate host.
        http.set_host_interval("www.gaf.com", gaf_interval_s)

    async def discover_config(self, postal_code: str = "10013", radius: float = 25) -> CoveoConfig:
        """Read the live Coveo config from the listing page; fall back to known values."""
        try:
            resp = await self.http.get(
                LISTING_URL, params={"distance": radius, "postalCode": postal_code}, retries=2
            )
            cfg = parse_listing_config(resp.text)
            if cfg:
                log.info("discovered Coveo config from listing page (hub=%s)", cfg.search_hub)
                self.config = cfg
                return cfg
            log.warning("listing page had no Coveo config; using built-in defaults")
        except HttpError as e:
            log.warning("could not load listing page (%s); using built-in defaults", e)
        self.config = CoveoConfig.default()
        return self.config

    async def _search_page(
        self,
        area: SearchArea,
        first: int,
        size: int,
        context: dict[str, Any] | None,
        sort_by_distance: bool = True,
    ) -> dict[str, Any]:
        cfg = self.config or await self.discover_config(area.postal_code, area.radius_miles)
        f = cfg.fields
        dist_field = f.get("distanceInMiles", "distanceinmiles")
        country = COUNTRY_VALUES.get(area.country.upper(), area.country.upper())
        body: dict[str, Any] = {
            "q": "",
            "searchHub": cfg.search_hub,
            "pipeline": cfg.search_hub,
            "locale": "en-US",
            "aq": f"@{dist_field} <= {area.radius_miles} AND @{f.get('countryCode', 'gaf_f_country_code')}=={country}",
            "queryFunctions": [
                {
                    "fieldName": f"@{dist_field}",
                    "function": (
                        f"dist(@{f.get('latitudeField', 'gaf_latitude')}, @{f.get('longitudeField', 'gaf_longitude')}, "
                        f"{area.latitude}, {area.longitude})*0.000621371"
                    ),
                }
            ],
            "firstResult": first,
            "numberOfResults": size,
        }
        if sort_by_distance:
            # A deterministic sort is required for stable pagination.
            body["sortCriteria"] = f"@{dist_field} ascending"
        if context:
            body["context"] = context
        resp = await self.http.post(
            cfg.endpoint,
            json=body,
            headers={"Authorization": f"Bearer {cfg.api_key}", "Content-Type": "application/json"},
        )
        return resp.json()

    async def search_area(
        self, area: SearchArea, *, context: dict[str, Any] | None = None, page_size: int = 500
    ) -> tuple[int, list[dict[str, Any]]]:
        """All contractor results within the area, sorted by distance, de-duplicated."""
        found = await self.search_area_detailed(area, context=context, page_size=page_size)
        return found.total, found.results

    async def search_area_detailed(
        self, area: SearchArea, *, context: dict[str, Any] | None = None, page_size: int = 500
    ) -> AreaSearch:
        """Like search_area, but says why pagination stopped so callers can detect short reads."""
        found = AreaSearch()
        seen: set[str] = set()
        first = 0
        while True:
            size = min(page_size, COVEO_MAX_DEPTH - first)
            if size <= 0:
                found.stop_reason = "depth_limit"
                log.warning(
                    "Coveo depth limit hit (%d of %d results). Tile the area into smaller "
                    "radii/ZIPs to cover the remainder.", len(found.results), found.total,
                )
                break
            data = await self._search_page(area, first, size, context)
            found.pages += 1
            found.total = int(data.get("totalCount") or 0)
            page = data.get("results") or []
            for r in page:
                gid = str(r.get("raw", {}).get("gaf_contractor_id") or "")
                if not gid:
                    found.missing_ids += 1
                elif gid in seen:
                    found.duplicates += 1
                else:
                    seen.add(gid)
                    found.results.append(r)
            first += len(page)
            if not page:
                if first < found.total:
                    found.stop_reason = "empty_page"
                    log.warning("Coveo returned an empty page at offset %d of %d", first, found.total)
                break
            if first >= found.total:
                break
        return found

    async def recommended_ids(self, area: SearchArea) -> list[str]:
        """GAF's own 'Most Relevant' ranking for the area (a quality signal)."""
        cfg = self.config or await self.discover_config(area.postal_code, area.radius_miles)
        # Keep GAF's relevance ordering (no distance sort) -- the order *is* the signal.
        data = await self._search_page(area, 0, 1000, cfg.recommended_context, sort_by_distance=False)
        return [str(r.get("raw", {}).get("gaf_contractor_id")) for r in data.get("results") or []]

    async def fetch_profile(self, gaf_id: str, url: str) -> ContractorProfile:
        resp = await self.http.get(url)
        if looks_blocked(resp.text):
            raise GafBlockedError(f"blocked by bot protection: {url}", status=403, url=url)
        return parse_profile_html(resp.text, gaf_id)
