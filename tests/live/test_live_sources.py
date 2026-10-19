"""Live drift checks: is each external source still shaped the way our parsers expect?

Opt-in only (`pytest -m live`); the default run deselects this module. Every test sends
1-3 requests through the production HttpClient and feeds the live response to the real
parser or scorer, so a renamed column, a moved config attribute or a new bot wall fails
here with the source's own error text. About a dozen requests in total; the per-source
ledger is printed in the terminal summary (see conftest.py).
"""

from __future__ import annotations

import json
import re
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from selectolax.lexbor import LexborHTMLParser

from leadmaker.enrich import fmcsa, ny_dos, nyc_dcwp
from leadmaker.enrich.bbb import PROFILES_INDEX, ROBOTS_URL, BbbEnricher
from leadmaker.enrich.osm import OVERPASS_ENDPOINTS
from leadmaker.models import SearchArea
from leadmaker.signals import counties, news, weather
from leadmaker.sources.gaf.client import LISTING_URL, GafClient
from leadmaker.sources.gaf.parse import DEFAULT_COVEO, looks_blocked, parse_coveo_result, parse_listing_config
from leadmaker.sources.geocode import BUILTIN_CENTROIDS

pytestmark = pytest.mark.live

FIX = Path(__file__).resolve().parents[1] / "fixtures"
EXPECTED_10013_25MI = 424  # data/leadmaker.db, Oct 2026
COUNT_TOLERANCE = 0.10
GAF_PROFILE_PREFIX = "https://www.gaf.com/en-us/roofing-contractors/"


def _area_10013() -> SearchArea:
    lat, lng = BUILTIN_CENTROIDS[("US", "10013")]  # no geocoder request needed
    return SearchArea(postal_code="10013", radius_miles=25, latitude=lat, longitude=lng, geocoder="builtin")


# ---------------------------------------------------------------- GAF (gaf.com + Coveo)
async def test_gaf_locator_page_still_embeds_coveo_search_config(http, memo, note):
    resp = await http.get(LISTING_URL, params={"distance": 25, "postalCode": "10013"}, retries=1)
    assert not looks_blocked(resp.text), f"gaf.com bot wall on the locator page ({len(resp.text)} bytes)"
    cfg = parse_listing_config(resp.text)
    assert cfg is not None, "locator page no longer carries a parseable data-coveo config (selector or JSON changed)"
    assert cfg.discovered
    assert cfg.organization_id and cfg.api_key and cfg.search_hub
    # parse_listing_config pre-fills DEFAULT_FIELDS / DEFAULT_RECOMMENDED_CONTEXT, so cfg alone cannot
    # show whether the page still provides them: read the page's own attributes and compare.
    # Same node parse_listing_config reads (the header search box carries a data-coveo attribute too).
    tree = LexborHTMLParser(resp.text)
    node = tree.css_first("section.coveo-listing__data-wrapper[data-coveo]") or tree.css_first(
        '[data-module="contractor-listing"][data-coveo]'
    )
    page_fields = json.loads(node.attributes.get("data-search-fields") or "{}")
    for key in ("latitudeField", "longitudeField", "distanceInMiles", "countryCode"):
        assert page_fields.get(key), f"data-search-fields lost {key!r} (scraper now runs on built-in defaults)"
        assert cfg.fields[key] == page_fields[key]
    page_sorts = json.loads(node.attributes.get("data-sort-fields") or "[]")
    page_strategy = ((page_sorts[0] if page_sorts else {}).get("context") or {}).get("sortingStrategy")
    assert page_strategy, f"data-sort-fields lost the 'Most Relevant' sortingStrategy: {str(page_sorts)[:200]}"
    assert cfg.recommended_context == {"sortingStrategy": page_strategy}
    memo["coveo_config"] = cfg
    note(f"org={cfg.organization_id} hub={cfg.search_hub} ({len(cfg.fields)} search fields)")
    if (cfg.organization_id, cfg.api_key, cfg.search_hub) != (
        DEFAULT_COVEO["OrganizationId"], DEFAULT_COVEO["ApiKey"], DEFAULT_COVEO["SearchHubPipeline"]
    ):
        # Discovery still works, so the scraper is fine; only the offline fallback has gone stale.
        warnings.warn(
            "live Coveo config differs from DEFAULT_COVEO (key rotated or hub renamed): "
            f"org={cfg.organization_id} hub={cfg.search_hub}; refresh the built-in fallback",
            stacklevel=1,
        )


