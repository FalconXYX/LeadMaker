"""Offline tests for the website-discovery enricher.

HTML fixtures (tests/fixtures/website_discovery_*.html) are real homepages captured
during live runs on 2026-10-18 (trimmed where noted); search-API payloads are
hand-built to Brave's / SerpAPI's documented JSON shapes (no keys were available).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import pytest

from leadmaker.config import Settings
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.website_discovery import (
    WebsiteDiscoveryEnricher,
    bare_host,
    domain_guesses,
    email_domain,
    host_matches,
    DIRECTORY_DOMAINS,
    normalize_origin,
    parked_reason,
    parse_brave_results,
    parse_page,
    parse_serpapi_results,
    score_page,
)
from leadmaker.http import HttpError, Response
from leadmaker.models import Contact, EnrichmentResult, EnrichmentStatus

FIX = Path(__file__).parent / "fixtures"


def fx(name: str) -> str:
    return (FIX / f"website_discovery_{name}.html").read_text()


def ctx_for(**over: Any) -> LeadContext:
    row = {
        "gaf_id": "1142742", "name": "KNA Roofing", "dba": None, "legal_name": "KNA Construction Group LLC",
        "city": "New York", "state": "NY", "postal_code": "10013", "country": "USA",
        "phone": "(718) 288-6808",
    }
    row.update(over)
    return LeadContext(contractor=row)


def score(html: str, url: str, ctx: LeadContext):
    info = parse_page(html, url, ctx.get("phone"))
    assert parked_reason(info, html) is None
    return score_page(info, ctx)


# --------------------------------------------------------------------------- pure helpers


def test_normalize_origin():
    assert normalize_origin("https://www.Zicklin.com/about?x=1") == "https://www.zicklin.com"
    assert normalize_origin("example.com/contact") == "http://example.com"
    assert normalize_origin("http://example.com:8080/") == "http://example.com:8080"
    assert normalize_origin("https://example.com:443/") == "https://example.com"
    assert normalize_origin("mailto:a@b.com") is None
    assert normalize_origin("") is None
    assert normalize_origin("localhost") is None


def test_bare_host_and_directory_matching():
    assert bare_host("WWW.Example.com.") == "example.com"
    assert host_matches("m.yelp.com", DIRECTORY_DOMAINS) == "yelp.com"
    assert host_matches("www.facebook.com", DIRECTORY_DOMAINS) == "facebook.com"
    assert host_matches("notyelp.com", DIRECTORY_DOMAINS) is None
    assert host_matches("kna-roofing.com", DIRECTORY_DOMAINS) is None


def test_email_domain_skips_free_mail():
    assert email_domain("info@KNA-Roofing.com") == "kna-roofing.com"
    assert email_domain("owner@gmail.com") is None
    assert email_domain("x@optonline.net") is None
    assert email_domain("not-an-email") is None
    assert email_domain(None) is None


def test_domain_guesses_basic():
    g = domain_guesses(["ADH Group"], "NY")
    assert g[0] == "adhgroup.com"
    for d in ("adhroofing.com", "adhgroupny.com", "adhgroupnyc.com", "adhinc.com", "adhgroup.net"):
        assert d in g
    assert len(g) <= 16 and len(set(g)) == len(g)
    # bare 3-letter core is never guessed (always someone else's)
    assert "adh.com" not in g


def test_domain_guesses_multiple_names_and_suffixes():
    g = domain_guesses(["KNA Construction Group LLC", "KNA Roofing"], "NY")
    assert g[:2] == ["knaconstructiongroup.com", "knaroofing.com"]
    assert "knaconstructiongroupllc.com" in g
    g2 = domain_guesses(["Zicklin Contracting Inc"], "NY")
    assert g2[0] == "zicklincontracting.com"
    assert "zicklin.com" in g2 and "zicklincontractinginc.com" in g2
    # NJ contractors get nj, not ny/nyc, suffixes
    g3 = domain_guesses(["Trueshield Exteriors LLC"], "NJ")
    assert "trueshieldexteriorsnj.com" in g3
    assert not any(d.endswith("ny.com") or d.endswith("nyc.com") for d in g3)


def test_domain_guesses_ampersand_and_generic_names():
    g = domain_guesses(["Mighty Roofing & Siding"], "NY")
    assert "mightyroofingsiding.com" in g and "mightyroofingandsiding.com" in g and "mightyroofing.com" in g
    g2 = domain_guesses(["Roof Roof Roofing"], "NJ")
    assert g2[0] == "roofroofroofing.com"
    assert not any("roofingroofing" in d for d in g2)
    assert domain_guesses([], "NY") == []


# --------------------------------------------------------------------------- page scoring


def test_phone_on_page_is_strong_evidence():
    s = score(fx("kna_roofing"), "https://kna-roofing.com/", ctx_for())
    assert s.score >= 0.95
    assert any("phone 7182886808" in e for e in s.evidence)
    assert any(e.startswith("name~") for e in s.evidence)


def test_same_page_without_phone_match_relies_on_name_and_locality():
    # Same KNA page, but pretend the GAF phone differs: exact title name + Brooklyn/NY + roofing words.
    c = ctx_for(phone="(212) 555-0100", city="Brooklyn")
    s = score(fx("kna_roofing"), "https://kna-roofing.com/", c)
    assert 0.6 <= s.score <= 0.8
    assert not any(e.startswith("phone ") for e in s.evidence)


def test_name_and_city_match_with_unrelated_phone_still_accepted():
    # Real site whose phone differs from GAF's (GAF lists a 410 number).
    c = ctx_for(gaf_id="1145160", name="Latin Brothers Construction LLC", legal_name="Latin Brothers Construction LLC",
                city="Jersey City", state="NJ", postal_code="07304", phone="(410) 501-4655")
    s = score(fx("latin_brothers"), "https://www.latinbrothersconstructionllc.com/", c)
    assert s.score >= 0.6, s


def test_same_name_different_city_is_rejected():
    # "Elite Roofing" in Toronto vs Elite Roofing Contractors Inc in Jersey City.
    c = ctx_for(gaf_id="1153632", name="Elite Roofing Contractors Inc", legal_name=None, city="Jersey City",
                state="NJ", postal_code="07306", phone="(201) 436-1011")
    s = score(fx("elite_toronto"), "https://eliteroofing.com/", c)
    assert s.score < 0.6
    assert any("non-local" in e for e in s.evidence)


def test_unrelated_business_with_generic_name_rejected():
    c = ctx_for(name="Mighty Roofing & Siding", legal_name="Mighty Roofing & Siding", city="Brooklyn",
                phone="(718) 873-1236")
    s = score(fx("unrelated_mighty"), "https://www.mighty.com/", c)
    assert s.score < 0.6


@pytest.mark.parametrize("name", ["godaddy_lander", "godaddy_launching_soon", "reserved", "hugedomains", "inquire_domain", "shopify_password"])
def test_parked_and_placeholder_pages_detected(name):
    html = fx(name)
    url = "https://www.hugedomains.com/domain_profile.cfm?d=x" if name == "hugedomains" else "https://x.com/"
    info = parse_page(html, url, "(718) 288-6808")
    assert parked_reason(info, html) is not None


def test_parse_page_extracts_tel_links_and_jsonld():
    html = """<html><head><title>Acme Roofing | Hoboken NJ</title>
    <meta property="og:site_name" content="Acme Roofing &amp; Siding">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"RoofingContractor","name":"Acme Exteriors LLC","telephone":"+1-201-555-0142"}]}</script>
    </head><body><h1>Roof repair in Hoboken</h1><a href="tel:+12015550199">Call</a>
    <p>Call 973.555.0123 today</p><script>var x = "(908) 555-0000";</script></body></html>"""
    info = parse_page(html, "https://acme.example/", None)
    assert info.title == "Acme Roofing | Hoboken NJ"
    assert "Acme Roofing & Siding" in info.site_names and "Acme Exteriors LLC" in info.site_names
    assert info.explicit_phones == {"2015550142", "2015550199"}
    assert "9735550123" in info.phones
    assert "9085550000" not in info.phones  # scripts are not page text


def test_phone_hidden_in_script_counts():
    html = '<html><head><title>Home</title></head><body><div id="root"></div>' \
           '<script>window.__DATA__={"phone":"718-873-1236"}</script></body></html>'
    info = parse_page(html, "https://x.example/", "(718) 873-1236")
    assert info.raw_digits_hit
    c = ctx_for(phone="(718) 873-1236")
    assert score_page(info, c).score >= 0.9


def test_title_that_is_just_the_domain_is_not_name_evidence():
    html = "<html><head><title>knaroofing.com</title></head><body>Roofing roofs in Brooklyn NY</body></html>"
    info = parse_page(html, "https://knaroofing.com/", None)
    s = score_page(info, ctx_for(city="Brooklyn", phone=None))
    assert s.score < 0.6


# --------------------------------------------------------------------------- search API parsers


def test_parse_brave_and_serpapi_results():
    brave = {"type": "search", "web": {"type": "search", "results": [
        {"title": "KNA Roofing", "url": "https://kna-roofing.com/", "description": "..."},
        {"title": "KNA Roofing - Yelp", "url": "https://www.yelp.com/biz/kna-roofing-brooklyn"},
    ]}}
    assert parse_brave_results(brave) == ["https://kna-roofing.com/", "https://www.yelp.com/biz/kna-roofing-brooklyn"]
    assert parse_brave_results({}) == []
    serp = {"knowledge_graph": {"title": "KNA Roofing", "website": "https://kna-roofing.com/"},
            "local_results": {"places": [{"title": "KNA", "links": {"website": "https://kna-roofing.com"}}]},
            "organic_results": [{"position": 1, "title": "KNA", "link": "https://kna-roofing.com/about"}]}
    assert parse_serpapi_results(serp) == [
        "https://kna-roofing.com", "https://kna-roofing.com/", "https://kna-roofing.com/about"]


# --------------------------------------------------------------------------- end to end (fake DNS + HTTP)


class FakeHttp:
    """Mimics HttpClient: statuses in allow_statuses are returned, other non-2xx raise HttpError."""

    def __init__(self, handler: Callable[[str, dict[str, Any]], Response | Exception]):
        self.handler = handler
        self.calls: list[str] = []

    async def get(self, url: str, **kw: Any) -> Response:
        self.calls.append(url)
        out = self.handler(url, kw)
        if isinstance(out, Exception):
            raise out
        if not out.ok and out.status not in kw.get("allow_statuses", ()):
            raise HttpError(f"HTTP {out.status} for {url}", status=out.status, url=url)
        return out


def page(url: str, html: str, status: int = 200) -> Response:
    return Response(url=url, status=status, text=html, headers={"content-type": "text/html"})


def make_enricher(monkeypatch, live: set[str], brave: str | None = None) -> WebsiteDiscoveryEnricher:
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    monkeypatch.delenv("SERPAPI_KEY", raising=False)
    if brave:
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", brave)
    e = WebsiteDiscoveryEnricher(Settings())

    async def fake_resolve(host: str):
        return ["192.0.2.1"] if host in live else None

    monkeypatch.setattr(e, "_resolve", fake_resolve)
    return e


def site_router(pages: dict[str, Response | Exception]):
    def handle(url: str, kw: dict[str, Any]):
        if url.endswith("/robots.txt"):
            return page(url, "not found", 404)
        if url in pages:
            return pages[url]
        return HttpError(f"network error for {url}: could not resolve", url=url)

    return handle


async def test_enrich_domain_guess_finds_phone_verified_site(monkeypatch):
    e = make_enricher(monkeypatch, live={"knaroofing.com", "knaconstruction.com"})
    http = FakeHttp(site_router({
        "https://knaroofing.com/": page("https://kna-roofing.com/", fx("kna_roofing")),  # redirect
        "https://knaconstruction.com/": page("https://knaconstruction.com/", fx("godaddy_lander")),
    }))
    r = await e.enrich(ctx_for(), http)
    assert r.status == EnrichmentStatus.OK
    assert r.website == "https://kna-roofing.com"
    assert r.data["website"] == "https://kna-roofing.com"
    assert r.data["method"] == "domain_guess"
    assert r.confidence >= 0.95
    assert "https://kna-roofing.com/" in r.source_urls
    top = r.data["candidates"][0]
    assert set(top) >= {"url", "score", "evidence"}
    assert any("redirected from knaroofing.com" in ev for ev in top["evidence"])
    # no HTTP for domains that don't resolve
    assert all("knacontracting" not in u for u in http.calls)


async def test_enrich_no_match_keeps_scored_candidates(monkeypatch):
    e = make_enricher(monkeypatch, live={"eliteroofing.com", "eliteroofingcontractors.com"})
    http = FakeHttp(site_router({
        "https://eliteroofing.com/": page("https://eliteroofing.com/", fx("elite_toronto")),
        "https://eliteroofingcontractors.com/": page("https://eliteroofingcontractors.com/", fx("godaddy_lander")),
    }))
    c = ctx_for(gaf_id="1153632", name="Elite Roofing Contractors Inc", legal_name=None, city="Jersey City",
                state="NJ", postal_code="07306", phone="(201) 436-1011")
    r = await e.enrich(c, http)
    assert r.status == EnrichmentStatus.NO_MATCH
    urls = {x["url"]: x for x in r.data["candidates"]}
    assert urls["https://eliteroofing.com"]["score"] < 0.6
    assert any("parked" in ev for ev in urls["https://eliteroofingcontractors.com"]["evidence"])


async def test_enrich_prefers_prior_website_and_rejects_directories(monkeypatch):
    e = make_enricher(monkeypatch, live=set())
    prior = {
        "google_places": EnrichmentResult(source="google_places", status=EnrichmentStatus.OK, confidence=0.95,
                                          website="https://kna-roofing.com/", data={"website": "https://kna-roofing.com/"}),
        "osm": EnrichmentResult(source="osm", status=EnrichmentStatus.OK, confidence=0.8,
                                website="https://www.yelp.com/biz/kna", data={"email": "info@kna-roofing.com"}),
    }
    http = FakeHttp(site_router({"https://kna-roofing.com/": page("https://kna-roofing.com/", fx("kna_roofing"))}))
    c = ctx_for()
    c.prior = prior
    r = await e.enrich(c, http)
    assert r.status == EnrichmentStatus.OK
    assert r.website == "https://kna-roofing.com"
    assert r.data["method"] == "google_places"
    assert r.confidence >= 0.95
    assert not any("yelp" in u for u in http.calls)
    # phone-verified known site: no domain guessing needed
    assert r.data["probed"] == 1


async def test_enrich_unverifiable_prior_website_falls_back_to_source_confidence(monkeypatch):
    e = make_enricher(monkeypatch, live=set())
    c = ctx_for()
    c.prior = {"google_places": EnrichmentResult(source="google_places", status=EnrichmentStatus.OK,
                                                 confidence=0.95, website="https://www.kna-roofing.com")}
    http = FakeHttp(site_router({"https://www.kna-roofing.com/": page("https://www.kna-roofing.com/", "denied", 403)}))
    r = await e.enrich(c, http)
    assert r.status == EnrichmentStatus.OK
    assert r.website == "https://www.kna-roofing.com"
    assert 0.6 <= r.confidence < 0.8


async def test_enrich_email_domain_candidate(monkeypatch):
    e = make_enricher(monkeypatch, live=set())
    c = ctx_for()
    c.prior = {"osm": EnrichmentResult(source="osm", status=EnrichmentStatus.OK, confidence=0.7,
                                       data={"email": "office@kna-roofing.com"},
                                       contacts=[Contact(name="X", email="x@gmail.com", source="osm")])}
    http = FakeHttp(site_router({"https://kna-roofing.com/": page("https://kna-roofing.com/", fx("kna_roofing"))}))
    r = await e.enrich(c, http)
    assert r.status == EnrichmentStatus.OK
    assert r.data["method"] == "email_domain"
    assert not any("gmail" in u for u in http.calls)


async def test_enrich_respects_robots_disallow(monkeypatch):
    e = make_enricher(monkeypatch, live={"knaroofing.com"})

    def handle(url: str, kw: dict[str, Any]):
        if url == "https://knaroofing.com/robots.txt":
            return page(url, "User-agent: *\nDisallow: /\n")
        if url.endswith("/"):
            pytest.fail(f"homepage fetched despite robots.txt: {url}")
        return HttpError("nope", url=url)

    r = await e.enrich(ctx_for(), FakeHttp(handle))
    assert r.status == EnrichmentStatus.NO_MATCH
    assert any("robots" in ev for x in r.data["candidates"] for ev in x["evidence"])


async def test_enrich_brave_search_candidates_when_key_set(monkeypatch):
    e = make_enricher(monkeypatch, live=set(), brave="brave-test-key")
    brave = {"web": {"results": [{"url": "https://www.yelp.com/biz/kna"}, {"url": "https://kna-roofing.com/services"}]}}
    seen_headers: dict[str, str] = {}

    def handle(url: str, kw: dict[str, Any]):
        if url.startswith("https://api.search.brave.com/"):
            seen_headers.update(kw.get("headers") or {})
            return Response(url=url, status=200, text=json.dumps(brave), headers={})
        return site_router({"https://kna-roofing.com/": page("https://kna-roofing.com/", fx("kna_roofing"))})(url, kw)

    r = await e.enrich(ctx_for(), FakeHttp(handle))
    assert seen_headers.get("X-Subscription-Token") == "brave-test-key"
    assert r.status == EnrichmentStatus.OK
    assert r.data["method"] == "search_api"
    assert r.website == "https://kna-roofing.com"


async def test_enrich_nothing_resolves(monkeypatch):
    e = make_enricher(monkeypatch, live=set())
    http = FakeHttp(lambda url, kw: pytest.fail("no HTTP when nothing resolves"))
    r = await e.enrich(ctx_for(), http)
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data["candidates"] == [] and r.data["probed"] == 0


def test_probe_capped_times_out_without_raising(monkeypatch):
    import asyncio as _a
    from leadmaker.enrich import website_discovery as wd

    async def slow(self, http, cand, ctx):
        await _a.sleep(5)

    monkeypatch.setattr(wd, "PROBE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(wd.WebsiteDiscoveryEnricher, "_probe", slow)
    enr = wd.WebsiteDiscoveryEnricher.__new__(wd.WebsiteDiscoveryEnricher)
    p = _a.run(enr._probe_capped(None, wd.Candidate("slow.example", "domain_guess"), None))
    assert p.origin is None and p.score == 0.0 and "timed out" in (p.error or "")
