"""Offline tests for the BBB public-profile enricher.

Fixtures (tests/fixtures/bbb_*), all real bbb.org responses captured 2026-10-18 for
research/reviews_directories, trimmed:
  * bbb_robots.txt                 -- https://www.bbb.org/robots.txt, verbatim;
  * bbb_sitemap_index.xml          -- sitemap-business-profiles-index.xml, first 8 entries;
  * bbb_sitemap_profiles_head.xml  -- sitemap-business-profiles-1.xml, first 3 entries;
  * bbb_sitemap_locs.json          -- real profile URLs regrouped into 8 small child sitemaps
                                      that keep BBB's bureau-code order;
  * bbb_profile_*.html             -- profile pages reduced to JSON-LD + the businessProfile part
                                      of window.__PRELOADED_STATE__ (obfuscated e-mails removed).
"""

from __future__ import annotations

import gzip
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from leadmaker.config import Settings
from leadmaker.enrich import REGISTRY, bbb, load_enricher_class
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.bbb import (
    BbbEnricher,
    ProfileIndex,
    ProfileRef,
    Robots,
    parse_profile,
    parse_profile_sitemap,
    parse_sitemap_index,
    rank_candidates,
    score_profile,
    services_from_categories,
)
from leadmaker.http import HttpError, Response
from leadmaker.models import EnrichmentStatus

FIX = Path(__file__).parent / "fixtures"
ROBOTS = (FIX / "bbb_robots.txt").read_text()
INDEX_XML = (FIX / "bbb_sitemap_index.xml").read_text()
HEAD_XML = (FIX / "bbb_sitemap_profiles_head.xml").read_text()
FILES: dict[str, list[str]] = json.loads((FIX / "bbb_sitemap_locs.json").read_text())["files"]
PROFILE_URLS = {
    "high_caliber": "https://www.bbb.org/us/nj/rahway/profile/roofing-consultants/high-caliber-renovations-llc-0221-90204787",
    "reisch": "https://www.bbb.org/us/nj/pompton-plains/profile/roofing-contractors/reisch-roofing-and-construction--0221-90190070",
    "crudellos": "https://www.bbb.org/us/nj/morsemere/profile/roofing-contractors/crudellos-roofing-0221-90238322",
    "elite_roofing_contractor": "https://www.bbb.org/us/nj/jersey-city/profile/roofing-contractors/elite-roofing-contractor-inc-0221-3002221",
    "elite_roof_services": "https://www.bbb.org/us/nj/leonia/profile/roofing-contractors/elite-roof-services-0221-90224664",
    "nj_roofing_siding": "https://www.bbb.org/us/nj/long-branch/profile/roofing-contractors/nj-roofing-siding-llc-0221-90224972",
    "maspeth": "https://www.bbb.org/us/ny/maspeth/profile/roofing-contractors/maspeth-roofing-and-siding-0121-239",
    "a_s_construction": "https://www.bbb.org/us/ny/staten-island/profile/home-improvement/a-s-construction-son-inc-0121-87180240",
    "excellence_contracting": "https://www.bbb.org/us/ny/bay-shore/profile/home-improvement/excellence-contracting-corp-0121-130832",
    "mark_of_excellence": "https://www.bbb.org/us/ny/congers/profile/home-improvement/mark-of-excellence-contracting-corp-0121-79247",
}
PAGES = {url: (FIX / f"bbb_profile_{key}.html").read_text() for key, url in PROFILE_URLS.items()}