async def test_coveo_search_for_10013_25mi_returns_about_424_parseable_contractors(http, memo, note):
    gaf = GafClient(http)
    gaf.config = memo.get("coveo_config") or await gaf.discover_config("10013", 25)
    # _search_page builds the exact body the scraper sends; 5 results keep the response small.
    data = await gaf._search_page(_area_10013(), 0, 5, None)
    total = int(data.get("totalCount") or 0)
    note(f"totalCount={total} (expected {EXPECTED_10013_25MI})")
    low, high = EXPECTED_10013_25MI * (1 - COUNT_TOLERANCE), EXPECTED_10013_25MI * (1 + COUNT_TOLERANCE)
    assert low <= total <= high, f"Coveo totalCount {total} for 10013/25mi is outside ±10% of {EXPECTED_10013_25MI}"
    results = data.get("results") or []
    assert len(results) == 5
    dist_field = gaf.config.fields.get("distanceInMiles", "distanceinmiles")
    distances = [r["raw"][dist_field] for r in results]
    assert distances == sorted(distances) and all(0 <= d <= 25 for d in distances), distances
    contractors = [parse_coveo_result(r) for r in results]
    first = contractors[0]
    assert first.gaf_id.isdigit() and first.name
    assert first.profile_url.startswith(GAF_PROFILE_PREFIX), first.profile_url
    assert first.country == "USA" and first.state and first.postal_code
    assert isinstance(first.latitude, float) and isinstance(first.longitude, float)
    assert len({c.gaf_id for c in contractors}) == 5
    assert any(c.designation_codes for c in contractors), "no result carries designation codes (tier field renamed?)"
    memo["profile"] = (first.gaf_id, first.profile_url)
    note(f"nearest={first.name} ({distances[0]:.2f} mi, tier={first.tier.value})")


async def test_gaf_profile_page_parses_and_is_not_bot_blocked(http, memo, note):
    if "profile" in memo:
        gaf_id, url = memo["profile"]
    else:  # run on its own: use a profile URL captured in the saved Coveo fixture
        raw = json.loads((FIX / "coveo_search_response.json").read_text())["results"][0]["raw"]
        gaf_id, url = str(raw["gaf_contractor_id"]), raw["uri"]
    profile = await GafClient(http).fetch_profile(gaf_id, url)  # raises GafBlockedError on the Akamai page
    assert profile.gaf_id == gaf_id
    note(f"{url.rsplit('/', 1)[-1]}: legal_name={profile.legal_name!r} since={profile.in_business_since} "
         f"details={len(profile.details)} reviews={len(profile.reviews)}")
    # Every one of the 424 stored profiles has a "Contractor ID" detail equal to its gaf_id: this proves
    # the .contractor-details__info block (source of years / employees / license) still parses, and
    # that the page is this contractor's.
    assert profile.details.get("Contractor ID") == gaf_id, (
        f"profile {url}: details block missing or renamed, parsed details={profile.details}"
    )
    assert profile.legal_name or profile.in_business_since, (
        f"profile {url} parsed to nothing: no LocalBusiness JSON-LD name and no 'Years in Business' detail"
    )
    if profile.in_business_since:
        assert 1800 <= profile.in_business_since <= datetime.now().year


# ---------------------------------------------------------------- Socrata registries
NY_DOS_COLUMNS = (
    "dos_id", "current_entity_name", "entity_type", "initial_dos_filing_date", "county", "jurisdiction",
    "chairman_name", "dos_process_name", "location_name", "registered_agent_name",
    *(f"{p}_{f}" for p in ("dos_process", "chairman", "location")
      for f in ("address_1", "address_2", "city", "state", "zip")),
)
FMCSA_COLUMNS = tuple(fmcsa.COLS.split(","))
SOCRATA = {
    "ny_dos": (
        ny_dos.DATASET_URL, NY_DOS_COLUMNS,
        "current_entity_name like '%ROOFING%' AND dos_process_zip IS NOT NULL",
        ("dos_id", "current_entity_name", "entity_type"),
    ),
    "nyc_dcwp": (
        nyc_dcwp.DATASET_URL, nyc_dcwp.SELECT_FIELDS,
        f"business_category='{nyc_dcwp.HIC_CATEGORY}' AND contact_phone IS NOT NULL",
        ("license_nbr", "business_name", "business_category", "license_status"),
    ),
    "fmcsa": (
        fmcsa.URL, FMCSA_COLUMNS,
        "phy_state='NJ' AND upper(legal_name) like '%ROOF%' AND phone IS NOT NULL",
        ("dot_number", "legal_name", "phy_state", "phone"),
    ),
}


