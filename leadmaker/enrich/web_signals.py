"""Digital-presence & growth signals from a contractor's own website + open archives.

For a contractor whose website is already known (website_discovery / google_places / osm),
this enricher reads:

  * the homepage HTML + response headers (one request, robots.txt respected) and
    fingerprints the site builder / CMS, ad & analytics pixels (Google Ads, Meta Pixel,
    Bing UET...), call tracking, CRM / marketing automation, live chat, review widgets,
    instant-quote tools, consumer-financing providers (GreenSky, Hearth, Enhancify, Service
    Finance...), roofing-manufacturer brands mentioned (GAF, Owens Corning, CertainTeed...),
    social-profile links, careers/hiring links and the footer copyright year;
  * optionally the linked financing page (one request) to name the lender;
  * the Internet Archive Wayback CDX API: first/last homepage capture and the number of
    distinct months captured ("online since", "site still maintained");
  * RDAP (the IETF successor to WHOIS, run by the registries): domain registration date.

Everything here is public, keyless and ToS-compatible: the contractor's own public homepage
(robots.txt honoured), the Wayback CDX API (documented for programmatic use, no robots.txt)
and registry RDAP services. No social networks are fetched -- only the links the contractor
publishes on its own site.

Output keys in `data` (stable contract):
  website, final_url, http_status, robots_disallowed,
  tech{category: [names]}, ad_pixels[], advertises (bool), call_tracking[],
  financing{offered, providers[], page}, chat[], instant_quote[], crm_marketing[],
  review_widgets[], field_software[], brands[], social{platform: url},
  careers{page, hiring_text, ats[]}, copyright_year, generator,
  wayback{first_capture, last_capture, months_captured, first_year},
  domain{registered, expires, registrar, rdap_url},
  marketing_score (0..10), talking_points[]
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from ..http import HttpClient, HttpError
from ..models import EnrichmentResult
from .base import Enricher, LeadContext

UA_TOKEN = "LeadMaker"

# ---------------------------------------------------------------------------
# Fingerprint signatures: (name, category, [regex over lowercased html + headers])
# ---------------------------------------------------------------------------
SIGNATURES: list[tuple[str, str, list[str]]] = [
    # Site builders / CMS
    ("WordPress", "cms", [r"/wp-content/", r"/wp-includes/", r"<meta name=\"generator\" content=\"wordpress"]),
    ("Wix", "cms", [r"static\.wixstatic\.com", r"x-wix-request-id", r"wix\.com website builder"]),
    ("Squarespace", "cms", [r"static1\.squarespace\.com", r"squarespace-cdn", r"<!-- this is squarespace"]),
    ("GoDaddy Website Builder", "cms", [r"img1\.wsimg\.com/isteam", r"godaddy website builder", r"websites\.godaddy\.com"]),
    ("Weebly", "cms", [r"weebly\.com", r"editmysite\.com"]),
    ("Duda", "cms", [r"dudamobile\.com", r"irp\.cdn-website\.com", r"multiscreensite\.com"]),
    ("Webflow", "cms", [r"webflow\.(js|css|com)", r"data-wf-site"]),
    ("Shopify", "cms", [r"cdn\.shopify\.com"]),
    ("Joomla", "cms", [r"<meta name=\"generator\" content=\"joomla"]),
    ("Drupal", "cms", [r"drupal-settings-json", r"/sites/default/files/"]),
    ("HubSpot CMS", "cms", [r"hs-sites\.com", r"x-hs-hub-id", r"hubspot cms"]),
    ("Hibu", "cms", [r"hibu\.com", r"hibu-cdn"]),
    ("Thryv", "cms", [r"thryv\.com|thryvpaywidget"]),
    ("Scorpion", "cms", [r"scorpion\.co", r"scorpioncms"]),
    ("Next.js", "framework", [r"/_next/static/", r"__next_data__"]),
    ("Gatsby", "framework", [r"___gatsby"]),
    ("Nuxt", "framework", [r"__nuxt"]),
    ("Elementor", "wp_builder", [r"elementor"]),
    ("Divi", "wp_builder", [r"et_pb_|/themes/divi"]),
    ("WPBakery", "wp_builder", [r"js_composer|vc_row"]),
    # Hosting / CDN (headers)
    ("Cloudflare", "hosting", [r"server: cloudflare", r"cf-ray:"]),
    ("WP Engine", "hosting", [r"wpengine", r"x-powered-by: wp engine"]),
    ("Kinsta", "hosting", [r"x-kinsta-cache|kinsta"]),
    ("SiteGround", "hosting", [r"x-siteground|sgcachepress|siteground"]),
    ("GoDaddy hosting", "hosting", [r"secureserver\.net|x-siteid"]),
    # Analytics / tag managers
    ("Google Analytics", "analytics", [r"google-analytics\.com/(analytics|ga)\.js", r"gtag\(['\"]config['\"],\s*['\"]g-", r"googletagmanager\.com/gtag/js\?id=g-", r"ua-\d{4,10}-\d"]),
    ("Google Tag Manager", "analytics", [r"googletagmanager\.com/gtm\.js", r"gtm-[a-z0-9]{5,8}"]),
    ("Microsoft Clarity", "analytics", [r"clarity\.ms"]),
    ("Hotjar", "analytics", [r"hotjar\.com|hjid"]),
    # Ad pixels (proxy for paid advertising)
    ("Google Ads", "ad_pixel", [r"gtag\(['\"]config['\"],\s*['\"]aw-\d+", r"googletagmanager\.com/gtag/js\?id=aw-", r"googleadservices\.com/pagead/conversion", r"\baw-\d{8,12}\b"]),
    ("Meta Pixel", "ad_pixel", [r"connect\.facebook\.net/[a-z_]+/fbevents\.js", r"fbq\(['\"]init['\"]"]),
    ("Microsoft Ads (UET)", "ad_pixel", [r"bat\.bing\.com"]),
    ("TikTok Pixel", "ad_pixel", [r"analytics\.tiktok\.com"]),
    ("LinkedIn Insight", "ad_pixel", [r"snap\.licdn\.com", r"_linkedin_partner_id"]),
    ("Nextdoor Pixel", "ad_pixel", [r"ads\.nextdoor\.com|ndp\.nextdoor|nextdoor\.com/.*pixel"]),
    # Call tracking
    ("CallRail", "call_tracking", [r"cdn\.callrail\.com|callrail"]),
    ("WhatConverts", "call_tracking", [r"whatconverts"]),
    ("CallTrackingMetrics", "call_tracking", [r"tctm\.co|calltrackingmetrics"]),
    ("Invoca", "call_tracking", [r"invoca\.net|invocacdn"]),
    # CRM / marketing automation
    ("HubSpot", "crm_marketing", [r"js\.hs-scripts\.com|js\.hsforms\.net|hs-analytics\.net|js\.hubspot\.com"]),
    ("GoHighLevel / LeadConnector", "crm_marketing", [r"leadconnectorhq\.com|msgsndr\.com|gohighlevel|link\.msgsndr"]),
    ("Mailchimp", "crm_marketing", [r"chimpstatic\.com|list-manage\.com"]),
    ("Constant Contact", "crm_marketing", [r"constantcontact|ctctcdn"]),
    ("ActiveCampaign", "crm_marketing", [r"activehosted\.com|trackcmp\.net"]),
    ("Keap", "crm_marketing", [r"infusionsoft|keap\.app"]),
    ("Salesforce", "crm_marketing", [r"salesforce\.com|pardot\.com|force\.com/servlet"]),
    ("Zoho", "crm_marketing", [r"zoho\.com/crm|zohopublic|salesiq\.zoho"]),
    ("JobNimbus", "field_software", [r"jobnimbus"]),
    ("AccuLynx", "field_software", [r"acculynx"]),
    ("Leap", "field_software", [r"leaptodigital|leap\.us"]),
    ("Housecall Pro", "field_software", [r"housecallpro"]),
    ("Jobber", "field_software", [r"getjobber\.com|jobber\.com"]),
    ("ServiceTitan", "field_software", [r"servicetitan"]),
    ("CompanyCam", "field_software", [r"companycam"]),
    ("Calendly", "field_software", [r"calendly\.com"]),
    ("MarketSharp", "field_software", [r"marketsharp"]),
    ("Improveit 360", "field_software", [r"improveit360"]),
    # Live chat / messaging
    ("Podium", "chat", [r"podium\.com|podium-webchat|connect\.podium"]),
    ("Birdeye", "chat", [r"birdeye\.com"]),
    ("Tawk.to", "chat", [r"embed\.tawk\.to"]),
    ("LiveChat", "chat", [r"cdn\.livechatinc\.com"]),
    ("Drift", "chat", [r"js\.driftt\.com"]),
    ("Intercom", "chat", [r"widget\.intercom\.io"]),
    ("Tidio", "chat", [r"code\.tidio\.co"]),
    ("Ngage / ApexChat", "chat", [r"ngagelive|apexchat"]),
    ("Smith.ai", "chat", [r"smith\.ai"]),
    ("Zendesk Chat", "chat", [r"zopim|zdassets\.com"]),
    ("Facebook Messenger chat", "chat", [r"fb-customerchat|customerchat\.js"]),
    ("LeadConnector chat", "chat", [r"widgets\.leadconnectorhq\.com"]),
    # Review widgets / reputation
    ("Birdeye reviews", "review_widget", [r"birdeye\.com/widget|birdeye\.com/embed"]),
    ("NiceJob", "review_widget", [r"nicejob"]),
    ("Trustindex", "review_widget", [r"trustindex"]),
    ("Elfsight", "review_widget", [r"elfsight"]),
    ("GuildQuality", "review_widget", [r"guildquality"]),
    ("Grade.us", "review_widget", [r"grade\.us"]),
    ("Broadly", "review_widget", [r"broadly\.com"]),
    # Instant roof-quote / estimators
    ("Roofle (RoofQuote PRO)", "instant_quote", [r"roofle|roofquotepro|roof-quote-pro"]),
    ("Roofr", "instant_quote", [r"roofr\.com"]),
    ("Instant Roofer", "instant_quote", [r"instantroofer"]),
    ("Hover", "instant_quote", [r"hover\.to"]),
    ("Instant estimate (generic)", "instant_quote", [r"instant (roof )?(quote|estimate)"]),
]

FINANCING: list[tuple[str, list[str]]] = [
    ("GreenSky", [r"greensky"]),
    ("Hearth", [r"gethearth\.com|hearth financing|app\.gethearth"]),
    ("Enhancify", [r"enhancify"]),
    ("Service Finance Company", [r"svcfin\.com|service finance company"]),
    ("Synchrony", [r"synchrony"]),
    ("Wisetack", [r"wisetack"]),
    ("Acorn Finance", [r"acornfinance"]),
    ("GoodLeap", [r"goodleap"]),
    ("Mosaic", [r"joinmosaic|mosaic financing"]),
    ("Sunlight Financial", [r"sunlightfinancial"]),
    ("Foundation Finance", [r"foundationfinance|foundation finance company"]),
    ("FTL Finance", [r"ftlfinance"]),
    ("Regions / EnerBank", [r"enerbank|regions home improvement"]),
    ("Upgrade", [r"upgrade\.com/(home-improvement|partners)"]),
    ("LightStream", [r"lightstream"]),
    ("Ygrene (PACE)", [r"ygrene"]),
    ("Fortiva / Atlanticus", [r"fortiva"]),
    ("Momnt", [r"momnt"]),
]

BRANDS: list[tuple[str, str]] = [
    ("GAF", r"\bgaf\b|timberline"),
    ("Owens Corning", r"owens\s*corning|duration shingles|platinum preferred"),
    ("CertainTeed", r"certainteed|landmark shingles|shinglemaster"),
    ("Atlas Roofing", r"atlas roofing|pinnacle pristine|stormmaster"),
    ("IKO", r"\biko\b"),
    ("TAMKO", r"tamko"),
    ("Malarkey", r"malarkey"),
    ("DaVinci", r"davinci roofscapes|davinci shake|davinci slate"),
    ("DECRA", r"\bdecra\b"),
    ("Velux", r"velux"),
    ("James Hardie", r"james\s*hardie|hardieplank|hardie board"),
    ("Alside", r"\balside\b"),
    ("Mastic", r"mastic home exteriors|\bmastic\b siding"),
    ("Royal Building Products", r"royal building products"),
    ("Andersen", r"\bandersen\b"),
    ("Pella", r"\bpella\b"),
    ("Firestone / Holcim Elevate", r"firestone building|holcim elevate|elevate roofing"),
    ("Carlisle", r"carlisle syntec|carlisle roofing"),
    ("Englert", r"englert"),
    ("LeafFilter / Leaf Guard", r"leaffilter|leaf guard|leafguard"),
]

SOCIAL: list[tuple[str, str]] = [
    ("facebook", r"https?://(?:www\.|m\.)?facebook\.com/(?!sharer|share|plugins|tr\b|tr\?|dialog|login|policy)[^\s\"'<>)]+"),
    ("instagram", r"https?://(?:www\.)?instagram\.com/(?!p/|explore)[^\s\"'<>)]+"),
    ("youtube", r"https?://(?:www\.)?youtube\.com/(?:channel/|c/|user/|@)[^\s\"'<>)]+"),
    ("linkedin", r"https?://(?:www\.)?linkedin\.com/(?:company|in)/[^\s\"'<>)]+"),
    ("x", r"https?://(?:www\.)?(?:twitter|x)\.com/(?!intent|share|home)[A-Za-z0-9_]{2,}"),
    ("tiktok", r"https?://(?:www\.)?tiktok\.com/@[^\s\"'<>)]+"),
    ("pinterest", r"https?://(?:www\.)?pinterest\.com/(?!pin/create)[^\s\"'<>)]+"),
    ("houzz", r"https?://(?:www\.)?houzz\.com/(?:pro|professionals|hznb)/[^\s\"'<>)]+"),
    ("yelp", r"https?://(?:www\.)?yelp\.com/biz/[^\s\"'<>)]+"),
    ("nextdoor", r"https?://(?:www\.)?nextdoor\.com/(?:pages|page)/[^\s\"'<>)]+"),
    ("bbb", r"https?://(?:www\.)?bbb\.org/[^\s\"'<>)]+"),
    ("angi", r"https?://(?:www\.)?(?:angi|angieslist)\.com/[^\s\"'<>)]+"),
    ("homeadvisor", r"https?://(?:www\.)?homeadvisor\.com/rated[^\s\"'<>)]+"),
    ("google_business", r"https?://(?:g\.page/[^\s\"'<>)]+|(?:www\.)?google\.com/maps/place/[^\s\"'<>)]+|maps\.app\.goo\.gl/[^\s\"'<>)]+|g\.co/kgs/[^\s\"'<>)]+)"),
]
YOUTUBE_EMBED = re.compile(r"youtube(?:-nocookie)?\.com/embed/|youtu\.be/")

ATS: list[tuple[str, str]] = [
    ("Indeed", r"indeed\.com/(cmp|job|viewjob)|indeedapply"),
    ("BambooHR", r"\.bamboohr\.com"),
    ("Workable", r"apply\.workable\.com"),
    ("Breezy HR", r"\.breezy\.hr"),
    ("JazzHR", r"applytojob\.com|jazzhr"),
    ("Greenhouse", r"boards\.greenhouse\.io|greenhouse\.io/embed"),
    ("Lever", r"jobs\.lever\.co"),
    ("Paylocity", r"recruiting\.paylocity\.com"),
    ("ADP", r"workforcenow\.adp\.com"),
    ("ZipRecruiter", r"ziprecruiter\.com"),
    ("Gusto", r"jobs\.gusto\.com"),
    ("Recruitee", r"recruitee\.com"),
]

_HREF = re.compile(r"<a\b[^>]*href=[\"']([^\"'#]+)[\"'][^>]*>(.*?)</a>", re.I | re.S)
_TAG = re.compile(r"<[^>]+>")
_CAREERS_HINT = re.compile(r"career|jobs?\b|join[- ]our[- ]team|employment|hiring|work[- ]with[- ]us|now hiring", re.I)
_FIN_HINT = re.compile(r"financ", re.I)
_COPY = re.compile(r"(?:©|&copy;|&#169;|copyright)\s*(?:[^<]{0,40}?)((?:19|20)\d\d)(?:\s*[-–]\s*((?:19|20)\d\d))?", re.I)
_GENERATOR = re.compile(r"<meta[^>]+name=[\"']generator[\"'][^>]+content=[\"']([^\"']+)", re.I)
_HIRING_TEXT = re.compile(r"now hiring|we(?:'|’)re hiring|we are hiring|join our team|open positions", re.I)
_IMG_ATTR = re.compile(r"<img\b[^>]*?(?:alt|title|src)=[\"']([^\"']+)[\"']", re.I)
_LDJSON = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.I | re.S)
_GTM_ID = re.compile(r"\b(GTM-[A-Z0-9]{5,9})\b")
_SITEMAP_LINE = re.compile(r"^\s*sitemap:\s*(\S+)", re.I | re.M)
_LASTMOD = re.compile(r"<lastmod>\s*(\d{4}-\d{2}-\d{2})", re.I)
# Ad-platform IDs as they appear inside a public GTM container script (gtm.js)
GTM_AD_PATTERNS: list[tuple[str, str]] = [
    ("Google Ads", r"\bAW-\d{8,12}\b|googleadservices|\\x22awct\\x22|\"vtp_conversionId\""),
    ("Meta Pixel", r"fbevents\.js|connect\.facebook\.net|fbq\("),
    ("Microsoft Ads (UET)", r"bat\.bing\.com"),
    ("TikTok Pixel", r"analytics\.tiktok\.com"),
    ("LinkedIn Insight", r"snap\.licdn\.com"),
    ("Nextdoor Pixel", r"nextdoor"),
    ("CallRail", r"callrail"),
]
SCHEMA_TYPES = {"organization", "localbusiness", "roofingcontractor", "homeandconstructionbusiness",
                "generalcontractor", "professionalservice", "corporation", "housepainter", "plumber"}


def _text(html: str) -> str:
    html = re.sub(r"<(script|style|noscript)\b.*?</\1>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", _TAG.sub(" ", html))


def fingerprint(html: str, headers: dict[str, str] | None = None) -> dict[str, list[str]]:
    """{category: [tech names]} from homepage HTML + response headers."""
    hdr = "\n".join(f"{k.lower()}: {v.lower()}" for k, v in (headers or {}).items())
    blob = html.lower() + "\n" + hdr
    out: dict[str, list[str]] = {}
    for name, cat, pats in SIGNATURES:
        if any(re.search(p, blob) for p in pats):
            out.setdefault(cat, []).append(name)
    # a WP page builder only counts on WordPress
    if "wp_builder" in out and "WordPress" not in out.get("cms", []):
        out.pop("wp_builder")
    return out


def financing_providers(html: str) -> list[str]:
    low = html.lower()
    return [name for name, pats in FINANCING if any(re.search(p, low) for p in pats)]


def brands_mentioned(html: str) -> list[str]:
    # visible text + image alt/title/src (certification badges are usually logos)
    low = (_text(html) + " " + " ".join(_IMG_ATTR.findall(html))).lower().replace("-", " ").replace("_", " ")
    return [name for name, pat in BRANDS if re.search(pat, low)]


def social_links(html: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for platform, pat in SOCIAL:
        m = re.search(pat, html, re.I)
        if m:
            out[platform] = m.group(0).rstrip("/.,;")
    if "youtube" not in out and YOUTUBE_EMBED.search(html):
        out["youtube_embed"] = "embedded video"
    return out


def links(html: str, base: str) -> list[tuple[str, str]]:
    out = []
    for href, label in _HREF.findall(html):
        href = href.strip()
        if href.startswith(("mailto:", "tel:", "javascript:")):
            continue
        out.append((urljoin(base, href), re.sub(r"\s+", " ", _TAG.sub(" ", label)).strip()))
    return out


def _same_site(url: str, base: str) -> bool:
    a = urlsplit(url).netloc.lower().removeprefix("www.")
    b = urlsplit(base).netloc.lower().removeprefix("www.")
    return a == b


def find_page(html: str, base: str, hint: re.Pattern[str]) -> str | None:
    for url, label in links(html, base):
        path = urlsplit(url).path
        if _same_site(url, base) and (hint.search(path) or hint.search(label)):
            return url
    return None


def careers_info(html: str, base: str) -> dict[str, Any]:
    low = html.lower()
    return {
        "page": find_page(html, base, _CAREERS_HINT),
        "hiring_text": bool(_HIRING_TEXT.search(_text(html))),
        "ats": [name for name, pat in ATS if re.search(pat, low)],
    }


def copyright_year(html: str) -> int | None:
    years = []
    for a, b in _COPY.findall(_text(html)[-6000:] + " " + html[-20000:]):
        for y in (a, b):
            if y and 1990 <= int(y) <= datetime.now(timezone.utc).year + 1:
                years.append(int(y))
    return max(years) if years else None


def visible_text_len(html: str) -> int:
    return len(_text(html).strip())


def _iter_nodes(obj: Any):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _iter_nodes(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_nodes(v)


def _types(node: dict[str, Any]) -> set[str]:
    t = node.get("@type")
    ts = t if isinstance(t, list) else [t]
    return {str(x).lower() for x in ts if x}


def _names(v: Any) -> list[str]:
    out = []
    for x in v if isinstance(v, list) else [v]:
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, dict) and x.get("name"):
            out.append(str(x["name"]))
    return out


def schema_org(html: str) -> dict[str, Any]:
    """Facts a contractor publishes about itself as schema.org JSON-LD (LocalBusiness etc.)."""
    out: dict[str, Any] = {}
    jobs = 0
    for block in _LDJSON.findall(html):
        try:
            doc = json.loads(block.strip())
        except ValueError:
            continue
        for node in _iter_nodes(doc):
            ts = _types(node)
            if "jobposting" in ts:
                jobs += 1
            if not ts & SCHEMA_TYPES:
                continue
            out.setdefault("types", sorted(ts & SCHEMA_TYPES))
            for key, field in (("founder", "founder"), ("employee", "employee")):
                names = _names(node.get(field))
                if names:
                    out.setdefault(key, names[:5])
            for key in ("foundingDate", "numberOfEmployees", "priceRange", "paymentAccepted", "legalName"):
                v = node.get(key)
                if isinstance(v, dict):
                    v = v.get("value") or v.get("minValue") or v.get("name")
                if v and key not in out:
                    out[key] = v if isinstance(v, (str, int, float)) else str(v)[:120]
            area = _names(node.get("areaServed"))
            if area and "areaServed" not in out:
                out["areaServed"] = area[:15]
            same = node.get("sameAs")
            if same and "sameAs" not in out:
                out["sameAs"] = (same if isinstance(same, list) else [same])[:15]
            agg = node.get("aggregateRating")
            if isinstance(agg, dict) and "aggregateRating" not in out:
                out["aggregateRating"] = {k: agg.get(k) for k in ("ratingValue", "reviewCount") if agg.get(k)}
    if jobs:
        out["job_postings"] = jobs
    return out


def gtm_ad_tags(js: str) -> list[str]:
    return [name for name, pat in GTM_AD_PATTERNS if re.search(pat, js, re.I)]


def sitemap_lastmod(xml: str) -> dict[str, Any]:
    dates = sorted(_LASTMOD.findall(xml))
    return {"entries": xml.lower().count("<loc>"), "lastmod_max": dates[-1] if dates else None}


def parse_cdx(rows: list[list[str]]) -> dict[str, Any]:
    """Wayback CDX JSON (fl=timestamp,statuscode, collapse=timestamp:6) -> summary."""
    data = [r for r in rows[1:] if r] if rows and rows[0] and rows[0][0] == "timestamp" else [r for r in rows if r]
    if not data:
        return {"first_capture": None, "last_capture": None, "months_captured": 0, "first_year": None}

    def iso(ts: str) -> str:
        return f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}"

    return {
        "first_capture": iso(data[0][0]),
        "last_capture": iso(data[-1][0]),
        "months_captured": len({r[0][:6] for r in data}),
        "first_year": int(data[0][0][:4]),
    }


def parse_rdap(d: dict[str, Any]) -> dict[str, Any]:
    ev = {e.get("eventAction"): e.get("eventDate") for e in d.get("events", [])}
    registrar = None
    for ent in d.get("entities", []):
        if "registrar" in (ent.get("roles") or []):
            for item in (ent.get("vcardArray") or [None, []])[1]:
                if item and item[0] == "fn":
                    registrar = item[3]
    return {
        "registered": (ev.get("registration") or "")[:10] or None,
        "expires": (ev.get("expiration") or "")[:10] or None,
        "registrar": registrar,
    }


def registrable_domain(url: str) -> str:
    host = urlsplit(url if "://" in url else "http://" + url).netloc.lower().split(":")[0]
    host = host.removeprefix("www.")
    parts = host.split(".")
    # good enough for .com/.net/.org/.us/.nyc/.biz; handles co.uk-style 2-level suffixes crudely
    if len(parts) > 2 and parts[-2] in {"co", "com", "net", "org"} and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def marketing_score(s: dict[str, Any]) -> int:
    """0..10 marketing-sophistication heuristic (for ranking, not a precise measure)."""
    tech = s.get("tech", {})
    score = 0
    score += 2 if s.get("ad_pixels") else 0
    score += 1 if len(s.get("ad_pixels", [])) >= 2 else 0
    score += 1 if tech.get("analytics") else 0
    score += 1 if s.get("call_tracking") else 0
    score += 1 if s.get("crm_marketing") or s.get("field_software") else 0
    score += 1 if s.get("chat") else 0
    score += 1 if s.get("financing", {}).get("offered") else 0
    score += 1 if s.get("instant_quote") or s.get("review_widgets") else 0
    score += 1 if len([k for k in s.get("social", {}) if k not in {"youtube_embed"}]) >= 3 else 0
    return min(score, 10)


def talking_points(s: dict[str, Any]) -> list[str]:
    tp: list[str] = []
    fin = s.get("financing", {})
    if fin.get("providers"):
        tp.append(f"Offers homeowner financing via {', '.join(fin['providers'])}.")
    elif fin.get("offered"):
        tp.append("Advertises homeowner financing (provider not named on site).")
    else:
        tp.append("No homeowner financing advertised on the website -- pitch distributor financing programmes.")
    if s.get("ad_pixels"):
        tp.append(f"Runs paid-ads tracking ({', '.join(s['ad_pixels'])}) -- actively buying leads.")
    if s.get("brands"):
        tp.append(f"Website features {', '.join(s['brands'][:5])}.")
    if s.get("instant_quote"):
        tp.append(f"Uses an online instant-quote tool ({', '.join(s['instant_quote'])}).")
    car = s.get("careers", {})
    if car.get("hiring_text") or car.get("ats") or s.get("schema_org", {}).get("job_postings"):
        tp.append("Website says they are hiring -- growth signal.")
    wb = s.get("wayback", {})
    dom = s.get("domain", {})
    since = [y for y in (wb.get("first_year"), int(dom["registered"][:4]) if dom.get("registered") else None) if y]
    if since:
        tp.append(f"Online since ~{min(since)}.")
    so = s.get("schema_org", {})
    if so.get("founder"):
        tp.append(f"Website names founder: {', '.join(so['founder'][:2])}.")
    if s.get("placeholder_site"):
        tp.append("Website is a placeholder/parked page -- little digital presence.")
    cy = s.get("copyright_year")
    if cy and cy < datetime.now(timezone.utc).year - 2:
        tp.append(f"Website looks stale (footer copyright {cy}).")
    return tp


class WebSignalsEnricher(Enricher):
    name = "web_signals"
    depends_on = ("website_discovery",)

    CDX = "https://web.archive.org/cdx/search/cdx"
    RDAP = {"com": "https://rdap.verisign.com/com/v1/domain/", "net": "https://rdap.verisign.com/net/v1/domain/"}
    RDAP_FALLBACK = "https://rdap.org/domain/"
    scan_gtm = True  # read the public GTM container to find ad tags loaded via Tag Manager
    scan_sitemap = True

    def applies_to(self, ctx: LeadContext) -> bool:
        return bool(ctx.best_website())

    async def _robots(self, http: HttpClient, base: str) -> RobotFileParser | None:
        try:
            r = await http.get(urljoin(base, "/robots.txt"), retries=1, allow_statuses=(401, 403, 404, 410), timeout=15)
        except HttpError:
            return None
        if r.status in (401, 403):
            rp = RobotFileParser()
            rp.disallow_all = True
            return rp
        if not r.ok or "<html" in r.text[:500].lower():
            return None
        rp = RobotFileParser()
        rp.parse(r.text.splitlines())
        return rp

    async def _sitemap(self, http: HttpClient, base: str, rp: RobotFileParser | None) -> dict[str, Any]:
        cands = []
        if rp is not None and getattr(rp, "site_maps", None):
            cands += list(rp.site_maps() or [])
        cands += [urljoin(base, p) for p in ("/sitemap_index.xml", "/sitemap.xml", "/wp-sitemap.xml")]
        for url in cands[:3]:
            try:
                r = await http.get(url, retries=0, allow_statuses=(403, 404, 410), timeout=20)
            except HttpError:
                continue
            if r.ok and "<loc>" in r.text.lower():
                return {**sitemap_lastmod(r.text), "url": url}
        return {}

    async def _wayback(self, http: HttpClient, domain: str) -> dict[str, Any]:
        params = {"url": domain, "output": "json", "fl": "timestamp,statuscode", "collapse": "timestamp:6"}
        try:
            r = await http.get(self.CDX, params=params, retries=2, timeout=40)
            return parse_cdx(r.json() if r.text.strip() else [])
        except (HttpError, ValueError) as e:
            return {"error": str(e)[:200]}

    async def _rdap(self, http: HttpClient, domain: str) -> dict[str, Any]:
        tld = domain.rsplit(".", 1)[-1]
        url = self.RDAP.get(tld, self.RDAP_FALLBACK) + domain
        try:
            r = await http.get(url, retries=1, allow_statuses=(404,), timeout=20,
                               headers={"Accept": "application/rdap+json"})
            if r.status == 404:
                return {"registered": None, "rdap_url": url}
            return {**parse_rdap(json.loads(r.text)), "rdap_url": url}
        except (HttpError, ValueError) as e:
            return {"error": str(e)[:200], "rdap_url": url}

    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        website = ctx.best_website()
        if not website:
            return self.skipped("no website known")
        if "://" not in website:
            website = "https://" + website
        http.set_host_interval("web.archive.org", 1.5)
        domain = registrable_domain(website)
        urls = [website]
        signals: dict[str, Any] = {"website": website}

        rp = await self._robots(http, website)
        allowed = rp is None or rp.can_fetch(UA_TOKEN, website) or rp.can_fetch("*", website)
        signals["robots_disallowed"] = not allowed
        html, headers, final = "", {}, website
        if allowed:
            try:
                r = await http.get(website, retries=1, allow_statuses=(401, 403, 404, 410, 451, 500, 503), timeout=25)
                signals["http_status"] = r.status
                final = r.url
                if r.ok:
                    html, headers = r.text, r.headers
            except HttpError as e:
                signals["http_status"] = None
                signals["fetch_error"] = str(e)[:200]
        signals["final_url"] = final

        if html:
            tech = fingerprint(html, headers)
            signals["tech"] = tech
            signals["ad_pixels"] = tech.get("ad_pixel", [])
            signals["advertises"] = bool(signals["ad_pixels"])
            signals["call_tracking"] = tech.get("call_tracking", [])
            signals["crm_marketing"] = tech.get("crm_marketing", [])
            signals["field_software"] = tech.get("field_software", [])
            signals["chat"] = tech.get("chat", [])
            signals["review_widgets"] = tech.get("review_widget", [])
            signals["instant_quote"] = tech.get("instant_quote", [])
            signals["brands"] = brands_mentioned(html)
            signals["social"] = social_links(html)
            signals["careers"] = careers_info(html, final)
            signals["copyright_year"] = copyright_year(html)
            signals["generator"] = [g[:60] for g in _GENERATOR.findall(html)][:4]
            signals["placeholder_site"] = visible_text_len(html) < 300
            signals["schema_org"] = schema_org(html)
            gtm = _GTM_ID.search(html)
            if gtm and self.scan_gtm:
                gurl = f"https://www.googletagmanager.com/gtm.js?id={gtm.group(1)}"
                try:
                    gr = await http.get(gurl, retries=1, allow_statuses=(404,), timeout=20)
                    if gr.ok:
                        hidden = [t for t in gtm_ad_tags(gr.text) if t not in signals["ad_pixels"]]
                        signals["gtm"] = {"id": gtm.group(1), "ad_tags": gtm_ad_tags(gr.text)}
                        signals["ad_pixels"] = signals["ad_pixels"] + [t for t in hidden if t != "CallRail"]
                        if "CallRail" in hidden and "CallRail" not in signals["call_tracking"]:
                            signals["call_tracking"] = signals["call_tracking"] + ["CallRail"]
                        signals["advertises"] = bool(signals["ad_pixels"])
                        urls.append(gurl)
                except HttpError:
                    pass
            providers = financing_providers(html)
            fin_page = find_page(html, final, _FIN_HINT)
            if fin_page and not providers and (rp is None or rp.can_fetch(UA_TOKEN, fin_page)):
                try:
                    fr = await http.get(fin_page, retries=1, allow_statuses=(404, 403, 410), timeout=20)
                    if fr.ok:
                        providers = financing_providers(fr.text)
                        urls.append(fin_page)
                except HttpError:
                    pass
            signals["financing"] = {
                "offered": bool(providers or fin_page or re.search(r"financing", _text(html), re.I)),
                "providers": providers,
                "page": fin_page,
            }

        if html and self.scan_sitemap:
            signals["sitemap"] = await self._sitemap(http, final, rp)
        signals["wayback"] = await self._wayback(http, domain)
        urls.append(f"{self.CDX}?url={domain}&output=json&fl=timestamp,statuscode&collapse=timestamp:6")
        signals["domain"] = await self._rdap(http, domain)
        if signals["domain"].get("rdap_url"):
            urls.append(signals["domain"]["rdap_url"])
        if html:
            signals["marketing_score"] = marketing_score(signals)
        signals["talking_points"] = talking_points(signals) if html else []

        if not html and not signals["wayback"].get("first_capture") and not signals["domain"].get("registered"):
            return self.no_match(data=signals, source_urls=urls)
        prior = ctx.ok_prior("website_discovery")
        conf = prior.confidence if prior is not None and prior.website else 0.8
        return self.ok(signals, conf, website=final if html else website, source_urls=urls)
