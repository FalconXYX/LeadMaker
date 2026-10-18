"""Website discovery: find (and verify) a contractor's own website.

GAF profiles don't list websites and scripted search-engine scraping returns junk
or bot challenges, so candidates come from:

  1. websites already known to earlier enrichers (google_places, osm),
  2. the domain of a known business e-mail address (non-free-mail),
  3. an official search API, only if BRAVE_SEARCH_API_KEY or SERPAPI_KEY is set,
  4. domain guessing from the business names ("ADH Group" -> adhgroup.com,
     adhroofing.com, adhgroupny.com, ...), filtered by a cheap DNS lookup.

Every candidate's homepage is fetched (robots.txt permitting) and scored for
evidence that it really is *this* contractor: the contractor's phone number on
the page is the strongest signal; business-name similarity with the title /
og:site_name / h1 / JSON-LD name is medium; city/ZIP/state and roofing
vocabulary are weak boosts. Parked / for-sale / placeholder pages and
directories or marketplaces (Yelp, Angi, Houzz, Facebook, ...) are rejected.
Only a candidate scoring >= ACCEPT_SCORE is returned as the website.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import socket
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib import robotparser
from urllib.parse import quote_plus, urljoin, urlsplit

from selectolax.lexbor import LexborHTMLParser

from ..config import Settings
from ..http import HttpClient, HttpError
from ..models import EnrichmentResult
from .base import Enricher, LeadContext
from .matching import name_similarity, normalize_name, phone_digits, tokens, zip5

log = logging.getLogger(__name__)

ACCEPT_SCORE = 0.6  # minimum confidence to report a website
STRONG_SCORE = 0.85  # stop probing further candidates once one scores this high
MAX_GUESSES = 16  # domain guesses per contractor (DNS-checked before any HTTP)
MAX_PROBES = 7  # homepages fetched per contractor (excluding prior/known candidates)
PROBE_BATCH = 3  # homepages fetched concurrently per contractor
MAX_SUBPAGES = 2  # contact/about pages checked when a name-matching homepage lacks the phone
DNS_TIMEOUT_S = 2.5
FETCH_TIMEOUT_S = 10.0
ROBOTS_TIMEOUT_S = 6.0
PROBE_TIMEOUT_S = 35.0  # hard cap per candidate (robots + homepage + subpages, both schemes)
CONTRACTOR_BUDGET_S = 90.0  # stop starting new probe batches for a contractor after this long
MAX_HTML_CHARS = 1_500_000
ROBOTS_AGENT = "LeadMaker"

# ---------------------------------------------------------------------------------------------
# Static knowledge
# ---------------------------------------------------------------------------------------------

FREE_MAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "hotmail.com",
    "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com",
    "protonmail.com", "proton.me", "mail.com", "gmx.com", "gmx.us", "zoho.com", "yandex.com",
    "comcast.net", "verizon.net", "optonline.net", "optimum.net", "att.net", "sbcglobal.net",
    "bellsouth.net", "earthlink.net", "rcn.com", "juno.com", "netzero.net", "cox.net",
    "charter.net", "spectrum.net", "frontier.com", "windstream.net", "aim.com", "inbox.com",
    "hotmail.co.uk", "yahoo.co.uk",
}

# Directories, marketplaces, social networks, manufacturers: never "the company's own site".
DIRECTORY_DOMAINS = (
    "yelp.com", "angi.com", "angieslist.com", "homeadvisor.com", "houzz.com", "facebook.com",
    "fb.com", "fb.me", "instagram.com", "linkedin.com", "twitter.com", "x.com", "bbb.org",
    "thumbtack.com", "porch.com", "buildzoom.com", "manta.com", "yellowpages.com", "yp.com",
    "mapquest.com", "nextdoor.com", "google.com", "goo.gl", "g.page", "maps.app.goo.gl", "gaf.com",
    "bing.com", "chamberofcommerce.com", "bizapedia.com", "opencorporates.com", "homeguide.com",
    "networx.com", "expertise.com", "superpages.com", "citysearch.com", "dnb.com",
    "zoominfo.com", "birdeye.com", "youtube.com", "tiktok.com", "pinterest.com", "alignable.com",
    "buzzfile.com", "threebestrated.com", "hotfrog.com", "brownbook.net", "merchantcircle.com",
    "yahoo.com", "apple.com", "amazon.com", "craigslist.org", "nj.com", "patch.com",
    "wikipedia.org", "trustpilot.com", "glassdoor.com", "indeed.com", "certainteed.com",
    "owenscorning.com", "guildquality.com", "fixr.com", "modernize.com", "homeyou.com",
    "bark.com", "taskrabbit.com", "handy.com", "levelset.com", "nyc.gov", "ny.gov", "nj.gov",
    "duckduckgo.com", "local.com", "cylex.us.com", "ezlocal.com", "showmelocal.com",
    "n49.com", "bestprosintown.com", "roofingcontractor.com", "roofer.com", "roofingbusinesspros.com",
    # payment / scheduling / link-in-bio hosts a domain may forward to (not a company website)
    "merchpay.com", "paypal.com", "squareup.com", "clover.com", "stripe.com", "intuit.com",
    "housecallpro.com", "getjobber.com", "servicetitan.com", "linktr.ee", "calendly.com",
    "invoicesimple.com", "venmo.com",
)

# Domains that parked / for-sale domains redirect to.
PARKING_DOMAINS = (
    "sedoparking.com", "sedo.com", "parkingcrew.net", "bodis.com", "hugedomains.com", "dan.com",
    "afternic.com", "godaddy.com", "namecheap.com", "above.com", "undeveloped.com",
    "domainmarket.com", "buydomains.com", "uniregistry.com", "squadhelp.com", "brandbucket.com",
    "atom.com", "sav.com", "perfectdomain.com", "domainnamesales.com", "epik.com", "porkbun.com",
    "parked.com", "domainlore.com", "efty.com", "spaceship.com", "dynadot.com", "smartname.com",
    "searchhounds.com", "trafficz.com", "voodoo.com", "rookmedia.net", "domainsponsor.com",
)

_PARKED_RE = re.compile(
    r"domain (?:name )?(?:is|may be|could be) for sale|this domain is for sale|buy this domain"
    r"|domain for sale|is for sale[!.]|make an offer on this domain|inquire about this domain"
    r"|\bhugedomains\b|sedoparking|parkingcrew|\bbodis\b|\bdan\.com\b|\bafternic\b|undeveloped\.com"
    r"|\bbuydomains\b|domain ?parking|parked free|parked domain|is parked|domain has been registered"
    r"|this domain (?:has )?(?:expired|is registered)|domain (?:has )?expired|renew (?:this|your) domain"
    r"|future home of|welcome to nginx|apache2 (?:ubuntu|debian) default page|test page for the apache"
    r"|default web ?site page|iis windows server|account (?:has been )?suspended|website is suspended"
    r"|isn.t connected to a website yet|this site is (?:currently )?unavailable|there.s nothing here"
    r"|index of /|web hosting provider|domain is not configured|no website is configured"
    r"|related searches|sponsored listings|location\.href\s*=\s*[\"']/lander|reserved for strategic use"
    r"|qualified inquiries",
    re.I,
)
_COMING_SOON_RE = re.compile(r"coming soon|under construction|launching soon|site is being built|"
                             r"website builder 8\.0", re.I)

ROOF_VOCAB_RE = re.compile(r"\b(?:roof\w*|re-?roof\w*|shingles?|gutters?|leaders|flashing|skylights?)\b", re.I)
TRADE_VOCAB_RE = re.compile(
    r"\b(?:contractors?|construction|renovations?|remodel\w*|masonry|siding|exteriors?|chimneys?"
    r"|waterproofing|brick ?work|stucco|carpentry|windows|home improvement)\b",
    re.I,
)

# NYC-metro area codes (NY + north/central NJ + Long Island / Westchester / Hudson Valley).
LOCAL_AREA_CODES = {
    "212", "646", "332", "917", "718", "347", "929", "516", "631", "934", "914", "845",
    "201", "551", "973", "862", "908", "732", "848", "609", "640", "856", "203", "475",
}
_STATE_NAMES = {"NY": "new york", "NJ": "new jersey", "CT": "connecticut", "PA": "pennsylvania"}

_LEGAL_TOKENS = {"inc", "incorporated", "llc", "corp", "corporation", "co", "company", "ltd",
                 "limited", "lp", "llp", "pllc", "pc", "the"}
# Generic words dropped to get a name's distinctive "core" ("Zicklin Contracting Inc" -> "zicklin").
_FILLER_TOKENS = _LEGAL_TOKENS | {
    "and", "of", "dba", "general", "contractor", "contractors", "contracting", "construction",
    "roofing", "roof", "roofs", "roofers", "roofer", "services", "service", "group", "home", "homes",
    "improvement", "improvements", "enterprises", "enterprise", "restoration", "restorations",
    "exteriors", "exterior", "siding", "remodeling", "renovation", "renovations", "renovators",
    "building", "builders", "solutions", "management", "associates", "ny", "nj", "nyc", "usa",
    "corp", "inc", "llc",
}
_PHONE_RE = re.compile(r"(?<![\d\w])(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\- ]{0,2}(\d{3})[\s.\- ]{1,2}(\d{4})(?!\d)")
_DOMAINISH_RE = re.compile(r"^[\w\-]+(?:\.[\w\-]+)*\.(?:com|net|org|us|biz|info|co|nyc)$", re.I)
_TITLE_SPLIT_RE = re.compile(r"\s+[|\-–—:·•]\s+|\s*[|–—·•]\s*")


# ---------------------------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------------------------


def bare_host(host: str) -> str:
    host = (host or "").lower().strip().rstrip(".")
    host = host.split("@")[-1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def host_matches(host: str, domains: tuple[str, ...] | set[str]) -> str | None:
    """The entry of `domains` that `host` is, or is a subdomain of."""
    h = bare_host(host)
    for d in domains:
        if h == d or h.endswith("." + d):
            return d
    return None


def normalize_origin(url: str | None) -> str | None:
    """'example.com/about' -> 'http://example.com'; 'https://www.X.com/a?b' -> 'https://www.x.com'."""
    if not url:
        return None
    url = url.strip()
    if re.match(r"^[a-z][a-z0-9+.\-]*:(?!//|\d)", url, re.I):  # mailto:, tel:, javascript:, ...
        return None
    if not re.match(r"^[a-z][a-z0-9+.\-]*://", url, re.I):
        url = "http://" + url.lstrip("/")
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    if not host or "." not in host:
        return None
    port = parts.port
    netloc = host if port in (None, 80, 443) else f"{host}:{port}"
    return f"{parts.scheme.lower()}://{netloc}"


def email_domain(email: str | None) -> str | None:
    """Business e-mail domain, or None for free-mail / malformed addresses."""
    if not email or "@" not in email:
        return None
    dom = email.strip().lower().rsplit("@", 1)[1].strip(" >.;,")
    if "." not in dom or dom in FREE_MAIL_DOMAINS or host_matches(dom, DIRECTORY_DOMAINS):
        return None
    return dom


def _strip_legal(toks: list[str]) -> list[str]:
    out = list(toks)
    while out and out[-1] in _LEGAL_TOKENS:
        out.pop()
    while out and out[0] == "the":
        out.pop(0)
    return out


def domain_guesses(names: list[str], state: str | None = None, limit: int = MAX_GUESSES) -> list[str]:
    """Plausible domains for a business, most likely first.

    "ADH Group" (NY) -> adhgroup.com, adh.com?, adhroofing.com, adhconstruction.com, adhgroupny.com,
    adhgroupinc.com, ... Bare cores shorter than 4 characters are skipped (always someone else's).
    """
    st = (state or "").strip().lower()
    locs = [s for s in (st, "nyc" if st == "ny" else "") if s]
    tiers: list[list[str]] = [[] for _ in range(6)]

    for name in names:
        toks = tokens(name)
        if not toks:
            continue
        strict = _strip_legal(toks)
        strict_noand = [t for t in strict if t != "and"]
        if not strict_noand:
            continue
        core = [t for t in strict_noand if t not in _FILLER_TOKENS]
        s_full = "".join(strict_noand)
        s_and = "".join(strict)
        # Tier 0: the name as written (legal suffix dropped), with and without "and".
        tiers[0] += [s_full, s_and]
        if toks != strict:  # full name with its legal suffix
            tiers[2].append("".join(t for t in toks if t != "and"))
        tiers[2] += [s_full + loc for loc in locs]
        if not core:  # nothing distinctive ("Roof Roof Roofing"): only literal variants
            tiers[3] += [s_full + "inc", s_full + "llc", s_full + "co"]
            continue
        c = "".join(core)
        # Tier 1: distinctive core + the most common trade words / bare core.
        tiers[1] += [c + "roofing", c + "construction", c + "contracting"]
        if len(c) >= 4 and len(core) < len(strict_noand):
            tiers[1].append(c)
        # Tier 3: core + state / legal forms / misc.
        tiers[3] += [c + loc for loc in locs] + [c + "roofing" + loc for loc in locs[:1]]
        tiers[3] += [c + "inc", c + "llc", c + "co", c + "usa", c + "roofingco", c + "exteriors"]
        # Tier 4: hyphenated full name.
        if len(strict_noand) > 1:
            tiers[4].append("-".join(strict_noand))

    seen: set[str] = set()
    out: list[str] = []
    for tier in tiers:
        for slug in tier:
            if not (3 <= len(slug) <= 50) or slug in seen or slug.startswith("-"):
                continue
            seen.add(slug)
            out.append(slug + ".com")
    out = out[: max(0, limit - 2)]
    # Other TLDs, sparingly: only the most literal name.
    first = [s for s in tiers[0] if 3 <= len(s) <= 50][:1]
    for slug in first:
        for tld in (".net", ".us"):
            if len(out) < limit:
                out.append(slug + tld)
    return out[:limit]


@dataclass
class PageInfo:
    final_url: str
    title: str = ""
    site_names: list[str] = field(default_factory=list)  # og:site_name, og:title, JSON-LD names
    h1s: list[str] = field(default_factory=list)
    text: str = ""
    phones: set[str] = field(default_factory=set)  # 10-digit numbers seen on the page
    explicit_phones: set[str] = field(default_factory=set)  # tel: links + JSON-LD telephone
    raw_digits_hit: bool = False
    html_len: int = 0
    links: list[str] = field(default_factory=list)  # same-site contact/about pages, best first

    def merge(self, other: "PageInfo") -> "PageInfo":
        """Combine a subpage's evidence into the homepage's (identity fields stay the homepage's)."""
        return PageInfo(
            final_url=self.final_url, title=self.title, site_names=self.site_names + other.site_names,
            h1s=self.h1s, text=(self.text + " \n " + other.text)[:400_000], phones=self.phones | other.phones,
            explicit_phones=self.explicit_phones | other.explicit_phones,
            raw_digits_hit=self.raw_digits_hit or other.raw_digits_hit, html_len=self.html_len,
            links=self.links,
        )


def _walk_jsonld(obj: Any, names: list[str], phones: set[str], depth: int = 0) -> None:
    if depth > 6:
        return
    if isinstance(obj, list):
        for x in obj:
            _walk_jsonld(x, names, phones, depth + 1)
    elif isinstance(obj, dict):
        typ = obj.get("@type")
        typ_s = " ".join(typ) if isinstance(typ, list) else str(typ or "")
        nm = obj.get("name")
        if isinstance(nm, str) and nm.strip() and re.search(
            r"Organization|Business|Contractor|Roofing|Service|Corporation|WebSite|Home", typ_s
        ):
            names.append(nm.strip())
        tel = obj.get("telephone")
        for t in tel if isinstance(tel, list) else [tel]:
            d = phone_digits(t) if isinstance(t, str) else None
            if d:
                phones.add(d)
        for v in obj.values():
            if isinstance(v, (dict, list)):
                _walk_jsonld(v, names, phones, depth + 1)


_SUBPAGE_RE = re.compile(r"contact|about|location|find-us|reach-us", re.I)


def _subpage_links(tree: LexborHTMLParser, base_url: str) -> list[str]:
    """Same-site contact / about pages linked from the homepage (contact first)."""
    base = urlsplit(base_url)
    home = bare_host(base.hostname or "")
    scored: dict[str, int] = {}
    for n in tree.css("a[href]"):
        href = (n.attributes.get("href") or "").strip()
        label = re.sub(r"\s+", " ", n.text() or "").strip()[:60]
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        if not (_SUBPAGE_RE.search(href) or _SUBPAGE_RE.search(label)):
            continue
        url = urljoin(base_url, href).split("#")[0]
        u = urlsplit(url)
        if u.scheme not in ("http", "https") or bare_host(u.hostname or "") != home:
            continue
        if not u.path.strip("/") or re.search(r"\.(?:pdf|jpe?g|png|gif|zip|docx?)$", u.path, re.I):
            continue
        rank = 0 if re.search(r"contact", href + " " + label, re.I) else 1
        if len(u.path) > 60:  # blog posts that merely mention "about"
            rank += 2
        scored[url] = min(scored.get(url, 9), rank)
    return [u for u, _ in sorted(scored.items(), key=lambda kv: kv[1])][:4]


def parse_page(html: str, final_url: str, phone: str | None = None) -> PageInfo:
    """Extract identity evidence from a homepage."""
    html = html[:MAX_HTML_CHARS]
    info = PageInfo(final_url=final_url, html_len=len(html))
    tree = LexborHTMLParser(html)
    t = tree.css_first("title")
    info.title = re.sub(r"\s+", " ", t.text() if t else "").strip()[:300]
    for sel in ('meta[property="og:site_name"]', 'meta[name="og:site_name"]', 'meta[property="og:title"]',
                'meta[name="application-name"]', 'meta[name="apple-mobile-web-app-title"]'):
        for n in tree.css(sel):
            v = (n.attributes.get("content") or "").strip()
            if v:
                info.site_names.append(v[:200])
    for n in tree.css('script[type="application/ld+json"]'):
        try:
            _walk_jsonld(json.loads(n.text() or ""), info.site_names, info.explicit_phones)
        except (ValueError, TypeError):
            continue
    for n in tree.css('a[href^="tel:"], a[href^="TEL:"], a[href^="Tel:"]'):
        d = phone_digits((n.attributes.get("href") or "")[4:])
        if d:
            info.explicit_phones.add(d)
    for n in tree.css("h1")[:4]:
        v = re.sub(r"\s+", " ", n.text() or "").strip()
        if v:
            info.h1s.append(v[:200])
    info.links = _subpage_links(tree, final_url)
    for n in tree.css("script, style, noscript, template, svg"):
        n.decompose()
    body = tree.body or tree.root
    text = body.text(separator=" ") if body is not None else ""
    info.text = re.sub(r"\s+", " ", text).strip()[:200_000]
    for m in _PHONE_RE.finditer(info.text):
        info.phones.add("".join(m.groups()))
    info.phones |= info.explicit_phones
    pd = phone_digits(phone)
    if pd and pd not in info.phones:
        # Phone hidden in scripts / data attributes (common on Wix, Duda, Squarespace sites).
        a, b, c = pd[:3], pd[3:6], pd[6:]
        pat = rf"(?<!\d)(?:\+?1[\s.\-]?)?\(?{a}\)?[\s.\- ]{{0,2}}{b}[\s.\- ]{{0,2}}{c}(?!\d)"
        info.raw_digits_hit = re.search(pat, html) is not None
    return info


def parked_reason(info: PageInfo, html: str) -> str | None:
    """Why this page looks like a parked / for-sale / placeholder page (None = looks real)."""
    if host_matches(urlsplit(info.final_url).hostname or "", PARKING_DOMAINS):
        return f"redirects to parking host {urlsplit(info.final_url).hostname}"
    probe = " ".join([info.title, info.text[:5000], html[:20000] if len(info.text) < 300 else ""])
    m = _PARKED_RE.search(probe)
    if m:
        return f"parked/placeholder text: {m.group(0)!r}"
    if len(info.text) < 1500 and _COMING_SOON_RE.search(" ".join([info.title, *info.h1s, info.text])):
        return "placeholder page (coming soon / under construction)"
    return None


def _segments(s: str) -> list[str]:
    segs = [x.strip() for x in _TITLE_SPLIT_RE.split(s or "") if x and x.strip()]
    if s and s.strip() and s.strip() not in segs:
        segs.append(s.strip())
    return [x for x in segs if not _DOMAINISH_RE.match(x)]


def _norm_text_tokens(text: str) -> str:
    return " " + " ".join(tokens(text)) + " "


@dataclass
class Score:
    score: float
    evidence: list[str]
    name_ok: bool = False  # page carries the business name (title/site name/h1 or body text)
    phone_hit: bool = False  # the contractor's phone number is on the page


_DIRECTIONALS = {"n", "s", "e", "w", "north", "south", "east", "west", "ne", "nw", "se", "sw"}


def street_pattern(street: str | None) -> re.Pattern[str] | None:
    r"""'53 Euclid Ave' -> /\b53\s+euclid\b/ (house number + first street-name word)."""
    toks = tokens(street)
    if len(toks) < 2 or not re.fullmatch(r"\d+[a-z]?", toks[0]):
        return None
    rest = [t for t in toks[1:4] if t not in _DIRECTIONALS]
    if not rest:
        return None
    return re.compile(rf"(?<![\w-]){re.escape(toks[0])}\W+(?:[a-z]+\.?\s+)?{re.escape(rest[0])}", re.I)


def score_page(info: PageInfo, ctx: LeadContext) -> Score:
    """Probability-like score that this homepage belongs to the contractor in `ctx`."""
    ev: list[str] = []
    names = ctx.names()
    pd = phone_digits(ctx.get("phone"))
    phone_hit = bool(pd and (pd in info.phones or info.raw_digits_hit))
    if phone_hit:
        ev.append(f"phone {pd} on page")

    # Name similarity with title segments / site names / h1s.
    best_sim, best_where = 0.0, ""
    fields = [("title", s) for s in _segments(info.title)]
    fields += [("site_name", s) for x in info.site_names for s in _segments(x)]
    fields += [("h1", s) for x in info.h1s for s in _segments(x)]
    for nm in names:
        for where, val in fields:
            if len(val) > 120:
                continue
            sim = name_similarity(nm, val)
            if sim > best_sim:
                best_sim, best_where = sim, f"{where} {val!r}"
    if best_sim >= 0.7:
        ev.append(f"name~{best_where} ({best_sim:.2f})")

    page_toks = _norm_text_tokens(" ".join([info.title, *info.site_names, *info.h1s, info.text]))
    name_in_text = False
    for nm in names:
        strict = normalize_name(nm, strict=True)
        if strict and (len(strict.split()) >= 2 or len(strict) >= 6) and f" {strict} " in page_toks:
            name_in_text = True
            ev.append(f"name {strict!r} in page text")
            break

    # Locality.
    text_l = info.text.lower()
    z = zip5(ctx.get("postal_code"))
    city = (ctx.get("city") or "").strip().lower()
    state = (ctx.get("state") or "").strip().upper()
    zip_hit = bool(z and re.search(rf"(?<!\d){z}(?!\d)", info.text))
    if city == "new york":  # the city name doubles as the state name; look for Manhattan/NYC instead
        city_hit = bool(re.search(r"\bmanhattan\b|\bnyc\b|new york,? ny\b|new york city", text_l))
    else:
        city_hit = bool(city and re.search(rf"\b{re.escape(city)}\b", text_l))
    st_name = _STATE_NAMES.get(state)
    state_hit = bool(
        state and (re.search(rf"\b{state}\b", info.text) or (st_name and st_name in text_l))
    )
    if zip_hit:
        ev.append(f"zip {z}")
    if city_hit:
        ev.append(f"city {city}")
    if state_hit:
        ev.append(f"state {state}")
    roof = len(ROOF_VOCAB_RE.findall(info.text[:50000]))
    trade = bool(TRADE_VOCAB_RE.search(info.text[:50000]))
    if roof:
        ev.append(f"roofing vocabulary x{roof}")
    elif trade:
        ev.append("construction vocabulary")

    sp = street_pattern(ctx.get("street"))
    street_hit = bool(sp and (zip_hit or city_hit) and sp.search(info.text))
    if street_hit:
        ev.append(f"street address {ctx.get('street')!r}")

    name_ok = best_sim >= 0.7 or name_in_text
    if phone_hit:
        s = 0.9 + (0.05 if name_ok else 0.0) + (0.03 if (zip_hit or city_hit or state_hit) else 0.0)
        return Score(min(s, 0.99), ev, name_ok, True)

    # No phone match: name + locality must carry it, so a same-named business elsewhere loses.
    n = 0.45 if best_sim >= 0.95 else 0.35 if best_sim >= 0.85 else 0.2 if best_sim >= 0.7 else 0.0
    if name_in_text:
        n = n + 0.05 if n else 0.3
    local = zip_hit or city_hit
    loc = (0.15 if zip_hit else 0.12 if city_hit else 0.0) + (0.03 if state_hit else 0.0)
    vocab = 0.1 if roof >= 2 else 0.05 if (roof or trade) else -0.15
    s = n + loc + vocab
    others = info.phones - ({pd} if pd else set())
    if others:
        if not any(p[:3] in LOCAL_AREA_CODES for p in others):
            s -= 0.1 if local else 0.25
            ev.append("only non-local phone numbers on page: " + ",".join(sorted(others)[:3]))
        else:
            s -= 0.05 if local else 0.1
            ev.append("page phone(s) differ: " + ",".join(sorted(others)[:3]))
    if street_hit:  # same street address as the GAF listing
        s = max(s, 0.8 if n >= 0.3 else 0.55)
    if n == 0:
        s = min(s, 0.3)
    if not local:  # never accept on name alone
        s = min(s, ACCEPT_SCORE - 0.05)
    return Score(round(max(0.0, min(s, 0.8)), 3), ev, name_ok)


# ---------------------------------------------------------------------------------------------
# Search APIs (optional, key-gated; official APIs only -- never scraped result pages)
# ---------------------------------------------------------------------------------------------


def parse_brave_results(payload: dict[str, Any]) -> list[str]:
    return [r["url"] for r in (payload.get("web") or {}).get("results") or [] if isinstance(r, dict) and r.get("url")]


def parse_serpapi_results(payload: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for r in payload.get("local_results") or []:
        if isinstance(r, dict) and r.get("website"):
            urls.append(r["website"])
    places = payload.get("local_results", {})
    if isinstance(places, dict):
        for r in places.get("places") or []:
            if isinstance(r, dict) and (r.get("links") or {}).get("website"):
                urls.append(r["links"]["website"])
    kg = payload.get("knowledge_graph") or {}
    if isinstance(kg, dict) and kg.get("website"):
        urls.append(kg["website"])
    for r in payload.get("organic_results") or []:
        if isinstance(r, dict) and r.get("link"):
            urls.append(r["link"])
    return urls


# ---------------------------------------------------------------------------------------------
# Enricher
# ---------------------------------------------------------------------------------------------


@dataclass
class Candidate:
    host: str  # host to probe (may be bare or www.)
    method: str
    prior: float = 0.0  # confidence carried over from the candidate's source
    note: str = ""


@dataclass
class Probe:
    url: str  # what we asked for
    origin: str | None = None  # final origin after redirects
    score: float = 0.0
    evidence: list[str] = field(default_factory=list)
    title: str = ""
    fetched: list[str] = field(default_factory=list)
    error: str | None = None


class WebsiteDiscoveryEnricher(Enricher):
    name = "website_discovery"
    depends_on = ("google_places", "osm")

    def __init__(self, settings: Settings):
        super().__init__(settings)
        self.brave_key = os.environ.get("BRAVE_SEARCH_API_KEY") or None
        self.serpapi_key = os.environ.get("SERPAPI_KEY") or None
        self._dns_sem = asyncio.Semaphore(24)
        self._hijack_ips: set[str] = set()
        self._robots_cache: dict[str, robotparser.RobotFileParser | None] = {}

    # -- lifecycle -------------------------------------------------------------------------
    async def prepare(self, http: HttpClient, contractors: list[dict[str, Any]]) -> None:
        # ISPs that "helpfully" resolve NXDOMAIN to an ad server would make every guess look live.
        bogus = f"leadmaker-nx-{uuid.uuid4().hex[:12]}.com"
        self._hijack_ips = set(await self._resolve(bogus) or [])
        if self._hijack_ips:
            log.warning("DNS resolver answers for nonexistent domains (%s); filtering those IPs",
                        ",".join(sorted(self._hijack_ips)))

    # -- DNS -------------------------------------------------------------------------------
    async def _resolve(self, host: str) -> list[str] | None:
        loop = asyncio.get_running_loop()
        async with self._dns_sem:
            try:
                infos = await asyncio.wait_for(
                    loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM), DNS_TIMEOUT_S
                )
            except (OSError, asyncio.TimeoutError, UnicodeError):
                return None
        ips = sorted({i[4][0] for i in infos})
        if ips and self._hijack_ips and set(ips) <= self._hijack_ips:
            return None
        return ips or None

    async def _live_host(self, domain: str) -> str | None:
        """The host to probe for `domain` (bare, else www.), or None if neither resolves."""
        if await self._resolve(domain):
            return domain
        if not domain.startswith("www.") and await self._resolve("www." + domain):
            return "www." + domain
        return None

    # -- HTTP ------------------------------------------------------------------------------
    async def _robots_allows(self, http: HttpClient, scheme: str, host: str, path: str = "/") -> bool:
        key = f"{scheme}://{host}"
        if key not in self._robots_cache:
            rp: robotparser.RobotFileParser | None = None
            try:
                r = await http.get(f"{key}/robots.txt", retries=0, timeout=ROBOTS_TIMEOUT_S,
                                   allow_statuses=(401, 403, 404, 410, 500, 502, 503))
                if r.status == 200 and "<html" not in r.text[:500].lower():
                    rp = robotparser.RobotFileParser()
                    rp.parse(r.text.splitlines())
            except HttpError:
                rp = None
            self._robots_cache[key] = rp
        rp = self._robots_cache[key]
        if rp is None:
            return True
        return rp.can_fetch(ROBOTS_AGENT, f"{key}{path}") and rp.can_fetch("*", f"{key}{path}")

    async def _fetch_home(self, http: HttpClient, host: str) -> tuple[str, Any] | tuple[str, HttpError]:
        last: HttpError | None = None
        for scheme in ("https", "http"):
            url = f"{scheme}://{host}/"
            try:
                if not await self._robots_allows(http, scheme, host):
                    return url, HttpError("robots.txt disallows /", url=url)
                r = await http.get(url, retries=0, timeout=FETCH_TIMEOUT_S)
                return url, r
            except HttpError as e:
                last = e
                if e.status is not None:  # the server answered; switching scheme won't help
                    return url, e
        assert last is not None
        return f"http://{host}/", last

    async def _fetch_subpage(self, http: HttpClient, url: str, ctx: LeadContext) -> PageInfo | None:
        parts = urlsplit(url)
        try:
            if not await self._robots_allows(http, parts.scheme, parts.netloc, parts.path or "/"):
                return None
            r = await http.get(url, retries=0, timeout=FETCH_TIMEOUT_S)
        except HttpError:
            return None
        if bare_host(urlsplit(r.url).hostname or "") != bare_host(parts.hostname or ""):
            return None
        return parse_page(r.text or "", r.url, ctx.get("phone"))

    async def _probe_capped(self, http: HttpClient, cand: Candidate, ctx: LeadContext) -> Probe:
        """`_probe` under a hard wall-clock cap, so one slow-dripping host can't stall a run."""
        try:
            return await asyncio.wait_for(self._probe(http, cand, ctx), PROBE_TIMEOUT_S)
        except asyncio.TimeoutError:
            url = f"https://{cand.host}/"
            p = Probe(url=url, error=f"probe timed out after {PROBE_TIMEOUT_S:.0f}s")
            p.evidence.append(p.error)
            if cand.prior:
                p.origin = normalize_origin(url)
                p.score = round(cand.prior * 0.9, 3)
                p.evidence.append(f"unverified; {cand.method} prior {cand.prior:.2f}")
            return p

    async def _probe(self, http: HttpClient, cand: Candidate, ctx: LeadContext) -> Probe:
        url, res = await self._fetch_home(http, cand.host)
        p = Probe(url=url)
        if isinstance(res, HttpError):
            p.error = str(res)[:200]
            p.evidence.append(f"fetch failed: {p.error}")
            if cand.prior and "robots" not in p.error:
                # A known website we couldn't verify (bot wall / downtime): keep the source's word.
                p.origin = normalize_origin(url)
                p.score = round(cand.prior * 0.9, 3)
                p.evidence.append(f"unverified; {cand.method} prior {cand.prior:.2f}")
            return p
        p.fetched.append(res.url)
        p.origin = normalize_origin(res.url)
        final_host = urlsplit(res.url).hostname or ""
        if host_matches(final_host, DIRECTORY_DOMAINS):
            p.evidence.append(f"directory/marketplace host {bare_host(final_host)}")
            return p
        info = parse_page(res.text or "", res.url, ctx.get("phone"))
        p.title = info.title
        why = parked_reason(info, res.text or "")
        if why:
            p.evidence.append(why)
            return p
        sc = score_page(info, ctx)
        if not sc.phone_hit and info.links and (sc.name_ok or sc.score >= 0.3):
            # Name matches but the homepage lacks the phone / locality: check contact & about pages.
            merged = info
            for link in info.links[:MAX_SUBPAGES]:
                sub = await self._fetch_subpage(http, link, ctx)
                if sub is None:
                    continue
                p.fetched.append(link)
                merged = merged.merge(sub)
            if merged is not info:
                sc2 = score_page(merged, ctx)
                if sc2.score > sc.score:
                    sc = Score(sc2.score, sc2.evidence + [f"via subpages ({len(p.fetched) - 1})"],
                               sc2.name_ok, sc2.phone_hit)
        p.evidence += sc.evidence
        page = sc.score
        if cand.prior:
            page = 1 - (1 - cand.prior) * (1 - page)
            p.evidence.append(f"{cand.method} prior {cand.prior:.2f}")
        p.score = round(min(page, 0.99), 3)
        if bare_host(final_host) != bare_host(cand.host):
            p.evidence.append(f"redirected from {cand.host}")
        return p

    # -- candidates ------------------------------------------------------------------------
    def _known_candidates(self, ctx: LeadContext) -> list[Candidate]:
        out: list[Candidate] = []
        for src in ("google_places", "osm"):
            r = ctx.ok_prior(src)
            if r is None:
                continue
            site = r.website or (r.data or {}).get("website")
            origin = normalize_origin(site)
            if origin:
                prior = max(0.0, min(0.8, 0.85 * (r.confidence or 0.0)))
                out.append(Candidate(urlsplit(origin).hostname or "", src, prior, note=site or ""))
        for src in ("osm", "google_places"):
            r = ctx.ok_prior(src)
            if r is None:
                continue
            emails = [(r.data or {}).get("email")] + [c.email for c in r.contacts if c.email]
            for em in emails:
                dom = email_domain(em)
                if dom:
                    out.append(Candidate(dom, "email_domain", 0.2, note=em or ""))
        return out

    async def _search_candidates(self, http: HttpClient, ctx: LeadContext) -> tuple[list[Candidate], list[str]]:
        if not (self.brave_key or self.serpapi_key):
            return [], []
        names = ctx.names()
        if not names:
            return [], []
        q = f"\"{ctx.get('name') or names[0]}\" {ctx.get('city') or ''} {ctx.get('state') or ''} roofing".strip()
        urls: list[str] = []
        read: list[str] = []
        try:
            if self.brave_key:
                api = f"https://api.search.brave.com/res/v1/web/search?q={quote_plus(q)}&count=10&country=us"
                r = await http.get(api, headers={"Accept": "application/json",
                                                 "X-Subscription-Token": self.brave_key}, retries=1)
                urls = parse_brave_results(r.json())
                read.append(api.split("?")[0] + f"?q={quote_plus(q)}")
            else:
                api = (f"https://serpapi.com/search.json?engine=google&q={quote_plus(q)}"
                       f"&location=New+York,United+States&num=10")
                r = await http.get(api + f"&api_key={self.serpapi_key}", retries=1)
                urls = parse_serpapi_results(r.json())
                read.append(api)
        except (HttpError, ValueError) as e:
            log.info("search API failed for %s: %s", ctx.gaf_id, e)
            return [], read
        out: list[Candidate] = []
        for i, u in enumerate(urls[:8]):
            origin = normalize_origin(u)
            host = urlsplit(origin).hostname if origin else None
            if not host or host_matches(host, DIRECTORY_DOMAINS) or host_matches(host, PARKING_DOMAINS):
                continue
            out.append(Candidate(host, "search_api", max(0.0, 0.15 - 0.02 * i), note=u))
        return out[:4], read

    # -- main ------------------------------------------------------------------------------
    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        names = ctx.names()
        started = asyncio.get_running_loop().time()
        probes: list[tuple[Candidate, Probe]] = []
        tried: set[str] = set()
        source_urls: list[str] = []

        def best() -> tuple[Candidate, Probe] | None:
            ok = [cp for cp in probes if cp[1].origin]
            return max(ok, key=lambda cp: cp[1].score) if ok else None

        async def run(batch: list[Candidate]) -> None:
            fresh = []
            for c in batch:
                k = bare_host(c.host)
                if k and k not in tried:
                    tried.add(k)
                    fresh.append(c)
            res = await asyncio.gather(*(self._probe_capped(http, c, ctx) for c in fresh))
            for c, p in zip(fresh, res):
                probes.append((c, p))
                source_urls.extend(p.fetched)
                if p.origin:
                    tried.add(bare_host(urlsplit(p.origin).hostname or ""))

        # 1-2. Websites / e-mail domains already known from other sources.
        known = [c for c in self._known_candidates(ctx)
                 if not host_matches(c.host, DIRECTORY_DOMAINS)]
        if known:
            await run(known)
        # 3. Optional search API.
        b = best()
        search_cands: list[Candidate] = []
        if not b or b[1].score < STRONG_SCORE:
            search_cands, read = await self._search_candidates(http, ctx)
            source_urls.extend(read)
            if search_cands:
                await run(search_cands)
        # 4. Domain guessing.
        guesses = domain_guesses(names, ctx.get("state"))
        live: list[str] = []
        b = best()
        if guesses and (not b or b[1].score < STRONG_SCORE):
            hosts = await asyncio.gather(*(self._live_host(d) for d in guesses))
            live = [h for h in hosts if h]
            budget = MAX_PROBES
            queue = [Candidate(h, "domain_guess") for h in live]
            while queue and budget > 0:
                b = best()
                if b and b[1].score >= STRONG_SCORE:
                    break
                if asyncio.get_running_loop().time() - started > CONTRACTOR_BUDGET_S:
                    log.info("website_discovery: time budget spent for %s; %d guesses unprobed",
                             ctx.get("name"), len(queue))
                    break
                batch, queue = queue[: min(PROBE_BATCH, budget)], queue[min(PROBE_BATCH, budget):]
                budget -= len(batch)
                await run(batch)

        cands = sorted(probes, key=lambda cp: -cp[1].score)
        data_cands = [
            {"url": p.origin or p.url, "score": p.score, "evidence": p.evidence, "method": c.method,
             **({"title": p.title} if p.title else {})}
            for c, p in cands
        ]
        b = best()
        stats = {"guesses": len(guesses), "resolved": live, "probed": len(probes)}
        if b and b[1].score >= ACCEPT_SCORE:
            c, p = b
            data = {"website": p.origin, "method": c.method, "candidates": data_cands, **stats}
            return self.ok(data, p.score, website=p.origin, source_urls=list(dict.fromkeys(source_urls)))
        return self.no_match({"candidates": data_cands, **stats}, source_urls=list(dict.fromkeys(source_urls)))