def _check_row_with_real_parser(source: str, row: dict) -> None:
    if source == "ny_dos":
        # Locality scoring reads <prefix>_city/_state/_zip; a contractor at the process address must match.
        here = {"city": row.get("dos_process_city"), "state": row.get("dos_process_state"),
                "postal_code": row.get("dos_process_zip")}
        assert ny_dos.NyDosEnricher.locality(here, row).same_zip
        assert ny_dos._addr(row, "dos_process")
    elif source == "nyc_dcwp":
        index = nyc_dcwp.HicIndex([row])
        assert sum(len(v) for v in index.by_phone.values()) == 1, "contact_phone no longer a 10-digit phone"
        assert nyc_dcwp.HicIndex.names_of(row)
        assert nyc_dcwp.format_address(row)
    else:
        # The scorer reads phone/legal_name/phy_zip/phy_city; the row scored against itself must clear the bar.
        contractor = {"name": row["legal_name"], "phone": row.get("phone"), "postal_code": row.get("phy_zip"),
                      "city": row.get("phy_city"), "state": row.get("phy_state")}
        conf, evidence = fmcsa.score(contractor, row)
        assert evidence["phone_match"], evidence
        assert conf >= fmcsa.MIN_CONFIDENCE, (conf, evidence)


@pytest.mark.parametrize("source", list(SOCRATA))
async def test_socrata_dataset_answers_with_the_columns_its_enricher_selects(http, source, note):
    url, columns, where, required = SOCRATA[source]
    resp = await http.get(
        url, params={"$select": ",".join(columns), "$where": where, "$limit": "1"},
        headers={"Accept": "application/json"}, allow_statuses=(400, 404), timeout=120,
    )
    # Socrata answers 400 "no such column" when a selected column was renamed or dropped.
    assert resp.status == 200, f"{source}: HTTP {resp.status}: {resp.text[:400]}"
    rows = resp.json()
    assert isinstance(rows, list) and len(rows) == 1, f"{source}: expected one row, got {str(rows)[:300]}"
    row = rows[0]
    note(f"{len(columns)} columns selected OK; sample={row.get(required[0])} / {row.get(required[1])}")
    assert set(row) <= set(columns), f"{source}: unexpected keys {set(row) - set(columns)}"
    missing = [c for c in required if not row.get(c)]
    assert not missing, f"{source}: required columns empty or absent: {missing}"
    _check_row_with_real_parser(source, row)


# ---------------------------------------------------------------- NWS alerts
NWS_COUNTY = "34027"  # Morris County NJ (zone NJC027): frequent alerts, in the 10013/25mi footprint


async def test_nws_alerts_for_one_county_zone_carry_the_fields_weather_reads(http, live_settings, note):
    assert weather.county_zone(NWS_COUNTY) == "NJC027"
    now = datetime.now(timezone.utc)
    # Real fetch: one /alerts history page + one /alerts/active call, with settings.user_agent_contact.
    features, active_ids = await weather.fetch_alerts(http, live_settings, [NWS_COUNTY], history=True, now=now)
    assert len(http.calls) == 2 and all(c.status == 200 for c in http.calls)
    for c in http.calls:
        # fetch_alerts reads page.get("features") or []: a renamed array would look like a quiet week.
        envelope = c.response.json()
        assert isinstance(envelope.get("features"), list), f"NWS reply lost 'features': {c.response.text[:200]}"
        # NWS asks API clients to identify themselves; weather._headers must send the configured contact.
        assert c.headers.get("User-Agent") == live_settings.user_agent_contact, c.headers
    rows, _, _ = weather.alert_rows(features, {NWS_COUNTY}, now)
    note(f"features={len(features)} active={len(active_ids)} rows={len(rows)} "
         f"events={sorted({r['payload']['event'] for r in rows})}")
    if not features:
        pytest.skip("no NWS alerts for Morris County in the last 7 days: reply envelope OK, no fields to check")
    for f in features:
        p = f["properties"]
        for key in ("id", "sent", "messageType", "event", "status", "geocode", "areaDesc"):
            assert key in p, f"NWS feature lost {key!r}: {sorted(p)}"
        assert p.get("ends") or p.get("expires"), f"NWS feature has neither ends nor expires: {p['id']}"
        same = (p.get("geocode") or {}).get("SAME") or []
        assert all(re.fullmatch(r"\d{6}", s) for s in same), same
        assert weather.parse_time(p["sent"]) is not None, p["sent"]
    # alert_rows joins alerts to counties only through geocode.SAME ("0" + county FIPS). We asked for
    # Morris County's zone, so at least one alert must name it there, or every alert is silently dropped.
    covering = [f for f in features if f"0{NWS_COUNTY}" in ((f["properties"].get("geocode") or {}).get("SAME") or [])]
    assert covering, ("no alert for zone NJC027 names Morris County (034027) in geocode.SAME: "
                      f"{[sorted((f['properties'].get('geocode') or {})) for f in features[:3]]}")
    if any(f["properties"].get("messageType") != "Cancel" and f["properties"].get("status") == "Actual"
           for f in covering):
        assert rows, "features name Morris County in SAME but alert_rows produced no rows"
        assert all(r["county_fips"] == NWS_COUNTY and r["payload"]["event"] and r["valid_from"] for r in rows)