# Real GAF contractor rows (subset of columns) from the scraped DB.
C = {
    "high_caliber": {"gaf_id": "1131213", "name": "High Caliber Renovations LLC", "dba": None,
                     "legal_name": "High Caliber Renovations LLC", "street": "417 Madison Ave", "city": "Rahway",
                     "state": "NJ", "postal_code": "07065", "phone": "(908) 472-5096",
                     "latitude": 40.601091, "longitude": -74.295127},
    "reisch": {"gaf_id": "1118403", "name": "Reisch Roofing and Construction LLC", "dba": None, "legal_name": None,
               "street": "312 Sunset Rd", "city": "Pompton Plains", "state": "NJ", "postal_code": "07444",
               "phone": "(855) 734-7241", "latitude": 40.957587, "longitude": -74.323953},
    "crudellos": {"gaf_id": "1129061", "name": "Crudellos LLC", "dba": None, "legal_name": "Crudellos LLC",
                  "street": "471 Abbott Ave", "city": "Ridgefield", "state": "NJ", "postal_code": "07657",
                  "phone": "(201) 478-0012", "latitude": 40.830823, "longitude": -74.007766},
    "all_elite": {"gaf_id": "1155767", "name": "All Elite Roofing", "dba": None, "legal_name": "All Elite Roofing & Siding",
                  "street": "131 Main St Ste 122", "city": "Hackensack", "state": "NJ", "postal_code": "07601",
                  "phone": "(551) 335-9235", "latitude": 40.882392, "longitude": -74.044009},
    "maspeth": {"gaf_id": "1002561", "name": "Maspeth Roofing & Siding", "dba": None,
                "legal_name": "Maspeth Contracting Corp", "street": "5430 44th St", "city": "Maspeth", "state": "NY",
                "postal_code": "11378", "phone": "(718) 639-2200", "latitude": 40.731152, "longitude": -73.923766},
    "a_s": {"gaf_id": "1120367", "name": "A&S Construction & Son Inc", "dba": None,
            "legal_name": "A&S Construction & Son Inc", "street": "929 70th St", "city": "Brooklyn", "state": "NY",
            "postal_code": "11228", "phone": "(347) 326-4098", "latitude": 40.628085, "longitude": -74.012368},
    "excellence": {"gaf_id": "1142470", "name": "Excellence Home Improvements", "dba": None,
                   "legal_name": "Excellence Home Improvements", "street": "235 Sunrise Hwy", "city": "Merrick",
                   "state": "NY", "postal_code": "11566", "phone": "(800) 443-4388",
                   "latitude": 40.660459, "longitude": -73.56175},
}

_URL_TMPL = ("  <url>\n    <loc>{}</loc>\n    <lastmod>2026-10-17</lastmod>\n    <priority>1.0</priority>\n"
             "    <changefreq>daily</changefreq>\n  </url>\n")


def render_sitemap(locs: list[str]) -> str:
    """A child sitemap in bbb.org's exact format (wrapper taken from the real fixture)."""
    return HEAD_XML[: HEAD_XML.find("  <url>")] + "".join(_URL_TMPL.format(u) for u in locs) + "</urlset>\n"


class FakeHttp:
    """Serves the bbb.org fixtures and records every request."""

    def __init__(self, robots: str = ROBOTS, fail_index: bool = False):
        self.robots = robots
        self.fail_index = fail_index
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    def paths(self, prefix: str = "") -> list[str]:
        return [urlsplit(u).path for u, _ in self.calls if urlsplit(u).path.startswith(prefix)]

    async def get(self, url: str, headers: dict[str, str] | None = None, allow_statuses: tuple[int, ...] = (),
                  **kw: Any) -> Response:
        headers = dict(headers or {})
        self.calls.append((url, headers))
        path = urlsplit(url).path
        if path == "/robots.txt":
            return Response(url=url, status=200, text=self.robots, headers={})
        if path == "/sitemap-business-profiles-index.xml":
            if self.fail_index:
                raise HttpError(f"HTTP 503 for {url}", status=503, url=url)
            return Response(url=url, status=200, text=INDEX_XML, headers={})
        if m := re.fullmatch(r"/sitemap-business-profiles-(\d+)\.xml", path):
            xml = render_sitemap(FILES[m.group(1)])
            if (rng := headers.get("Range")) and (m2 := re.fullmatch(r"bytes=0-(\d+)", rng)):
                return Response(url=url, status=206, text=xml[: int(m2.group(1)) + 1], headers={})
            return Response(url=url, status=200, text=xml, headers={})
        if url in PAGES:
            return Response(url=url, status=200, text=PAGES[url], headers={})
        if 404 in allow_statuses:
            return Response(url=url, status=404, text="<html>Not found</html>", headers={})
        raise HttpError(f"HTTP 404 for {url}", status=404, url=url)


async def _enricher(tmp_path: Path, contractors: list[dict[str, Any]] | None = None,
                    http: FakeHttp | None = None) -> tuple[BbbEnricher, FakeHttp]:
    e = BbbEnricher(Settings())
    e.cache_dir = tmp_path
    http = http or FakeHttp()
    await e.prepare(http, contractors if contractors is not None else list(C.values()))  # type: ignore[arg-type]
    return e, http


async def _run(e: BbbEnricher, http: FakeHttp, key: str, **override: Any):
    return await e.enrich(LeadContext(contractor={**C[key], **override}), http)  # type: ignore[arg-type]


