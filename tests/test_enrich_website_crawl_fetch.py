"""Offline tests for website_crawl's fetch / crawl loop (WebsiteCrawlEnricher.enrich).

The network is faked at the HttpClient boundary. The replay test serves the real homepage of
americansidingconstruction.com (tests/fixtures/website_crawl_american_siding_home.html, GAF lead
1109046) and checks the crawl picks the same pages the 2026-10-18 live run stored in
data/leadmaker.db (copied into tests/fixtures/web_signals_americansiding_stored.json).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from leadmaker.config import Settings
from leadmaker.enrich import website_crawl as wc
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.website_crawl import WebsiteCrawlEnricher
from leadmaker.http import HttpError, Response
from leadmaker.models import EnrichmentResult, EnrichmentStatus

FIX = Path(__file__).parent / "fixtures"
HOME_HTML = (FIX / "website_crawl_american_siding_home.html").read_text(errors="ignore")
STORED = json.loads((FIX / "web_signals_americansiding_stored.json").read_text())
AS = "https://americansidingconstruction.com"
HTML = {"Content-Type": "text/html; charset=UTF-8"}


def resp(status: int = 200, text: str = "", url: str = "", headers: dict[str, str] | None = None) -> Response:
    return Response(url=url, status=status, text=text, headers=HTML if headers is None else headers)


class FakeHttp:
    """Serves canned responses by exact URL (unknown URLs: 404) and records every request.

    Mimics HttpClient: statuses in allow_statuses are returned, any other non-2xx raises HttpError.
    """

    def __init__(self, routes: dict[str, Response | Exception]):
        self.routes = routes
        self.calls: list[dict[str, Any]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    def urls(self) -> list[str]:
        return [c["url"] for c in self.calls]

    def robots_fetches(self) -> list[str]:
        return [u for u in self.urls() if u.endswith("/robots.txt")]

    def pages(self) -> list[str]:
        return [u for u in self.urls() if not u.endswith("/robots.txt")]

    async def get(self, url: str, **kw: Any) -> Response:
        self.calls.append({"url": url, **kw})
        out = self.routes.get(url, resp(404, "<html><body>Not found</body></html>"))
        if isinstance(out, Exception):
            raise out
        if not out.url:
            out = Response(url=url, status=out.status, text=out.text, headers=out.headers)
        if not out.ok and out.status not in kw.get("allow_statuses", ()):
            raise HttpError(f"HTTP {out.status} for {url}", status=out.status, url=url)
        return out


def ctx_for(website: str | None, discovery_conf: float | None = 0.8, **over: Any) -> LeadContext:
    row = {"gaf_id": "T1", "name": "Acme Roofing", "legal_name": None, "dba": None,
           "phone": "(201) 555-0142", "city": "Hoboken", "state": "NJ", "website": None}
    row.update(over)
    prior: dict[str, EnrichmentResult] = {}
    if website and discovery_conf is not None:
        prior["website_discovery"] = EnrichmentResult(
            source="website_discovery", status=EnrichmentStatus.OK, confidence=discovery_conf, website=website)
    elif website:
        row["website"] = website
    return LeadContext(contractor=row, prior=prior)


async def crawl(http: FakeHttp, ctx: LeadContext) -> EnrichmentResult:
    return await WebsiteCrawlEnricher(Settings()).enrich(ctx, http)  # type: ignore[arg-type]


def html_page(body: str, title: str = "Acme Roofing") -> str:
    return f"<html><head><title>{title}</title></head><body><main>{body}</main></body></html>"


HOME = html_page("""
<nav><a href="/about-us/">About Us</a><a href="/services/">Services</a><a href="/contact/">Contact</a></nav>
<h1>Acme Roofing</h1><p>Roof replacement and roof repair in Hoboken since 1998. Call (201) 555-0142.</p>
""")


def acme_routes(**extra: Response | Exception) -> dict[str, Response | Exception]:
    routes: dict[str, Response | Exception] = {
        "https://acme.com/robots.txt": resp(200, "User-agent: *\nDisallow: /wp-admin/\n", headers={}),
        "https://acme.com/": resp(200, HOME),
        "https://acme.com/about-us/": resp(200, html_page("<p>Founded by John Smith in 1998.</p>")),
        "https://acme.com/services/": resp(200, html_page("<p>Slate roofing, gutters and siding.</p>")),
        "https://acme.com/contact/": resp(200, html_page('<p>Email <a href="mailto:john@acme.com">us</a></p>')),
    }
    routes.update(extra)
    return routes


# --------------------------------------------------------------------------- replay on real data


def american_siding_routes() -> dict[str, Response | Exception]:
    return {
        f"{AS}/robots.txt": resp(200, (FIX / "web_signals_robots_wordpress.txt").read_text(), headers={}),
        f"{AS}/": resp(200, HOME_HTML),
        f"{AS}/contact/": resp(200, html_page("<h1>Contact American Siding</h1><p>53 Euclid Ave, Newark NJ</p>")),
        f"{AS}/service-areas/": resp(200, html_page("<h2>Service Areas</h2><p>Serving Essex, Union and Bergen.</p>")),
        f"{AS}/roofing/": resp(200, html_page("<h1>Roofing</h1><p>Roof replacement and roof repair.</p>")),
    }


async def test_crawl_replays_live_page_selection_for_american_siding():
    stored = STORED["website_crawl"]
    http = FakeHttp(american_siding_routes())
    ctx = ctx_for(STORED["website_discovery"]["website"], STORED["website_discovery"]["confidence"],
                  **{k: v for k, v in STORED["contractor"].items() if k != "website"})
    r = await crawl(http, ctx)
    assert r.status == EnrichmentStatus.OK
    assert r.source_urls == stored["source_urls"]
    assert r.website == stored["website"] == f"{AS}/"
    assert r.confidence == stored["confidence"]
    for key in ("emails", "phones", "pages_fetched", "robots_blocked", "final_url", "identity"):
        assert r.data[key] == stored["data"][key], key
    assert http.robots_fetches() == [f"{AS}/robots.txt"]  # cached for the whole crawl


async def test_request_budget_retries_and_timeouts():
    http = FakeHttp(american_siding_routes())
    await crawl(http, ctx_for(AS))
    robots, home, *subpages = http.calls
    assert robots["retries"] == 0 and robots["timeout"] == 10.0
    assert set(robots["allow_statuses"]) == set(range(300, 600))  # robots.txt never raises on status
    assert home["url"] == f"{AS}/" and home["retries"] == 2 and home["timeout"] == wc.FETCH_TIMEOUT_S
    assert subpages and all(c["retries"] == 0 for c in subpages)
    assert all(set(c["allow_statuses"]) == {401, 403, 404, 410} for c in [home, *subpages])
    assert len(subpages) <= wc.MAX_EXTRA_PAGES


async def test_cloudflare_email_protection_link_does_not_use_page_budget():
    # The real homepage links its obfuscated address as "Email our team" -> /cdn-cgi/l/email-protection#...
    http = FakeHttp(american_siding_routes())
    await crawl(http, ctx_for(AS))
    assert not any("/cdn-cgi/" in u for u in http.urls())


def test_service_area_links_are_categorised_as_areas():
    # category only: either proposed fix (heavier area keywords, or longest keyword wins ties) must pass
    assert wc.score_link(f"{AS}/service-areas/", "Explore our service areas")[0] == "areas"
    assert wc.score_link("https://acme.com/service-area/", "Where we work")[0] == "areas"
    assert wc.score_link("https://acme.com/services/", "Our services")[0] == "services"  # unchanged


# --------------------------------------------------------------------------- happy path


async def test_crawl_follows_selected_links_and_attaches_contacts():
    http = FakeHttp(acme_routes())
    r = await crawl(http, ctx_for("acme.com"))  # bare domain is normalised to https://acme.com/
    assert r.status == EnrichmentStatus.OK
    assert http.pages() == ["https://acme.com/", "https://acme.com/about-us/", "https://acme.com/services/",
                            "https://acme.com/contact/"]
    assert r.data["pages_fetched"] == 4 and r.data["robots_blocked"] == 0
    assert r.data["final_url"] == "https://acme.com/" and r.website == "https://acme.com/"
    assert r.data["founded_year"] == 1998 and {"slate_roofing", "gutters", "siding"} <= set(r.data["services"])
    assert r.data["identity"] == {"phone_match": True, "name_match": True}
    assert r.confidence == 0.9  # phone match lifts the 0.8 discovery prior
    assert [(c.name, c.title, c.email, c.source, c.source_url) for c in r.contacts] == [
        ("John Smith", "Founder", "john@acme.com", "website", "https://acme.com/about-us/")]
    assert [p["url"] for p in r.data["pages"]] == r.source_urls


async def test_no_website_is_skipped_without_network():
    http = FakeHttp({})
    r = await crawl(http, ctx_for(None))
    assert r.status == EnrichmentStatus.SKIPPED and r.data == {"reason": "no website"}
    assert http.calls == []
    assert WebsiteCrawlEnricher(Settings()).applies_to(ctx_for(None)) is True


# --------------------------------------------------------------------------- robots.txt


async def test_robots_disallow_all_skips_without_fetching_homepage():
    http = FakeHttp(acme_routes(**{"https://acme.com/robots.txt": resp(200, "User-agent: *\nDisallow: /\n")}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.SKIPPED and r.data["reason"] == "robots.txt disallows crawling"
    assert http.urls() == ["https://acme.com/robots.txt"]


@pytest.mark.parametrize("status", [401, 403])
async def test_access_restricted_robots_txt_is_treated_as_disallow_all(status: int):
    http = FakeHttp(acme_routes(**{"https://acme.com/robots.txt": resp(status, "denied")}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.SKIPPED and http.pages() == []


@pytest.mark.parametrize("robots", [
    resp(404, "<html>nope</html>"),
    resp(200, "<!doctype html><html><body>Welcome!</body></html>"),  # SPA serving index.html for every path
    resp(500, "oops"),
    HttpError("network error for https://acme.com/robots.txt: timeout"),
])
async def test_missing_or_broken_robots_txt_allows_crawling(robots: Response | Exception):
    http = FakeHttp(acme_routes(**{"https://acme.com/robots.txt": robots}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.OK and r.data["pages_fetched"] == 4
    assert http.robots_fetches() == ["https://acme.com/robots.txt"]  # failure cached, not re-fetched
    assert http.intervals == {}


async def test_soft_404_html_robots_txt_is_not_parsed_as_rules():
    # an HTML error page at /robots.txt whose text happens to contain rule-like lines must not block the crawl
    soft404 = "<!DOCTYPE html><html><body><h1>Not found</h1><pre>\nUser-agent: *\nDisallow: /\n</pre></body></html>"
    http = FakeHttp(acme_routes(**{"https://acme.com/robots.txt": resp(200, soft404)}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.OK and r.data["pages_fetched"] == 4 and r.data["robots_blocked"] == 0


@pytest.mark.parametrize("delay,expected", [("4", 4.0), ("60", 10.0)])
async def test_crawl_delay_sets_host_interval_capped_at_10s(delay: str, expected: float):
    robots = f"User-agent: *\nCrawl-delay: {delay}\nDisallow: /private/\n"
    http = FakeHttp(acme_routes(**{"https://acme.com/robots.txt": resp(200, robots)}))
    await crawl(http, ctx_for("https://acme.com"))
    assert http.intervals == {"acme.com": expected}


async def test_disallowed_subpages_are_counted_not_fetched():
    robots = "User-agent: *\nDisallow: /about-us/\nDisallow: /contact/\n"
    http = FakeHttp(acme_routes(**{"https://acme.com/robots.txt": resp(200, robots)}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.data["robots_blocked"] == 2 and r.data["pages_fetched"] == 2
    assert http.pages() == ["https://acme.com/", "https://acme.com/services/"]


async def test_redirect_to_other_host_rechecks_robots_there():
    routes = acme_routes(**{
        "https://acme.com/": resp(200, HOME, url="https://acmeroofingnj.com/"),
        "https://acmeroofingnj.com/robots.txt": resp(200, "User-agent: *\nDisallow: /\n"),
    })
    http = FakeHttp(routes)
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.SKIPPED
    assert r.data["reason"] == "robots.txt disallows crawling (after redirect)"
    assert http.robots_fetches() == ["https://acme.com/robots.txt", "https://acmeroofingnj.com/robots.txt"]


async def test_redirect_to_other_host_crawls_that_host():
    new_home = html_page('<a href="/about/">About</a><a href="https://acme.com/services/">Old services</a>'
                         "<p>Acme Roofing, call (201) 555-0142</p>")
    routes = {
        "https://acme.com/": resp(200, new_home, url="https://acmeroofingnj.com/"),
        "https://acmeroofingnj.com/about/": resp(200, html_page("<p>About us</p>")),
        "https://acmeroofingnj.com/contact": resp(200, html_page("<p>Contact</p>")),
    }
    http = FakeHttp(routes)
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.OK and r.data["final_url"] == "https://acmeroofingnj.com/"
    # links back to the old host are off-site now; one same-site link -> conventional paths fill in
    assert "https://acme.com/services/" not in http.urls()
    assert r.source_urls == ["https://acmeroofingnj.com/", "https://acmeroofingnj.com/about/",
                             "https://acmeroofingnj.com/contact"]


async def test_www_redirect_is_same_site_and_subpages_follow_the_www_robots_txt():
    routes = acme_routes(**{"https://acme.com/": resp(200, HOME, url="https://www.acme.com/")})
    routes.update({u.replace("https://acme.com", "https://www.acme.com"): v for u, v in acme_routes().items()
                   if u.endswith("/") and u != "https://acme.com/"})
    routes["https://www.acme.com/robots.txt"] = resp(200, "User-agent: *\nDisallow: /services/\n")
    http = FakeHttp(routes)
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.OK and r.data["final_url"] == "https://www.acme.com/"
    # no "(after redirect)" gate for www <-> bare, but robots.txt is per origin: the www subpages use www's
    assert http.robots_fetches() == ["https://acme.com/robots.txt", "https://www.acme.com/robots.txt"]
    assert http.robots_fetches() == [u for u in http.urls() if u.endswith("robots.txt")]  # each once
    assert r.data["robots_blocked"] == 1 and r.data["pages_fetched"] == 3
    assert "https://www.acme.com/services/" not in http.urls()
    # john@acme.com counts as same-domain for the www host, so it attaches to the founder
    assert [(c.name, c.email) for c in r.contacts] == [("John Smith", "john@acme.com")]


# --------------------------------------------------------------------------- homepage failures


@pytest.mark.parametrize("err", [
    HttpError("HTTP 410 for https://acme.com/", status=410),
    HttpError("network error for https://acme.com/: Could not resolve host: acme.com"),
    HttpError("network error for https://acme.com/: SSL certificate problem: certificate has expired"),
])
async def test_unreachable_homepage_is_no_match(err: HttpError):
    http = FakeHttp(acme_routes(**{"https://acme.com/": err}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data["reason"].startswith("website unreachable: ") and r.data["url"] == "https://acme.com/"
    assert r.source_urls == ["https://acme.com/"]


async def test_transient_homepage_failure_is_an_error_for_retry_next_run():
    http = FakeHttp(acme_routes(**{"https://acme.com/": HttpError("HTTP 503 for https://acme.com/", status=503)}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.ERROR and r.error == "homepage fetch failed: HTTP 503 for https://acme.com/"


@pytest.mark.parametrize("home", [
    resp(404, "<html>Not Found</html>"),
    resp(200, "%PDF-1.7 ...", headers={"Content-Type": "application/pdf"}),
])
async def test_homepage_not_found_or_not_html_is_no_match(home: Response):
    http = FakeHttp(acme_routes(**{"https://acme.com/": home}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data == {"reason": "homepage not HTML or not found", "url": "https://acme.com/"}


async def test_missing_content_type_is_treated_as_html():
    http = FakeHttp(acme_routes(**{"https://acme.com/": resp(200, HOME, headers={})}))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert r.status == EnrichmentStatus.OK


# --------------------------------------------------------------------------- page budget / link selection


async def test_page_budget_and_category_quotas():
    links = "".join(f'<a href="/{p}">{t}</a>' for p, t in [
        ("our-team/", "Our Team"), ("leadership/", "Leadership"), ("meet-the-owner/", "Meet the owner"),
        ("about-us/", "About Us"), ("our-story/", "Our Story"), ("history/", "History"),
        ("services/", "Services"), ("what-we-do/", "What we do"), ("residential/", "Residential"),
        ("contact/", "Contact"), ("contact-us/", "Contact us"), ("careers/", "Careers"),
        ("brochure.pdf", "About us PDF"), ("wp-login/", "Team login"), ("about-us/?ref=nav", "About"),
    ]) + '<a href="https://other.com/about">About other</a>'
    routes: dict[str, Response | Exception] = {"https://acme.com/": resp(200, html_page(links))}
    http = FakeHttp(routes)
    for p in ("our-team/", "leadership/", "meet-the-owner/", "about-us/", "our-story/", "history/",
              "services/", "what-we-do/", "residential/", "contact/", "contact-us/", "careers/"):
        routes[f"https://acme.com/{p}"] = resp(200, html_page(f"<p>{p}</p>"))
    r = await crawl(http, ctx_for("https://acme.com"))
    assert http.pages() == [
        "https://acme.com/",
        "https://acme.com/our-team/", "https://acme.com/leadership/",  # team quota 2
        "https://acme.com/about-us/", "https://acme.com/our-story/",  # about quota 2
        "https://acme.com/services/",
        "https://acme.com/contact/",
    ]
    assert r.data["pages_fetched"] == 1 + wc.MAX_EXTRA_PAGES


async def test_excluded_links_are_never_fetched_even_when_they_score_highest():
    # each of these would otherwise be the top-scoring team/about link; only two real links remain
    links = "".join(f'<a href="{h}">{t}</a>' for h, t in [
        ("/our-team/brochure.pdf", "Our Team"),          # file download
        ("/wp-login/our-team/", "Our Team"),             # admin / login area
        ("/cart/leadership/", "Leadership"),             # shop checkout path
        ("/our-team/?ref=nav", "Our Team"),              # tracking query string
        ("https://other.com/our-team/", "Our Team"),     # another site
        ("/about-us/", "About Us"), ("/contact/", "Contact"),
    ])
    routes: dict[str, Response | Exception] = {
        "https://acme.com/": resp(200, html_page(links)),
        "https://acme.com/about-us/": resp(200, html_page("<p>About</p>")),
        "https://acme.com/contact/": resp(200, html_page("<p>Contact</p>")),
    }
    http = FakeHttp(routes)
    r = await crawl(http, ctx_for("https://acme.com"))
    assert http.pages() == ["https://acme.com/", "https://acme.com/about-us/", "https://acme.com/contact/"]
    assert r.data["pages_fetched"] == 3


async def test_js_heavy_homepage_falls_back_to_conventional_paths():
    routes: dict[str, Response | Exception] = {
        "https://acme.com/": resp(200, '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'),
        "https://acme.com/about": resp(200, html_page("<p>About Acme</p>")),
        "https://acme.com/contact-us": resp(200, html_page("<p>Contact Acme</p>")),
    }
    http = FakeHttp(routes)
    r = await crawl(http, ctx_for("https://acme.com"))
    assert http.pages() == ["https://acme.com/"] + [f"https://acme.com{p}" for p in wc.FALLBACK_PATHS]
    assert r.source_urls == ["https://acme.com/", "https://acme.com/about", "https://acme.com/contact-us"]
    assert r.data["pages_fetched"] == 3


async def test_one_real_link_is_kept_ahead_of_fallbacks_without_duplicates():
    routes: dict[str, Response | Exception] = {
        "https://acme.com/": resp(200, html_page('<a href="/contact">Contact</a>')),
        "https://acme.com/contact": resp(200, html_page("<p>Contact</p>")),
    }
    http = FakeHttp(routes)
    await crawl(http, ctx_for("https://acme.com"))
    assert http.pages() == ["https://acme.com/", "https://acme.com/contact", "https://acme.com/about",
                            "https://acme.com/about-us", "https://acme.com/contact-us", "https://acme.com/services"]


async def test_subpage_failures_and_redirects_are_dropped():
    home = html_page('<a href="/about-us/">About us</a><a href="/our-team/">Our team</a><a href="/services/">Services</a>'
                     '<a href="/contact/">Contact</a><a href="/meet-the-owner/">Meet the owner</a>')
    routes: dict[str, Response | Exception] = {
        "https://acme.com/": resp(200, home),
        "https://acme.com/our-team/": HttpError("network error for https://acme.com/our-team/: timeout"),
        "https://acme.com/meet-the-owner/": resp(200, "x", url="https://acme.com/"),  # redirect to home: dedupe
        "https://acme.com/about-us/": resp(200, html_page("<p>About</p>"), url="https://facebook.com/acme"),  # off-site
        "https://acme.com/services/": resp(200, "{}", headers={"Content-Type": "application/json"}),  # not HTML
        "https://acme.com/contact/": resp(200, html_page("<p>Contact</p>")),
    }
    http = FakeHttp(routes)
    r = await crawl(http, ctx_for("https://acme.com"))
    assert len(http.pages()) == 6  # every target was tried exactly once
    assert r.source_urls == ["https://acme.com/", "https://acme.com/contact/"]
    assert r.data["pages_fetched"] == 2 and r.status == EnrichmentStatus.OK


async def test_two_links_redirecting_to_one_page_are_kept_once():
    home = html_page('<a href="/about-us/">About us</a><a href="/our-story/">Our story</a>')
    routes: dict[str, Response | Exception] = {
        "https://acme.com/": resp(200, home),
        "https://acme.com/about-us/": resp(200, html_page("<p>About</p>"), url="https://acme.com/about/"),
        "https://acme.com/our-story/": resp(200, html_page("<p>About</p>"), url="https://acme.com/about"),
    }
    r = await crawl(FakeHttp(routes), ctx_for("https://acme.com"))
    assert r.source_urls == ["https://acme.com/", "https://acme.com/about/"]


# --------------------------------------------------------------------------- confidence


@pytest.mark.parametrize("prior_conf,phone,expected", [
    (0.8, "(201) 555-0142", 0.9),   # phone on the site matches the GAF listing
    (0.5, "(973) 000-1111", 0.75),  # no phone match, but the business name is on the site
    (0.95, "(973) 000-1111", 0.95),  # a strong discovery prior is kept
    (0.95, "(201) 555-0142", 0.95),  # ... and is not lowered to 0.9 by a phone match
    (None, "(973) 000-1111", 0.75),  # website from the contractor row only (default 0.6, lifted by name)
])
async def test_confidence_blends_discovery_prior_with_identity(prior_conf, phone, expected):
    r = await crawl(FakeHttp(acme_routes()), ctx_for("https://acme.com", prior_conf, phone=phone))
    assert r.confidence == expected


async def test_unverified_site_without_identity_keeps_default_confidence():
    r = await crawl(FakeHttp(acme_routes()), ctx_for("https://acme.com", None, name="Zeta Builders", phone=None))
    assert r.data["identity"] == {"phone_match": False, "name_match": False}
    assert r.confidence == 0.6


# --------------------------------------------------------------------------- link scoring / JSON-LD through the crawl


def test_deep_links_score_lower_than_section_pages():
    assert wc.score_link("https://acme.com/our-team/", "x") == ("team", 12)
    assert wc.score_link("https://acme.com/blog/2024/05/our-team/", "x") == ("team", 9)
    # the boundary: three path slashes is still a section page, four is deep
    assert wc.score_link("https://acme.com/company/our-team/", "x") == ("team", 12)
    assert wc.score_link("https://acme.com/company/about/our-team/", "x") == ("team", 9)
    assert wc.score_link("https://acme.com/gallery/", "Photos") is None


async def test_org_json_ld_facts_flow_into_the_crawl_result():
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebSite", "name": "Acme", "foundingDate": "1900"},  # not the business: ignored
        {"@type": "Person", "name": "Pat Doe", "email": "pat@person.com"},  # people are not org facts
        {"@type": "RoofingContractor", "name": "Acme Roofing", "foundingDate": "2006-03-01",
         "numberOfEmployees": {"@type": "QuantitativeValue", "minValue": 10, "maxValue": 20},
         "sameAs": ["https://www.facebook.com/AcmeRoofingNJ", "https://www.instagram.com/acme.roofing/"],
         "areaServed": [{"@type": "City", "name": "Hoboken"}, "Jersey City"],
         "email": "Info@Acme.com", "telephone": "+1-201-555-0142"}]}
    home = (f'<html><head><title>Acme Roofing</title><script type="application/ld+json">{json.dumps(ld)}</script>'
            '</head><body><main><p>Quality roofing for New Jersey homes.</p>'
            '<a href="https://www.facebook.com/">Facebook</a>'  # theme placeholder: bare platform homepage
            '<a href="https://www.facebook.com/sharer/sharer.php?u=acme">Share</a>'
            '<a href="https://www.google.com/maps/place/Acme+Roofing/@40.7,-74.0">Map</a>'
            '<a href="https://www.google.com/search?q=acme">Search</a>'
            '<a href="https://www.yelp.com/biz/acme-roofing-hoboken">Yelp</a></main></body></html>')
    r = await crawl(FakeHttp({"https://acme.com/": resp(200, home)}), ctx_for("https://acme.com", phone="(201) 555-0142"))
    d = r.data
    assert (d["founded_year"], d["founded_year_evidence"]) == (2006, "JSON-LD foundingDate")
    assert d["team_size_hint"] == "10-20 employees (JSON-LD)"
    assert d["social"] == {
        "google": "https://www.google.com/maps/place/Acme+Roofing/@40.7,-74.0",
        "yelp": "https://www.yelp.com/biz/acme-roofing-hoboken",
        "facebook": "https://www.facebook.com/AcmeRoofingNJ",
        "instagram": "https://www.instagram.com/acme.roofing/",
    }
    assert d["service_areas"] == ["Hoboken", "Jersey City"]
    assert d["emails"] == ["info@acme.com"] and d["phones"] == ["(201) 555-0142"]
    assert d["identity"]["phone_match"] is True and r.confidence == 0.9