# ---------------------------------------------------------------- Census ZCTA -> county
async def test_census_zcta_county_relationship_file_is_still_served_in_the_parsed_format(http, note):
    resp = await http.get(counties.REL_URL, headers={"Range": "bytes=0-4095"}, timeout=120)
    assert resp.status in (200, 206)
    head = resp.text[:5000]
    assert "GEOID_ZCTA5_20" in head[:500], f"unexpected relationship file header: {head[:200]!r}"
    header = head.lstrip("﻿").splitlines()[0].split("|")
    for col in ("GEOID_ZCTA5_20", "GEOID_COUNTY_20", "NAMELSAD_COUNTY_20", "AREALAND_PART"):
        assert col in header, f"relationship file lost column {col}: {header}"
    complete_lines = head[: head.rfind("\n") + 1]
    index = counties.CountyIndex.from_text(complete_lines)
    assert index.names, "no county rows parsed from the first 4 KB"
    note(f"HTTP {resp.status}, {len(header)} columns, {len(index.names)} counties in the first 4 KB")
    assert all(re.fullmatch(r"\d{5}", fips) for fips in index.names)


# ---------------------------------------------------------------- bbb.org
async def test_bbb_robots_still_allows_profiles_and_advertises_the_profile_sitemap(http, live_settings, note):
    bbb = BbbEnricher(live_settings)
    await bbb._load_robots(http)  # raises if the business-profiles sitemap is no longer listed
    assert [c.host for c in http.calls] == ["www.bbb.org"] and http.calls[0].status == 200
    assert bbb.robots.rules, f"no rules parsed from {ROBOTS_URL}"
    assert any(s.rstrip("/") == PROFILES_INDEX for s in bbb.robots.sitemaps)
    locs = json.loads((FIX / "bbb_sitemap_locs.json").read_text())["files"]
    profile = next(u for urls in locs.values() for u in urls if "/us/ny/" in u and "-0121-" in u)
    path = profile.split("www.bbb.org", 1)[1]
    assert bbb.robots.allowed(path), f"robots.txt now disallows profile pages like {path}"
    assert bbb.robots.allowed(PROFILES_INDEX.split("www.bbb.org", 1)[1])
    note(f"{len(bbb.robots.rules)} rules, {len(bbb.robots.sitemaps)} sitemaps; {path} allowed")


# ---------------------------------------------------------------- GDELT
async def test_gdelt_doc_api_answers_one_artlist_query_in_the_parsed_shape(http, note):
    county = {"county_fips": "34003", "county_name": "Bergen County", "state": "NJ"}
    query = news.gdelt_query(county)
    resp = await http.get(
        news.GDELT_URL,
        params={"query": query, "mode": "ArtList", "format": "json", "maxrecords": "10",
                "timespan": f"{news.LOOKBACK_DAYS}d", "sort": "DateDesc"},
        headers={"Accept": "application/json"}, allow_statuses=(429,), retries=0,
    )
    if resp.status == 429:
        pytest.skip("GDELT rate limit (429) -- shared per-IP budget, not a format change")
    articles = news.parse_gdelt(resp.text)  # raises ValueError on GDELT's plain-text errors
    assert isinstance(articles, list)
    assert articles, f"GDELT returned no articles for a 30-day Bergen County query: {query}"
    for a in articles:
        assert a.get("url") and a.get("title") and a.get("domain"), a
        published = news.parse_gdelt_date(a.get("seendate"))
        assert published is not None, f"seendate format changed: {a.get('seendate')!r}"
        assert published > datetime.now(timezone.utc) - timedelta(days=news.LOOKBACK_DAYS + 2)
    candidates = news.gdelt_candidates(county, articles, query)
    note(f"articles={len(articles)} relevant={len(candidates)} newest={articles[0].get('seendate')}")
    assert all(c.county_fips == "34003" and c.source == news.GDELT_SOURCE for c in candidates)


# ---------------------------------------------------------------- Overpass
async def test_overpass_status_endpoint_reports_a_rate_limit(http, note):
    status_url = OVERPASS_ENDPOINTS[0].rsplit("/", 1)[0] + "/status"
    resp = await http.get(status_url, timeout=90)  # the public instance can take ~45 s to answer when busy
    m = re.search(r"Rate limit:\s*(\d+)", resp.text)
    assert m, f"Overpass status format changed: {resp.text[:300]!r}"
    assert re.search(r"slots? available now|Slot available after", resp.text), resp.text[:300]
    note(f"rate limit {m.group(1)}; " + " | ".join(
        line for line in resp.text.splitlines() if "available" in line.lower())[:160])