# -- robots / sitemaps -----------------------------------------------------------------
def test_robots_wildcards_on_real_robots_txt():
    r = Robots(ROBOTS)
    assert r.allowed("/us/nj/rahway/profile/roofing-consultants/high-caliber-renovations-llc-0221-90204787")
    assert r.allowed("/sitemap-business-profiles-76.xml")
    assert not r.allowed("/search?find_text=roofing&find_loc=Rahway")  # Disallow: /*?
    assert not r.allowed("/business-reviews/roofing-contractors/rahway-nj")
    # The longer `Allow: /us/*/*/profile/*/*?` beats `Disallow: /*?`.
    assert r.allowed("/us/nj/rahway/profile/roofing-consultants/high-caliber-0221-1?tab=x")
    assert bbb.PROFILES_INDEX in r.sitemaps


def test_robots_group_selection_and_end_anchor():
    r = Robots("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private$\nAllow: /\n")
    assert r.allowed("/us/x") and r.allowed("/private/sub")
    assert not r.allowed("/private")
    assert not Robots("User-agent: *\nDisallow: /us/\n").allowed("/us/nj/a/profile/b/c-0221-1")


def test_parse_sitemaps_real_format():
    files = parse_sitemap_index(INDEX_XML)
    assert files[0] == "https://www.bbb.org/sitemap-business-profiles-1.xml"
    assert len(files) == 8 and files[-1].endswith("-8.xml")
    rows = parse_profile_sitemap(HEAD_XML)
    assert rows[0] == ProfileRef("md", "baltimore", "fuel-oil", "carroll-independent-fuel-llc", "0011-10000060")
    assert rows[0].url == "https://www.bbb.org/us/md/baltimore/profile/fuel-oil/carroll-independent-fuel-llc-0011-10000060"
    assert parse_profile_sitemap(HEAD_XML, {"0121"}) == []
    # Double dash before the id (name ending in punctuation) stays part of the slug.
    reisch = parse_profile_sitemap(render_sitemap([PROFILE_URLS["reisch"]]))[0]
    assert reisch.slug == "reisch-roofing-and-construction-" and reisch.url == PROFILE_URLS["reisch"]


async def test_prepare_locates_bureau_files_by_bisection_and_caches(tmp_path):
    e, http = await _enricher(tmp_path)
    assert http.intervals == {"www.bbb.org": 1.5}
    assert http.paths()[:2] == ["/robots.txt", "/sitemap-business-profiles-index.xml"]
    probes = [u for u, h in http.calls if "Range" in h]
    assert probes and all(h["Range"] == "bytes=0-2047" for u, h in http.calls if "Range" in h)
    full = sorted(int(re.search(r"-(\d+)\.xml", u).group(1)) for u, h in http.calls
                  if "Range" not in h and "sitemap-business-profiles-" in u and "index" not in u)
    # 0121 = files 2-4 (file 2 starts with 0117 but ends in 0121); 0221 = files 5-6 (5 starts with 0141).
    assert full == [2, 3, 4, 5, 6]
    assert e.index is not None
    assert {r.bureau for r in e.index.rows} == {"0121", "0221"}
    assert len(e.index.rows) == sum(1 for f in FILES.values() for u in f if re.search(r"-0[12]21-\d+$", u))
    for b in ("0121", "0221"):
        with gzip.open(tmp_path / "bbb" / f"profiles-{b}.tsv.gz", "rt") as f:
            meta = json.loads(f.readline().lstrip("#"))
        assert meta["bureau"] == b and meta["built_at"] <= time.time()

    # A second run inside the TTL reads the cache: only robots.txt is fetched.
    e2, http2 = await _enricher(tmp_path)
    assert http2.paths() == ["/robots.txt"]
    assert len(e2.index.rows) == len(e.index.rows)


async def test_only_needed_bureaus_are_built(tmp_path):
    _, http = await _enricher(tmp_path, [C["maspeth"]])
    assert (tmp_path / "bbb" / "profiles-0121.tsv.gz").exists()
    assert not (tmp_path / "bbb" / "profiles-0221.tsv.gz").exists()


async def test_expired_cache_is_used_when_refresh_fails(tmp_path, monkeypatch):
    e, _ = await _enricher(tmp_path)
    monkeypatch.setattr(bbb, "INDEX_TTL_HOURS", 0.0)
    e2, http2 = await _enricher(tmp_path, http=FakeHttp(fail_index=True))
    assert http2.paths() == ["/robots.txt", "/sitemap-business-profiles-index.xml"]
    assert len(e2.index.rows) == len(e.index.rows)


async def test_refresh_failure_without_cache_raises(tmp_path):
    with pytest.raises(HttpError):
        await _enricher(tmp_path, http=FakeHttp(fail_index=True))


async def test_prepare_fails_if_robots_stops_advertising_sitemap(tmp_path):
    with pytest.raises(RuntimeError, match="sitemap"):
        await _enricher(tmp_path, http=FakeHttp(robots="User-agent: *\nDisallow:\n"))


