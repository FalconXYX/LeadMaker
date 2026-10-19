"""Offline tests for the web_signals enricher (digital presence, ad pixels, financing, archives).

Fixtures:
  * website_crawl_american_siding_home.html -- the real homepage of americansidingconstruction.com
    (GAF lead 1109046), captured during the 2026-10-18 live run;
  * web_signals_americansiding_stored.json -- that lead's live web_signals result as stored in
    data/leadmaker.db (copied from a snapshot), used as the expected output;
  * web_signals_cdx_americansiding.json -- Wayback CDX rows (fl=timestamp,statuscode,
    collapse=timestamp:6) whose first/last capture and month count match the stored summary; the
    months in between are spread evenly (the summary is all that was stored);
  * web_signals_rdap_verisign_americansiding.json -- an RFC 9083 / Verisign-shaped RDAP domain
    response carrying the stored registration, expiry and registrar values;
  * web_signals_robots_wordpress.txt, web_signals_wp_sitemap_index.xml,
    web_signals_gtm_container_trimmed.js, web_signals_homepage_headers.json -- the WordPress
    defaults and a trimmed GTM container consistent with the stored result.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import pytest

from leadmaker.config import Settings
from leadmaker.enrich import web_signals as ws
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.web_signals import WebSignalsEnricher
from leadmaker.http import HttpError, Response
from leadmaker.models import EnrichmentResult, EnrichmentStatus

FIX = Path(__file__).parent / "fixtures"
HOME_HTML = (FIX / "website_crawl_american_siding_home.html").read_text(errors="ignore")
STORED = json.loads((FIX / "web_signals_americansiding_stored.json").read_text())
SITE = "https://americansidingconstruction.com"
CDX_URL = WebSignalsEnricher.CDX
RDAP_COM = "https://rdap.verisign.com/com/v1/domain/"


def fx(name: str) -> str:
    return (FIX / f"web_signals_{name}").read_text()


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """copyright_year / talking_points read the wall clock; pin it to the fixture capture date."""

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            return datetime(2026, 10, 18, 12, 0, tzinfo=tz or timezone.utc)

    monkeypatch.setattr(ws, "datetime", FrozenDatetime)


# --------------------------------------------------------------------------- fake network


def resp(status: int = 200, text: str = "", url: str = "", headers: dict[str, str] | None = None) -> Response:
    return Response(url=url, status=status, text=text, headers=headers or {"content-type": "text/html"})


Route = Response | Exception | Callable[[str, dict[str, Any]], "Response | Exception"]


class FakeHttp:
    """Serves canned responses by exact URL; unknown URLs are 404.

    Mimics HttpClient: statuses in allow_statuses are returned, any other non-2xx raises HttpError.
    """

    def __init__(self, routes: dict[str, Route]):
        self.routes = routes
        self.calls: list[dict[str, Any]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    def urls(self) -> list[str]:
        return [c["url"] for c in self.calls]

    def call(self, url: str) -> dict[str, Any]:
        return next(c for c in self.calls if c["url"] == url)

    async def get(self, url: str, **kw: Any) -> Response:
        self.calls.append({"url": url, **kw})
        out = self.routes.get(url, resp(404, "<html>Not found</html>"))
        if callable(out) and not isinstance(out, Response):
            out = out(url, kw)
        if isinstance(out, Exception):
            raise out
        if not out.url:
            out = Response(url=url, status=out.status, text=out.text, headers=out.headers, content=out.content)
        if not out.ok and out.status not in kw.get("allow_statuses", ()):
            raise HttpError(f"HTTP {out.status} for {url}", status=out.status, url=url)
        return out


def american_siding_routes() -> dict[str, Route]:
    """The public endpoints web_signals reads for americansidingconstruction.com."""
    headers = json.loads(fx("homepage_headers.json"))
    return {
        f"{SITE}/robots.txt": resp(200, fx("robots_wordpress.txt"), headers={"content-type": "text/plain"}),
        # the bare origin redirects to the canonical "/" URL
        SITE: resp(200, HOME_HTML, url=f"{SITE}/", headers=headers),
        "https://www.googletagmanager.com/gtm.js?id=GTM-M2W4GHDJ": resp(200, fx("gtm_container_trimmed.js")),
        f"{SITE}/wp-sitemap.xml": resp(200, fx("wp_sitemap_index.xml"), headers={"content-type": "application/xml"}),
        CDX_URL: resp(200, fx("cdx_americansiding.json"), headers={"content-type": "application/json"}),
        RDAP_COM + "americansidingconstruction.com": resp(200, fx("rdap_verisign_americansiding.json")),
    }


def ctx_for(website: str | None = SITE, discovery_conf: float | None = 0.8, **over: Any) -> LeadContext:
    row = dict(STORED["contractor"])
    row["website"] = None
    row.update(over)
    prior: dict[str, EnrichmentResult] = {}
    if website is not None and discovery_conf is not None:
        prior["website_discovery"] = EnrichmentResult(
            source="website_discovery", status=EnrichmentStatus.OK, confidence=discovery_conf, website=website)
    elif website is not None:
        row["website"] = website
    return LeadContext(contractor=row, prior=prior)


async def run(http: FakeHttp, ctx: LeadContext | None = None, **attrs: Any) -> EnrichmentResult:
    e = WebSignalsEnricher(Settings())
    for k, v in attrs.items():
        setattr(e, k, v)
    return await e.enrich(ctx or ctx_for(), http)  # type: ignore[arg-type]


def page(body: str, head: str = "") -> str:
    """A small but non-placeholder homepage (>300 chars of visible text) around `body`."""
    filler = "<p>" + "Family-owned roofing and siding contractor serving Bergen County homeowners. " * 6 + "</p>"
    return f"<html><head><title>Acme Roofing</title>{head}</head><body>{filler}{body}</body></html>"


# --------------------------------------------------------------------------- end to end on real data


async def test_enrich_reproduces_stored_live_result_for_american_siding():
    http = FakeHttp(american_siding_routes())
    r = await run(http)
    stored = STORED["web_signals"]
    assert r.status == EnrichmentStatus.OK
    assert r.data == stored["data"]
    assert r.source_urls == stored["source_urls"]
    assert r.website == stored["website"] == f"{SITE}/"
    assert r.confidence == stored["confidence"] == 0.8


async def test_enrich_request_plan_is_polite_and_bounded():
    http = FakeHttp(american_siding_routes())
    await run(http)
    # robots first, then the homepage; one request per endpoint, nothing else (no financing page here).
    assert http.urls() == [
        f"{SITE}/robots.txt", SITE, "https://www.googletagmanager.com/gtm.js?id=GTM-M2W4GHDJ",
        f"{SITE}/wp-sitemap.xml", CDX_URL, RDAP_COM + "americansidingconstruction.com",
    ]
    assert http.intervals == {"web.archive.org": 1.5}
    cdx = http.call(CDX_URL)
    assert cdx["params"] == {"url": "americansidingconstruction.com", "output": "json",
                             "fl": "timestamp,statuscode", "collapse": "timestamp:6"}
    assert cdx["retries"] == 2 and cdx["timeout"] == 40
    rdap = http.call(RDAP_COM + "americansidingconstruction.com")
    assert rdap["headers"] == {"Accept": "application/rdap+json"} and rdap["allow_statuses"] == (404,)
    home = http.call(SITE)
    assert home["retries"] == 1 and {401, 403, 404, 410, 451, 500, 503} <= set(home["allow_statuses"])
    assert http.call(f"{SITE}/wp-sitemap.xml")["retries"] == 0


def test_homepage_parsers_match_stored_live_result():
    stored = STORED["web_signals"]["data"]
    headers = json.loads(fx("homepage_headers.json"))
    assert ws.fingerprint(HOME_HTML, headers) == stored["tech"]
    assert ws.brands_mentioned(HOME_HTML) == stored["brands"] == ["GAF", "CertainTeed", "TAMKO"]
    assert ws.social_links(HOME_HTML) == stored["social"] == {}
    assert ws.copyright_year(HOME_HTML) == stored["copyright_year"] == 2026
    assert ws.schema_org(HOME_HTML) == stored["schema_org"]
    assert ws.careers_info(HOME_HTML, f"{SITE}/") == stored["careers"]
    assert ws.financing_providers(HOME_HTML) == []
    assert ws.visible_text_len(HOME_HTML) > 300
    assert ws._GTM_ID.search(HOME_HTML).group(1) == stored["gtm"]["id"]
    assert ws.gtm_ad_tags(fx("gtm_container_trimmed.js")) == stored["gtm"]["ad_tags"]
    assert ws.sitemap_lastmod(fx("wp_sitemap_index.xml")) == {"entries": 3, "lastmod_max": None}


def test_parse_cdx_and_rdap_fixtures_give_stored_summaries():
    stored = STORED["web_signals"]["data"]
    assert ws.parse_cdx(json.loads(fx("cdx_americansiding.json"))) == stored["wayback"]
    rdap = ws.parse_rdap(json.loads(fx("rdap_verisign_americansiding.json")))
    assert {**rdap, "rdap_url": RDAP_COM + "americansidingconstruction.com"} == stored["domain"]


# --------------------------------------------------------------------------- fingerprinting


def test_wp_page_builder_only_counts_on_wordpress():
    elementor = '<div class="elementor elementor-12"><div class="et_pb_row">x</div></div>'
    assert "wp_builder" not in ws.fingerprint(elementor)
    on_wp = ws.fingerprint('<link href="/wp-content/themes/divi/style.css">' + elementor)
    assert on_wp["cms"] == ["WordPress"]
    assert on_wp["wp_builder"] == ["Elementor", "Divi"]


def test_fingerprint_reads_response_headers_case_insensitively():
    tech = ws.fingerprint("<html></html>", {"X-Wix-Request-Id": "1760799129.123", "X-Kinsta-Cache": "HIT"})
    assert tech == {"cms": ["Wix"], "hosting": ["Kinsta"]}
    assert ws.fingerprint("<html></html>", None) == {}


def test_ad_pixels_analytics_and_martech_are_separated():
    html = """<script async src="https://www.googletagmanager.com/gtag/js?id=AW-11223344556"></script>
    <script>gtag('config', 'G-ABC123XYZ9'); gtag('config', 'AW-11223344556');
    !function(f,b,e,v,n,t,s){}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '1234567890');</script>
    <script src="//bat.bing.com/bat.js"></script><script src="https://cdn.callrail.com/companies/1/swap.js"></script>
    <script src="https://widgets.leadconnectorhq.com/loader.js"></script><script src="https://app.roofle.com/w.js"></script>"""
    tech = ws.fingerprint(html)
    assert tech["ad_pixel"] == ["Google Ads", "Meta Pixel", "Microsoft Ads (UET)"]
    assert tech["analytics"] == ["Google Analytics"]  # GA4 config is analytics, not an ad pixel
    assert tech["call_tracking"] == ["CallRail"]
    assert tech["crm_marketing"] == ["GoHighLevel / LeadConnector"]
    assert tech["chat"] == ["LeadConnector chat"]
    assert tech["instant_quote"] == ["Roofle (RoofQuote PRO)"]


def test_ga4_only_site_is_not_flagged_as_advertising():
    html = "<script>gtag('config', 'G-ZXCV12345');</script>"
    assert "ad_pixel" not in ws.fingerprint(html)


def test_financing_providers_are_named_from_links_and_text():
    html = ('<a href="https://www.svcfin.com/apply?dealer=123">Apply</a> Financing through GreenSky and '
            '<img src="https://cdn.example/wisetack-badge.png">')
    assert ws.financing_providers(html) == ["GreenSky", "Service Finance Company", "Wisetack"]
    assert ws.financing_providers("<p>Ask about our finance options</p>") == []


def test_brands_come_from_visible_text_and_logo_attributes_not_scripts():
    html = """<script>var gaf = "Owens Corning";</script>
    <p>Certified installer of Owens-Corning Duration shingles and James Hardie siding.</p>
    <img src="/wp-content/uploads/certainteed_shinglemaster_badge.png" alt="badge">
    <img alt="IKO Preferred Contractor" src="/a.png">"""
    assert ws.brands_mentioned(html) == ["Owens Corning", "CertainTeed", "IKO", "James Hardie"]
    # word boundaries: "Gaffney" / "bikoff" are not GAF / IKO
    assert ws.brands_mentioned("<p>Call Bob Gaffney at Bikoff Roofing</p>") == []


def test_generic_gutter_leaf_guards_are_not_the_leaffilter_brand():
    # Real stored crawl text from 3 leads whose web_signals brands list LeafFilter (roof4roof.com,
    # mlmconstructiongroupnyc.com, rightteamconstructionllc.com): each only sells generic leaf guards.
    for text in ("Flat Roofs Gutters & Leaf Guards Painting & Caulking Entry Doors",
                 "Fall offer: free leaf guards with full installation.",
                 "Seamless gutter systems, leaf guards, vinyl & cedar siding, soffit and fascia"):
        assert "LeafFilter / Leaf Guard" not in ws.brands_mentioned(f"<p>{text}</p>"), text


def test_named_leaffilter_and_leafguard_still_count():
    assert ws.brands_mentioned("<p>Authorized LeafFilter dealer</p>") == ["LeafFilter / Leaf Guard"]
    assert ws.brands_mentioned('<img alt="LeafGuard logo" src="/l.png">') == ["LeafFilter / Leaf Guard"]


def test_social_links_skip_share_widgets_and_fall_back_to_embedded_video():
    html = """<a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
    <a href="https://www.facebook.com/AcmeRoofingNJ/">fb</a>
    <a href="https://www.instagram.com/p/Cxyz/">post</a><a href="https://instagram.com/acme.roofing">ig</a>
    <a href="https://twitter.com/intent/tweet?text=hi">tweet</a><a href="https://x.com/AcmeRoof">x</a>
    <a href="https://www.yelp.com/biz/acme-roofing-hoboken">yelp</a>
    <iframe src="https://www.youtube.com/embed/abc123"></iframe>"""
    assert ws.social_links(html) == {
        "facebook": "https://www.facebook.com/AcmeRoofingNJ",
        "instagram": "https://instagram.com/acme.roofing",
        "x": "https://x.com/AcmeRoof",
        "yelp": "https://www.yelp.com/biz/acme-roofing-hoboken",
        "youtube_embed": "embedded video",
    }
    channel = ws.social_links('<a href="https://www.youtube.com/@AcmeRoofing">yt</a><iframe src="https://youtu.be/x">')
    assert channel == {"youtube": "https://www.youtube.com/@AcmeRoofing"}


def test_careers_info_finds_same_site_page_hiring_text_and_ats():
    html = """<a href="mailto:jobs@acme.com">Email</a><a href="https://indeed.com/cmp/acme">Jobs on Indeed</a>
    <a href="/join-our-team/">Join Our Team</a><p>We're hiring roofers!</p>
    <script src="https://acme.bamboohr.com/js/embed.js"></script>"""
    info = ws.careers_info(html, "https://www.acme.com/")
    assert info == {"page": "https://www.acme.com/join-our-team/", "hiring_text": True, "ats": ["Indeed", "BambooHR"]}
    # an off-site careers link is not "their" careers page
    assert ws.careers_info('<a href="https://other.com/careers">Careers</a>', "https://acme.com/")["page"] is None


def test_find_page_matches_label_or_path_on_same_site_only():
    html = ('<a href="https://www.acme.com/r4r/financing/">Options</a>'
            '<a href="https://lender.com/financing">Apply</a><a href="tel:+12015550100">Financing hotline</a>')
    assert ws.find_page(html, "https://acme.com/", ws._FIN_HINT) == "https://www.acme.com/r4r/financing/"
    assert ws.find_page('<a href="/pay">Flexible Financing</a>', "https://acme.com/", ws._FIN_HINT) == "https://acme.com/pay"
    assert ws.links('<a href="javascript:void(0)">x</a><a href="/a">A <b>b</b></a>', "https://acme.com/x/") == [
        ("https://acme.com/a", "A b")]


def test_copyright_year_takes_latest_plausible_year():
    assert ws.copyright_year("<footer>&copy; 2012 - 2024 Acme Roofing LLC</footer>") == 2024
    assert ws.copyright_year("<footer>Copyright © Acme Roofing 2019. All rights reserved.</footer>") == 2019
    # 2029 is beyond next year (clock pinned to 2026) and 1985 predates the web: both ignored
    assert ws.copyright_year("<p>Copyright 1985</p><p>© 2029 Acme</p>") is None
    assert ws.copyright_year("<p>No footer here</p>") is None


def test_schema_org_collects_business_facts_and_job_postings():
    ld = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "WebSite", "name": "Acme", "founder": "Not A Business Node"},
            {"@type": ["LocalBusiness", "RoofingContractor"], "name": "Acme Roofing",
             "founder": [{"@type": "Person", "name": "Luis Gomez"}, "Ana Gomez"],
             "employee": {"@type": "Person", "name": "Mark Diaz"},
             "foundingDate": "2006", "numberOfEmployees": {"@type": "QuantitativeValue", "value": 12},
             "priceRange": "$$", "legalName": "Acme Roofing LLC",
             "areaServed": [{"@type": "City", "name": "Hoboken"}, "Jersey City"],
             "sameAs": "https://www.facebook.com/acme",
             "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.9", "reviewCount": "130"}},
            {"@type": "JobPosting", "title": "Roofer"}, {"@type": "JobPosting", "title": "Foreman"},
        ],
    }
    html = (f'<script type="application/ld+json">{json.dumps(ld)}</script>'
            '<script type="application/ld+json">{not json</script>')
    assert ws.schema_org(html) == {
        "types": ["localbusiness", "roofingcontractor"],
        "founder": ["Luis Gomez", "Ana Gomez"],
        "employee": ["Mark Diaz"],
        "foundingDate": "2006", "numberOfEmployees": 12, "priceRange": "$$", "legalName": "Acme Roofing LLC",
        "areaServed": ["Hoboken", "Jersey City"],
        "sameAs": ["https://www.facebook.com/acme"],
        "aggregateRating": {"ratingValue": "4.9", "reviewCount": "130"},
        "job_postings": 2,
    }
    assert ws.schema_org("<p>no json-ld</p>") == {}


def test_sitemap_lastmod_reports_entry_count_and_newest_date():
    xml = ("<urlset><url><loc>https://a.com/</loc><lastmod>2026-03-01T10:00:00+00:00</lastmod></url>"
           "<url><loc>https://a.com/roofing/</loc><lastmod>2026-09-16</lastmod></url>"
           "<url><loc>https://a.com/old/</loc><lastmod>2019-01-02</lastmod></url></urlset>")
    assert ws.sitemap_lastmod(xml) == {"entries": 3, "lastmod_max": "2026-09-16"}


def test_gtm_ad_tags_cover_escaped_container_ids():
    js = r'"vtp_conversionId":"123" ... "\x22awct\x22" ... src=\"https://bat.bing.com/bat.js\" ... callrail'
    assert ws.gtm_ad_tags(js) == ["Google Ads", "Microsoft Ads (UET)", "CallRail"]
    assert ws.gtm_ad_tags('{"function":"__html","vtp_html":"<p>hi</p>"}') == []


# --------------------------------------------------------------------------- archive / registry parsing


def test_parse_cdx_handles_header_only_headerless_and_empty_rows():
    empty = {"first_capture": None, "last_capture": None, "months_captured": 0, "first_year": None}
    assert ws.parse_cdx([]) == empty
    assert ws.parse_cdx([["timestamp", "statuscode"]]) == empty
    rows = [["20211209033012", "200"], ["20211215000000", "301"], [], ["20230104101010", "200"]]
    assert ws.parse_cdx(rows) == {"first_capture": "2021-12-09", "last_capture": "2023-01-04",
                                  "months_captured": 2, "first_year": 2021}


def test_parse_rdap_ignores_non_registrar_entities_and_missing_events():
    d = {"events": [{"eventAction": "registration", "eventDate": "2025-08-21T15:02:44Z"}],
         "entities": [{"roles": ["registrant"], "vcardArray": ["vcard", [["fn", {}, "text", "REDACTED FOR PRIVACY"]]]},
                      {"roles": ["registrar"], "vcardArray": ["vcard", [["version", {}, "text", "4.0"],
                                                                        ["fn", {}, "text", "IONOS SE"]]]}]}
    assert ws.parse_rdap(d) == {"registered": "2025-08-21", "expires": None, "registrar": "IONOS SE"}
    assert ws.parse_rdap({}) == {"registered": None, "expires": None, "registrar": None}
    assert ws.parse_rdap({"entities": [{"roles": ["registrar"]}]})["registrar"] is None


@pytest.mark.parametrize("url,domain", [
    ("https://www.roof4roof.com/", "roof4roof.com"),
    ("roof-roof-roofing.com", "roof-roof-roofing.com"),
    ("http://shop.acme-roofing.com:8080/x", "acme-roofing.com"),
    ("https://www.acmeroofing.co.uk/about", "acmeroofing.co.uk"),
    ("https://brooklyn.roofer.nyc", "roofer.nyc"),
])
def test_registrable_domain(url: str, domain: str):
    assert ws.registrable_domain(url) == domain


# --------------------------------------------------------------------------- scoring / talking points


def test_marketing_score_components_and_cap():
    assert ws.marketing_score({}) == 0
    assert ws.marketing_score({"ad_pixels": ["Google Ads"], "tech": {"analytics": ["Google Analytics"]}}) == 3
    full = {
        "ad_pixels": ["Google Ads", "Meta Pixel"], "tech": {"analytics": ["GTM"]}, "call_tracking": ["CallRail"],
        "field_software": ["JobNimbus"], "chat": ["Podium"], "financing": {"offered": True},
        "review_widgets": ["NiceJob"], "social": {"facebook": "f", "instagram": "i", "youtube": "y"},
    }
    assert ws.marketing_score(full) == 10
    # an embedded video is not a social profile
    assert ws.marketing_score({"social": {"facebook": "f", "instagram": "i", "youtube_embed": "embedded video"}}) == 0


def test_talking_points_cover_each_signal():
    s = {
        "financing": {"offered": True, "providers": []},
        "ad_pixels": ["Meta Pixel"], "brands": ["GAF", "Owens Corning", "CertainTeed", "IKO", "TAMKO", "Malarkey"],
        "instant_quote": ["Roofr"], "careers": {"hiring_text": False, "ats": []},
        "schema_org": {"job_postings": 1, "founder": ["Luis Gomez", "Ana Gomez", "Third Person"]},
        "wayback": {"first_year": 2012}, "domain": {"registered": "2009-05-01"},
        "placeholder_site": True, "copyright_year": 2021,
    }
    assert ws.talking_points(s) == [
        "Advertises homeowner financing (provider not named on site).",
        "Runs paid-ads tracking (Meta Pixel) -- actively buying leads.",
        "Website features GAF, Owens Corning, CertainTeed, IKO, TAMKO.",
        "Uses an online instant-quote tool (Roofr).",
        "Website says they are hiring -- growth signal.",
        "Online since ~2009.",
        "Website names founder: Luis Gomez, Ana Gomez.",
        "Website is a placeholder/parked page -- little digital presence.",
        "Website looks stale (footer copyright 2021).",
    ]
    # copyright two years back is not yet "stale"; no financing at all gets the distributor pitch
    assert ws.talking_points({"copyright_year": 2024}) == [
        "No homeowner financing advertised on the website -- pitch distributor financing programmes."]


# --------------------------------------------------------------------------- enricher branches


def test_applies_only_with_a_known_website():
    e = WebSignalsEnricher(Settings())
    assert e.applies_to(ctx_for()) is True
    assert e.applies_to(ctx_for(website=None)) is False


async def test_no_website_is_skipped_without_network():
    http = FakeHttp({})
    r = await run(http, ctx_for(website=None))
    assert r.status == EnrichmentStatus.SKIPPED and r.data == {"reason": "no website known"}
    assert http.calls == []


async def test_robots_disallow_skips_homepage_but_still_reads_archives():
    routes = american_siding_routes()
    routes[f"{SITE}/robots.txt"] = resp(200, "User-agent: *\nDisallow: /\n")
    http = FakeHttp(routes)
    r = await run(http)
    assert SITE not in http.urls() and not any("googletagmanager" in u for u in http.urls())
    assert r.status == EnrichmentStatus.OK  # wayback + RDAP still identify the domain
    assert r.data["robots_disallowed"] is True and "http_status" not in r.data
    assert r.data["final_url"] == SITE and r.website == SITE
    assert "tech" not in r.data and "marketing_score" not in r.data and r.data["talking_points"] == []
    assert r.data["wayback"]["first_year"] == 2017 and r.data["domain"]["registered"] == "2016-11-16"


@pytest.mark.parametrize("status", [401, 403])
async def test_access_restricted_robots_txt_means_keep_out(status: int):
    routes = american_siding_routes()
    routes[f"{SITE}/robots.txt"] = resp(status, "Forbidden")
    http = FakeHttp(routes)
    r = await run(http)
    assert r.data["robots_disallowed"] is True and SITE not in http.urls()


async def test_robots_group_naming_leadmaker_is_honoured():
    routes = american_siding_routes()
    routes[f"{SITE}/robots.txt"] = resp(200, "User-agent: LeadMaker\nDisallow: /\n\nUser-agent: *\nAllow: /\n")
    http = FakeHttp(routes)
    r = await run(http)
    assert r.data["robots_disallowed"] is True
    assert SITE not in http.urls()


@pytest.mark.parametrize("robots", [
    resp(404, "<html>Not found</html>"),
    resp(200, "<!DOCTYPE html><html><body>Page not found</body></html>"),  # soft-404 HTML page
    HttpError("network error for robots", url="x"),
])
async def test_missing_or_broken_robots_txt_allows_the_homepage(robots: Route):
    routes = american_siding_routes()
    routes[f"{SITE}/robots.txt"] = robots
    http = FakeHttp(routes)
    r = await run(http)
    assert r.data["robots_disallowed"] is False and r.data["http_status"] == 200
    # with no parsed robots.txt there is no Sitemap: line, so the conventional paths are tried in order
    assert [u for u in http.urls() if "sitemap" in u] == [
        f"{SITE}/sitemap_index.xml", f"{SITE}/sitemap.xml", f"{SITE}/wp-sitemap.xml"]
    assert r.data["sitemap"] == STORED["web_signals"]["data"]["sitemap"]


async def test_homepage_network_failure_with_no_archive_or_registry_is_no_match():
    http = FakeHttp({
        "https://gone-roofing.com": HttpError("network error for https://gone-roofing.com: Could not resolve host"),
        CDX_URL: resp(200, "[]"),
        RDAP_COM + "gone-roofing.com": resp(404, '{"errorCode":404}'),
    })
    r = await run(http, ctx_for(website="https://gone-roofing.com"))
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data["http_status"] is None and "Could not resolve host" in r.data["fetch_error"]
    assert r.data["wayback"]["months_captured"] == 0
    assert r.data["domain"] == {"registered": None, "rdap_url": RDAP_COM + "gone-roofing.com"}
    assert r.data["talking_points"] == []
    assert r.source_urls[-1] == RDAP_COM + "gone-roofing.com"


async def test_homepage_error_status_is_recorded_without_parsing():
    routes = american_siding_routes()
    routes[SITE] = resp(503, "<html>Service Unavailable</html>")
    http = FakeHttp(routes)
    r = await run(http)
    assert r.data["http_status"] == 503 and "tech" not in r.data and "sitemap" not in r.data
    assert r.status == EnrichmentStatus.OK  # the domain itself is still known
    assert r.website == SITE


async def test_gtm_container_reveals_hidden_ad_tags_and_call_tracking():
    html = page("<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-AB12CD3');</script>")
    gtm = "https://www.googletagmanager.com/gtm.js?id=GTM-AB12CD3"
    http = FakeHttp({
        "https://acme.com": resp(200, html),
        gtm: resp(200, 'x="https://connect.facebook.net/en_US/fbevents.js";y="//cdn.callrail.com/swap.js"'),
    })
    r = await run(http, ctx_for(website="acme.com"))  # scheme-less website gets https://
    assert r.data["website"] == "https://acme.com"
    assert r.data["gtm"] == {"id": "GTM-AB12CD3", "ad_tags": ["Meta Pixel", "CallRail"]}
    assert r.data["ad_pixels"] == ["Meta Pixel"] and r.data["advertises"] is True
    assert r.data["call_tracking"] == ["CallRail"]
    assert gtm in r.source_urls
    assert r.data["tech"]["analytics"] == ["Google Tag Manager"]
    assert r.data["marketing_score"] == 4  # ad pixel (2) + tag manager analytics (1) + call tracking (1)


@pytest.mark.parametrize("gtm_route", [resp(404, "Not found"), HttpError("HTTP 500", status=500)])
async def test_unavailable_gtm_container_is_ignored(gtm_route: Route):
    html = page("<script>'GTM-AB12CD3'</script>")
    gtm = "https://www.googletagmanager.com/gtm.js?id=GTM-AB12CD3"
    http = FakeHttp({"https://acme.com": resp(200, html), gtm: gtm_route})
    r = await run(http, ctx_for(website="https://acme.com"))
    assert "gtm" not in r.data and r.data["ad_pixels"] == [] and r.data["advertises"] is False
    assert gtm not in r.source_urls


async def test_gtm_scan_can_be_switched_off():
    http = FakeHttp({"https://acme.com": resp(200, page("<script>'GTM-AB12CD3'</script>"))})
    await run(http, ctx_for(website="https://acme.com"), scan_gtm=False, scan_sitemap=False)
    assert not any("googletagmanager" in u for u in http.urls())
    assert not any("sitemap" in u for u in http.urls())


async def test_linked_financing_page_names_the_lender():
    html = page('<a href="/financing/">Financing</a>')
    http = FakeHttp({
        "https://acme.com": resp(200, html),
        "https://acme.com/financing/": resp(200, "<p>Apply with Hearth: https://app.gethearth.com/partners/acme</p>"),
    })
    r = await run(http, ctx_for(website="https://acme.com"))
    assert r.data["financing"] == {"offered": True, "providers": ["Hearth"], "page": "https://acme.com/financing/"}
    assert "https://acme.com/financing/" in r.source_urls
    assert r.data["talking_points"][0] == "Offers homeowner financing via Hearth."


async def test_financing_page_not_fetched_when_robots_disallows_it_or_home_names_lender():
    html = page('<a href="/financing/">Financing</a>')
    http = FakeHttp({
        "https://acme.com/robots.txt": resp(200, "User-agent: *\nDisallow: /financing/\n"),
        "https://acme.com": resp(200, html),
    })
    r = await run(http, ctx_for(website="https://acme.com"))
    assert "https://acme.com/financing/" not in http.urls()
    assert r.data["financing"] == {"offered": True, "providers": [], "page": "https://acme.com/financing/"}

    http2 = FakeHttp({"https://acme.com": resp(200, page('<a href="/financing/">GreenSky financing</a>'))})
    r2 = await run(http2, ctx_for(website="https://acme.com"))
    assert "https://acme.com/financing/" not in http2.urls()
    assert r2.data["financing"]["providers"] == ["GreenSky"]


async def test_failed_financing_page_keeps_offered_flag():
    html = page('<a href="/financing/">Financing</a>')
    http = FakeHttp({"https://acme.com": resp(200, html),
                     "https://acme.com/financing/": HttpError("HTTP 500", status=500)})
    r = await run(http, ctx_for(website="https://acme.com"))
    assert r.data["financing"]["offered"] is True and r.data["financing"]["providers"] == []
    assert "https://acme.com/financing/" not in r.source_urls


async def test_sitemap_prefers_robots_listed_sitemaps_and_tries_at_most_three():
    robots = "User-agent: *\nAllow: /\nSitemap: https://acme.com/a.xml\nSitemap: https://acme.com/b.xml\n"
    http = FakeHttp({
        "https://acme.com/robots.txt": resp(200, robots),
        "https://acme.com": resp(200, page("")),
        "https://acme.com/a.xml": HttpError("network error"),
        "https://acme.com/b.xml": resp(200, "<html>not a sitemap</html>"),
        "https://acme.com/sitemap.xml": resp(200, "<urlset><url><loc>https://acme.com/</loc></url></urlset>"),
    })
    r = await run(http, ctx_for(website="https://acme.com"))
    assert [u for u in http.urls() if u.endswith(".xml")] == [
        "https://acme.com/a.xml", "https://acme.com/b.xml", "https://acme.com/sitemap_index.xml"]
    assert r.data["sitemap"] == {}


async def test_sitemap_fallback_path_is_used_without_robots():
    xml = "<urlset><url><loc>https://acme.com/</loc><lastmod>2026-09-16</lastmod></url></urlset>"
    http = FakeHttp({"https://acme.com": resp(200, page("")), "https://acme.com/sitemap.xml": resp(200, xml)})
    r = await run(http, ctx_for(website="https://acme.com"))
    assert r.data["sitemap"] == {"entries": 1, "lastmod_max": "2026-09-16", "url": "https://acme.com/sitemap.xml"}


@pytest.mark.parametrize("cdx,expected", [
    (HttpError("HTTP 429 for https://web.archive.org/cdx/search/cdx", status=429),
     {"error": "HTTP 429 for https://web.archive.org/cdx/search/cdx"}),
    (resp(200, ""), {"first_capture": None, "last_capture": None, "months_captured": 0, "first_year": None}),
    (resp(200, "<html>Wayback Machine is down</html>"), None),
])
async def test_wayback_failures_are_recorded_not_raised(cdx: Route, expected: dict[str, Any] | None):
    routes = american_siding_routes()
    routes[CDX_URL] = cdx
    r = await run(FakeHttp(routes))
    assert r.status == EnrichmentStatus.OK
    if expected is None:
        assert set(r.data["wayback"]) == {"error"}
    else:
        assert r.data["wayback"] == expected
    # registry year still drives "online since"
    assert "Online since ~2016." in r.data["talking_points"]


async def test_rdap_uses_registry_for_com_and_rdap_org_for_other_tlds():
    http = FakeHttp({
        "https://www.brooklynroofer.nyc": resp(200, page("")),
        "https://rdap.org/domain/brooklynroofer.nyc": resp(200, json.dumps({
            "events": [{"eventAction": "registration", "eventDate": "2019-03-02T00:00:00Z"}]})),
    })
    r = await run(http, ctx_for(website="https://www.brooklynroofer.nyc"))
    assert r.data["domain"] == {"registered": "2019-03-02", "expires": None, "registrar": None,
                                "rdap_url": "https://rdap.org/domain/brooklynroofer.nyc"}
    assert http.call(CDX_URL)["params"]["url"] == "brooklynroofer.nyc"


async def test_rdap_bad_payload_is_an_error_entry():
    routes = american_siding_routes()
    routes[RDAP_COM + "americansidingconstruction.com"] = resp(200, "<html>rate limited</html>")
    r = await run(FakeHttp(routes))
    assert r.data["domain"]["rdap_url"] == RDAP_COM + "americansidingconstruction.com"
    assert "error" in r.data["domain"] and "registered" not in r.data["domain"]
    assert r.source_urls[-1] == RDAP_COM + "americansidingconstruction.com"


async def test_confidence_follows_website_discovery_prior_else_default():
    routes = american_siding_routes()
    r = await run(FakeHttp(routes), ctx_for(discovery_conf=0.65))
    assert r.confidence == 0.65
    # website known only from the contractor row (no verified discovery): default 0.8
    r2 = await run(FakeHttp(american_siding_routes()), ctx_for(discovery_conf=None))
    assert r2.status == EnrichmentStatus.OK and r2.confidence == 0.8


async def test_placeholder_homepage_is_flagged():
    http = FakeHttp({"https://acme.com": resp(200, "<html><body><h1>Coming soon</h1></body></html>")})
    r = await run(http, ctx_for(website="https://acme.com"))
    assert r.data["placeholder_site"] is True
    assert "Website is a placeholder/parked page -- little digital presence." in r.data["talking_points"]
    # a short but real homepage (~470 visible characters, above the 300 threshold) is not a placeholder
    small = page("")
    assert 300 < ws.visible_text_len(small) < 600
    r2 = await run(FakeHttp({"https://acme.com": resp(200, small)}), ctx_for(website="https://acme.com"))
    assert r2.data["placeholder_site"] is False
    assert not any("placeholder" in tp for tp in r2.data["talking_points"])


async def test_unreachable_homepage_with_registry_record_is_still_ok():
    # the site is down and the Wayback Machine has nothing, but RDAP shows the domain is registered
    http = FakeHttp({
        "https://acme.com": HttpError("network error for https://acme.com: Connection timed out"),
        CDX_URL: resp(200, "[]"),
        RDAP_COM + "acme.com": resp(200, json.dumps({
            "events": [{"eventAction": "registration", "eventDate": "2011-04-09T00:00:00Z"}]})),
    })
    r = await run(http, ctx_for(website="https://acme.com"))
    assert r.status == EnrichmentStatus.OK
    assert r.data["http_status"] is None and r.data["domain"]["registered"] == "2011-04-09"
    assert r.website == "https://acme.com" and r.data["talking_points"] == []


async def test_soft_404_html_robots_txt_is_not_parsed_as_rules():
    # an HTML error page served at /robots.txt whose text happens to contain rule-like lines
    soft404 = ("<!DOCTYPE html><html><body><h1>Page not found</h1><pre>\n"
               "User-agent: *\nDisallow: /\n</pre></body></html>")
    routes = american_siding_routes()
    routes[f"{SITE}/robots.txt"] = resp(200, soft404)
    http = FakeHttp(routes)
    r = await run(http)
    assert r.data["robots_disallowed"] is False and SITE in http.urls()
    assert r.data["http_status"] == 200 and "tech" in r.data