# -- profile parsing -------------------------------------------------------------------
def test_parse_profile_high_caliber():
    p = parse_profile(PAGES[PROFILE_URLS["high_caliber"]])
    assert p is not None
    assert p["bbb_id"] == "0221-90204787" and p["name"] == "High Caliber Renovations LLC"
    assert p["phone"] == "(908) 472-5096" and p["zip"] == "07065-2224"
    assert p["website"] == "https://www.highcaliberrenovations.com"
    assert p["people"] == [
        {"name": "Mary Cuppari", "title": "Owner", "prefix": "Ms.", "principal": True, "management": True},
        {"name": "Frank Cuppari", "title": "Manager", "prefix": "Mr.", "principal": True, "management": True},
    ]
    assert p["licenses"] == [{"number": "13VH11041800", "agency": "NJ Division of Consumer Affairs",
                              "expiration": None, "notes": None}]
    assert p["rating"] == "A+" and p["accredited"] is False and p["accredited_since"] is None
    assert p["business_start"] == "2020-06-03" and p["years_in_business"] == 6
    assert p["entity_type"] == "Limited Liability Company (LLC)"
    assert p["employees"] is None  # BBB reports 0 when unknown
    assert p["social"] == {"facebook": "https://facebook.com/high-caliber-renovations-102456044763899"}
    assert p["local_bbb"] == "BBB Serving New Jersey"


def test_parse_profile_filters_placeholder_contacts_and_lapsed_accreditation():
    a_s = parse_profile(PAGES[PROFILE_URLS["a_s_construction"]])
    assert a_s["people"] == []  # the only listed contact is "Customer Service"
    maspeth = parse_profile(PAGES[PROFILE_URLS["maspeth"]])
    assert maspeth["accredited"] is False and maspeth["accredited_since"] is None
    assert maspeth["previously_accredited"] is True
    assert parse_profile("<html><body>no state here</body></html>") is None
    assert parse_profile("<script>window.__PRELOADED_STATE__ = {broken</script>") is None


def test_services_from_categories():
    reisch = parse_profile(PAGES[PROFILE_URLS["reisch"]])
    s = services_from_categories(reisch["categories"])
    assert {"siding", "gutters", "windows", "flat_roofing", "commercial_roofing", "waterproofing", "metal_roofing",
            "tile_roofing", "general_contracting", "inspections"} <= set(s)
    assert services_from_categories(["Roofing Contractors"]) == []


# -- matching --------------------------------------------------------------------------
async def test_match_high_caliber(tmp_path):
    e, http = await _enricher(tmp_path)
    r = await _run(e, http, "high_caliber")
    assert r.status == EnrichmentStatus.OK and r.confidence >= 0.9
    url = PROFILE_URLS["high_caliber"]
    d = r.data
    assert d["profile_url"] == url and d["bbb_id"] == "0221-90204787"
    assert d["bbb_name"] == "High Caliber Renovations LLC"
    assert d["rating"] == "A+" and d["accredited"] is False
    assert d["business_start"] == "2020-06-03" and d["years_in_business"] == 6
    assert d["licenses"][0]["number"] == "13VH11041800"
    assert d["categories"] == ["Roofing Consultants", "Siding Contractors", "Gutters", "Replacement Windows"]
    assert {"siding", "gutters", "windows"} <= set(d["services"])
    assert d["complaints_total"] == 0
    assert d["match_evidence"]["phone_match"] and d["match_evidence"]["address_match"]
    assert r.website == "https://www.highcaliberrenovations.com"
    assert [(c.name, c.title, c.source, c.source_url) for c in r.contacts] == [
        ("Mary Cuppari", "Owner", "bbb", url), ("Frank Cuppari", "Manager", "bbb", url)]
    assert all(c.confidence == round(r.confidence * 0.9, 3) for c in r.contacts)
    assert r.source_urls == [url]
    # Exactly one profile fetched: stops at the first phone-verified match.
    assert http.paths("/us/") == [urlsplit(url).path]


async def test_match_maspeth_via_legal_name_and_phone(tmp_path):
    e, http = await _enricher(tmp_path)
    r = await _run(e, http, "maspeth")
    assert r.status == EnrichmentStatus.OK and r.confidence >= 0.9
    assert r.data["bbb_name"] == "Maspeth Roofing and Siding"
    assert r.data["years_in_business"] == 33 and r.data["previously_accredited"] is True
    assert r.data["match_evidence"]["same_street"] is True
    assert [(c.name, c.title) for c in r.contacts] == [
        ("John M. Schenone", "President"), ("Willie Stephens", "Director of Marketing and Business Development")]


async def test_match_a_s_by_phone_despite_other_borough(tmp_path):
    e, http = await _enricher(tmp_path)
    r = await _run(e, http, "a_s")
    assert r.status == EnrichmentStatus.OK
    ev = r.data["match_evidence"]
    assert ev["phone_match"] and not ev["address_match"] and ev["distance_miles"] > 4
    assert r.contacts == []
    assert r.data["licenses"][0]["number"] == "2058754-DCA"


async def test_untitled_principal_gets_generic_title(tmp_path):
    e, http = await _enricher(tmp_path)
    r = await _run(e, http, "crudellos")
    assert r.status == EnrichmentStatus.OK
    assert [(c.name, c.title) for c in r.contacts] == [("Alex Crudello", "Principal")]


async def test_untitled_management_only_person_has_no_title(tmp_path):
    """Audit: untitled BBB 'Business Management' people (e.g. GAF 1001655 Stephen / Andrea Ferrari,
    1135399 Geraldo Metko) were stored with the made-up title 'Business management'. Now title=None;
    the BBB flags stay in data['people']."""
    url = PROFILE_URLS["crudellos"]
    page = PAGES[url].replace('"isPrincipal":true', '"isPrincipal":false')
    assert page != PAGES[url]

    class MgmtHttp(FakeHttp):
        async def get(self, u: str, **kw: Any) -> Response:
            if u == url:
                self.calls.append((u, {}))
                return Response(url=u, status=200, text=page, headers={})
            return await super().get(u, **kw)

    e, http = await _enricher(tmp_path, http=MgmtHttp())
    r = await _run(e, http, "crudellos")
    assert r.status == EnrichmentStatus.OK
    assert [(c.name, c.title, c.source) for c in r.contacts] == [("Alex Crudello", None, "bbb")]
    assert r.data["people"] == [{"name": "Alex Crudello", "title": None, "prefix": None,
                                 "principal": False, "management": True}]


async def test_reisch_without_people(tmp_path):
    e, http = await _enricher(tmp_path)
    r = await _run(e, http, "reisch")
    assert r.status == EnrichmentStatus.OK and r.contacts == []
    assert r.data["licensing_text"].startswith("NJ License: 13VH09822200")
    assert len(r.data["categories"]) == 48


async def test_namesakes_are_not_accepted(tmp_path):
    """Research false-positive guards: same-name businesses with another phone, miles away."""
    e, http = await _enricher(tmp_path)
    r = await _run(e, http, "excellence")
    assert r.status == EnrichmentStatus.NO_MATCH
    fetched = r.data["fetched"]
    assert fetched and not any(f.get("accept") for f in fetched)
    # The house-cleaning namesake is dropped by category before any fetch.
    assert not any("house-cleaning" in f["url"] for f in fetched)
    assert len(fetched) <= bbb.MAX_FETCHES and r.source_urls == [f["url"] for f in fetched]

    r = await _run(e, http, "all_elite")
    assert r.status == EnrichmentStatus.NO_MATCH
    assert {f["url"] for f in r.data["fetched"]} <= {PROFILE_URLS[k] for k in
                                                     ("elite_roofing_contractor", "elite_roof_services", "nj_roofing_siding")}
    assert not any(f.get("accept") for f in r.data["fetched"])


async def test_name_plus_address_without_phone(tmp_path):
    e, http = await _enricher(tmp_path)
    # Same name + same ZIP/location but a different phone: accepted on address agreement (0.9).
    r = await _run(e, http, "high_caliber", phone="(908) 555-0100")
    assert r.status == EnrichmentStatus.OK and r.confidence >= 0.9
    assert not r.data["match_evidence"]["phone_match"] and r.data["match_evidence"]["address_match"]
    # ... but not from another town with another phone.
    r = await _run(e, http, "high_caliber", phone="(908) 555-0100", postal_code="07901", city="Summit",
                   latitude=40.7157, longitude=-74.3646, street="1 Elm St")
    assert r.status == EnrichmentStatus.NO_MATCH


def test_short_name_needs_phone_or_exact_name_and_address():
    """Live-run case: GAF 'KLG Contracting Inc' (other phone) = BBB 'KLG Contracting Inc.' at the same street."""
    p = parse_profile((FIX / "bbb_profile_klg.html").read_text())
    klg = {"gaf_id": "1108368", "name": "KLG Contracting Inc", "dba": None, "legal_name": "KLG Contracting Inc",
           "street": "1816 45th St Fl 2", "city": "Astoria", "state": "NY", "postal_code": "11105",
           "phone": "(917) 745-6289", "latitude": 40.7765, "longitude": -73.9089}
    ev = score_profile(LeadContext(contractor=klg), p)
    assert ev["accept"] and ev["same_street"] and not ev["phone_match"] and "short_name" not in ev["reasons"]
    assert p["people"][0]["name"] == "Lefteris Kamberis" and p["people"][0]["title"] == "CEO"
    # A 3-letter name in the same ZIP but another street and a different full name stays capped.
    other = {**klg, "name": "KLG Roofing", "legal_name": None, "street": "2000 31st St", "latitude": None,
             "longitude": None}
    ev = score_profile(LeadContext(contractor=other), p)
    assert not ev["accept"] and "short_name" in ev["reasons"]


def test_trade_word_namesake_in_same_zip_is_not_accepted():
    """Loose names drop trade words: 'Elite Roofing' == 'Elite Home Improvement' (1.0). Same ZIP, other
    phone and street -> not the same business; the strict name has to agree as well."""
    p = parse_profile(PAGES[PROFILE_URLS["high_caliber"]])
    ctx = LeadContext(contractor={**C["high_caliber"], "name": "Elite Roofing LLC", "legal_name": None,
                                  "phone": "(908) 555-0100", "street": "90 Elm Ave"})
    ev = score_profile(ctx, {**p, "name": "Elite Home Improvement Inc", "alt_names": []})
    assert ev["name_similarity"] == 1.0 and ev["address_match"] and not ev["same_street"]
    assert not ev["accept"] and "strict_name_differs" in ev["reasons"]
    # The same name variant with a phone match is still accepted.
    ev = score_profile(LeadContext(contractor={**ctx.contractor, "phone": C["high_caliber"]["phone"]}),
                       {**p, "name": "Elite Home Improvement Inc", "alt_names": []})
    assert ev["accept"] and ev["phone_match"]


async def test_unreadable_candidate_is_an_error_not_no_match(tmp_path):
    """A 503 on one candidate must not be stored as no_match (the 30-day TTL would never retry it)."""

    class FlakyHttp(FakeHttp):
        async def get(self, url: str, **kw: Any) -> Response:
            if url == PROFILE_URLS["elite_roofing_contractor"]:
                self.calls.append((url, {}))
                raise HttpError(f"HTTP 503 for {url}", status=503, url=url)
            return await super().get(url, **kw)

    e, http = await _enricher(tmp_path, http=FlakyHttp())
    r = await _run(e, http, "all_elite")
    assert PROFILE_URLS["elite_roofing_contractor"] in [u for u, _ in http.calls]
    assert r.status == EnrichmentStatus.ERROR and "HTTP 503" in (r.error or "")


def test_shared_phone_needs_a_name():
    p = parse_profile(PAGES[PROFILE_URLS["a_s_construction"]])
    ctx = LeadContext(contractor={**C["a_s"], "name": "Swift Build", "legal_name": None})
    assert score_profile(ctx, p)["accept"] is True  # phone alone
    ev = score_profile(ctx, p, phone_shared=True)
    assert ev["accept"] is False and "phone_shared_by_multiple_gaf_contractors" in ev["reasons"]


def test_rank_candidates_prefers_same_city_trade_slug():
    refs = [ProfileRef("nj", "rahway", "pharmacy", "high-caliber", "0221-1"),
            ProfileRef("nj", "newark", "roofing-contractors", "high-caliber-renovations", "0221-2"),
            ProfileRef("nj", "rahway", "roofing-consultants", "high-caliber-renovations-llc", "0221-3"),
            ProfileRef("nj", "rahway", "roofing-contractors", "low-caliber-pizza", "0221-4")]
    ranked = rank_candidates(LeadContext(contractor=C["high_caliber"]), refs)
    assert [r.bbb_id for _, _, r in ranked][:2] == ["0221-3", "0221-2"]
    idx = ProfileIndex(refs + [ProfileRef("ny", "rahway", "roofing", "high-caliber-renovations", "0121-9")])
    assert {r.bbb_id for r in idx.candidates(["High Caliber Renovations LLC"], "NJ")} == {"0221-1", "0221-2", "0221-3", "0221-4"}


async def test_missing_profile_and_robots_block(tmp_path):
    e, http = await _enricher(tmp_path)
    gone = ProfileRef("nj", "rahway", "roofing-contractors", "high-caliber-renovations", "0221-99")
    e.index = ProfileIndex([gone])
    r = await _run(e, http, "high_caliber")
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data["fetched"] == [{"url": gone.url, "status": "missing_or_unparsable"}]

    e.robots = Robots("User-agent: *\nDisallow: /us/\n")
    e._profiles.clear()
    before = len(http.calls)
    r = await _run(e, http, "high_caliber")
    assert r.status == EnrichmentStatus.ERROR and "robots.txt disallows" in (r.error or "")
    assert len(http.calls) == before  # nothing fetched


async def test_profiles_shared_between_contractors_are_fetched_once(tmp_path):
    e, http = await _enricher(tmp_path)
    await _run(e, http, "high_caliber")
    await _run(e, http, "high_caliber", gaf_id="dup", phone="(908) 555-0100")
    assert http.paths("/us/").count(urlsplit(PROFILE_URLS["high_caliber"]).path) == 1


def test_registry_and_applicability():
    assert REGISTRY["bbb"] == "leadmaker.enrich.bbb:BbbEnricher"
    cls = load_enricher_class("bbb")
    assert cls is BbbEnricher and cls.depends_on == ()
    e = BbbEnricher(Settings())
    assert e.applies_to(LeadContext(contractor=C["maspeth"]))
    assert not e.applies_to(LeadContext(contractor={**C["maspeth"], "state": "CT"}))


# -- licence numbers -------------------------------------------------------------------
def test_license_key_normalisation():
    """Formats seen in GAF profile_details['State License Number'] and BBB licences (Oct 2026 DB)."""
    assert bbb.license_key("13VH 11322900") == "13VH11322900"  # BBB Roof4Roof
    assert bbb.license_key("13vh09838700") == "13VH09838700"  # GAF 1135245 Pro Line Construction
    assert bbb.license_key("VH13917400") == "13VH13917400"  # GAF 1160491 Trueshield Exteriors
    assert bbb.license_key("NJ13VH06259200") == "13VH06259200"
    assert bbb.license_key("2058754-DCA") == "2058754DCA"
    for junk in ("WAIVER", "NOT REQUIRED", "Active", "WCH", "49353", "", None):
        assert bbb.license_key(junk) is None


def _lic(key: str, number: str) -> dict[str, Any]:
    return {**C[key], "profile_details": {"Contractor ID": C[key]["gaf_id"], "State License Number": number}}


async def test_license_match_counts_like_a_phone(tmp_path):
    """GAF 1131213 High Caliber Renovations lists NJ HIC 13VH11041800, as does its BBB profile. With
    another phone and another town (no phone, no address agreement) the licence alone verifies it."""
    e, http = await _enricher(tmp_path)
    away = dict(phone="(908) 555-0100", postal_code="07901", city="Summit", latitude=40.7157,
                longitude=-74.3646, street="1 Elm St")
    r = await e.enrich(LeadContext(contractor={**_lic("high_caliber", "13vh11041800"), **away}), http)
    assert r.status == EnrichmentStatus.OK and r.confidence >= 0.9
    ev = r.data["match_evidence"]
    assert ev["license_match"] and not ev["phone_match"] and not ev["address_match"] and "license" in ev["reasons"]
    # The same contractor without its licence number is (still) rejected -- see test_name_plus_address_without_phone.
    r = await _run(e, http, "high_caliber", **away)
    assert r.status == EnrichmentStatus.NO_MATCH


def test_license_match_raises_phone_less_address_match():
    """Audit: GAF 1135296 Priority One Construction LLC (13VH10388700, phone (201) 640-7850) was
    accepted at 0.9 on name + ZIP only; BBB lists phone (800) 213-0775 and the same 13VH10388700."""
    p = parse_profile(PAGES[PROFILE_URLS["high_caliber"]])
    prof = {**p, "name": "Priority One Construction LLC", "alt_names": [], "phone": "(800) 213-0775",
            "additional_phones": [], "street": None, "city": "Fairfield", "zip": "07004",
            "latitude": 40.8768, "longitude": -74.2990,
            "licenses": [{"number": "13VH10388700", "agency": "NJ Division of Consumer Affairs",
                          "expiration": None, "notes": None}], "licensing_text": None}
    gaf = {"gaf_id": "1135296", "name": "Priority One Construction LLC", "dba": None,
           "legal_name": "Priority One Construction LLC", "street": "1 Anthony Ln", "city": "Fairfield",
           "state": "NJ", "postal_code": "07004", "phone": "(201) 640-7850", "latitude": 40.891667,
           "longitude": -74.295588}
    before = score_profile(LeadContext(contractor=gaf), prof)
    assert before["accept"] and before["confidence"] == 0.9 and not before["license_match"]
    after = score_profile(LeadContext(contractor={**gaf, "profile_details": {"State License Number": "13VH10388700"}}),
                          prof)
    assert after["accept"] and after["license_match"] and after["confidence"] == 0.99
    # A licence quoted only in the free-text licensing note counts too (Reisch: "NJ License: 13VH09822200").
    text_only = {**prof, "licenses": [], "licensing_text": "NJ License: 13VH10388700"}
    assert score_profile(LeadContext(contractor={**gaf, "profile_details": {"State License Number": "VH10388700"}}),
                         text_only)["license_match"]


def test_license_mismatch_is_only_a_reason():
    """Audit: GAF 1132680 Quality Roofing (13VH13428300) = BBB 'Quality Roofing' (13VH11202700), Kearny,
    same ZIP: re-registered businesses keep the match; the mismatch is recorded, not a reject."""
    p = parse_profile(PAGES[PROFILE_URLS["high_caliber"]])
    prof = {**p, "name": "Quality Roofing", "alt_names": ["Quality Contracting Group", "Quality Group"],
            "phone": "(201) 780-7419", "additional_phones": [], "street": "504-508 Kearny Ave", "city": "Kearny",
            "zip": "07032-2703", "latitude": None, "longitude": None, "licensing_text": None,
            "licenses": [{"number": "13VH11202700", "agency": "NJ Division of Consumer Affairs",
                          "expiration": None, "notes": None}]}
    gaf = {"gaf_id": "1132680", "name": "Quality Roofing", "dba": None, "legal_name": "Quality Roofer LLC",
           "street": "220 Brighton Ave", "city": "Kearny", "state": "NJ", "postal_code": "07032",
           "phone": "(201) 283-2875", "latitude": 40.765911, "longitude": -74.151368,
           "profile_details": {"State License Number": "13VH13428300"}}
    ev = score_profile(LeadContext(contractor=gaf), prof)
    assert ev["accept"] and ev["confidence"] == 0.9 and not ev["license_match"]
    assert "license_differs" in ev["reasons"]
    # A placeholder on either side is no evidence at all.
    ev = score_profile(LeadContext(contractor={**gaf, "profile_details": {"State License Number": "WAIVER"}}), prof)
    assert "license_differs" not in ev["reasons"] and not ev["license_match"]


def test_license_survives_a_shared_phone():
    """A phone listed for several GAF contractors is dropped as evidence; a licence number is not."""
    p = parse_profile(PAGES[PROFILE_URLS["a_s_construction"]])  # BBB licence 2058754-DCA
    ctx = LeadContext(contractor={**C["a_s"], "name": "Swift Build", "legal_name": None,
                                  "profile_details": {"State License Number": "2058754 DCA"}})
    ev = score_profile(ctx, p, phone_shared=True)
    assert ev["accept"] and ev["license_match"] and not ev["phone_match"]


# -- BBB websites: labelled fallback, never evidence -----------------------------------
def test_bbb_website_is_a_labelled_fallback_but_never_evidence():
    """Audit: 46 leads carried a BBB-listed website (website_source='bbb'), e.g. GAF 1156862 'Bergen
    Exteriors' -> BBB 'Bergen Fence' -> https://www.bergenfence.com. It may be shown / crawled as a
    last resort, but no matcher may treat it as identity evidence."""
    from leadmaker.enrich.base import WEBSITE_NOT_EVIDENCE, WEBSITE_PRIORITY
    from leadmaker.models import EnrichmentResult

    assert WEBSITE_PRIORITY[-1] == "bbb" and "bbb" in WEBSITE_NOT_EVIDENCE
    bbb_ok = EnrichmentResult(source="bbb", status=EnrichmentStatus.OK, confidence=0.9,
                              website="https://www.bergenfence.com")
    lead = {"gaf_id": "1156862", "name": "Bergen Exteriors", "state": "NJ"}
    ctx = LeadContext(contractor=lead, prior={"bbb": bbb_ok})
    assert ctx.website_for() == ("https://www.bergenfence.com", "bbb")
    assert ctx.best_website(evidence=True) is None
    # Already stored on the contractor row (website_source='bbb'): same rule.
    stored = LeadContext(contractor={**lead, "website": "https://www.bergenfence.com", "website_source": "bbb"})
    assert stored.best_website() == "https://www.bergenfence.com" and stored.website_for(evidence=True) == (None, None)
    # Any verified source wins over the listing, for display and for evidence.
    found = EnrichmentResult(source="website_discovery", status=EnrichmentStatus.OK, confidence=0.8,
                             website="https://bergenexteriors.example")
    ctx = LeadContext(contractor=lead, prior={"bbb": bbb_ok, "website_discovery": found})
    assert ctx.website_for() == ctx.website_for(evidence=True) == ("https://bergenexteriors.example", "website_discovery")
