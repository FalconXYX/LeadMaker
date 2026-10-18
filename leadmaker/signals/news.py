"""Local news signals: county-level roofing-demand stories.

What counts: storms and roof/wind/hail damage, nor'easters, building permits, new
construction and housing activity -- talking points a rep can open with ("the
Sept. 26 nor'easter downed trees across Bergen County").

Source evaluation (2026-10-18, free + no key + use allowed):
  * GDELT DOC 2.0 API (api.gdeltproject.org/api/v2/doc/doc) -- full-text search
    over worldwide online news, last 3 months, "unlimited and unrestricted use for
    any academic, commercial, or governmental use ... without fee" (citation to
    gdeltproject.org required). Throttled hard: "one request every 5 seconds", and
    in practice a 429 cooldown of 20-60 s once tripped. Local recall is thin -- only
    42 articles mentioned "Bergen County" in 30 days, none from nj.com/northjersey.com
    -- and ArtList returns title/url/domain/seendate only (no snippet).
  * Publisher RSS feeds -- nj.com's per-county sections, silive.com (Staten Island),
    Schneps papers (Brooklyn/Queens/Bronx). These are the actual local outlets and
    are published for aggregation (nj.com lists its RSS in robots.txt); one request
    per feed per run, but each feed only holds the latest ~20-50 items (about a
    week), so the 30-day window fills up through daily runs.
  * Rejected: Google News RSS search (robots.txt disallows /rss/ for every agent),
    Bing News RSS (feed copyright limits it to "personal, non-commercial use"),
    NewsAPI/GNews/Currents/MediaStack (key required, dev-only or paid tiers), Patch
    (no working per-town RSS; /search/ disallowed).

So both keyless sources run: GDELT for county-phrase search across all outlets,
RSS for the county's own papers. Every candidate then passes one relevance filter
on headline + URL slug: a roofing-demand term, plus the county or one of its towns
(an RSS summary may name the place, never the topic). A county-section feed implies
the place; a GDELT hit only proves a mention somewhere in the body, so without the
place in the headline it needs a strong term (roof/hail/nor'easter/...), not just
"storm" or "flooding". Press-release
wires are dropped, syndicated copies collapse to one story, and each county keeps
its top MAX_PER_COUNTY stories (a regional nor'easter produced 85 Brooklyn hits).

Output: rows for the `regional_signals` table (kind='news'), one per (article,
county). Storage is the caller's job (leadmaker.pipeline.signals).
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Iterable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from ..config import Settings
from ..http import HttpClient, HttpError

log = logging.getLogger(__name__)

KIND = "news"
LOOKBACK_DAYS = 30
VALID_DAYS = 14
MAX_PER_COUNTY = 20

# --- GDELT -------------------------------------------------------------------
GDELT_SOURCE = "gdelt"
GDELT_HOST = "api.gdeltproject.org"
GDELT_URL = f"https://{GDELT_HOST}/api/v2/doc/doc"
GDELT_INTERVAL_S = 6.0  # published limit: one request every 5 seconds
# Waits after a 429. GDELT keeps refusing for a while once tripped; plain
# exponential backoff from HttpClient (1-8 s) just extends the penalty.
GDELT_COOLDOWN_S = (20.0, 40.0, 60.0, 60.0)
GDELT_MAX_RECORDS = 250
# Query-side topic terms, deliberately broad (storm/construction/housing): ArtList has
# no snippet, so the local relevance filter on headline + URL does the narrowing.
# GDELT tokenises punctuation, so nor'easter -> "nor easter". Order = priority when
# the query has to be shortened.
GDELT_TERMS = (
    "roof", "roofing", "roofer", "hail", "storm", "tornado", '"nor easter"', "flooding", '"wind damage"',
    '"building permits"', "construction", "housing",
)
# GDELT answers "Your query was too short or too long." past roughly 250 characters
# (a 330-character query failed live; ~200 works).
GDELT_MAX_QUERY_CHARS = 220

# --- publisher RSS -----------------------------------------------------------
RSS_SOURCE = "local_rss"
RSS_INTERVAL_S = 1.0
NJCOM_FEED = "https://www.nj.com/arc/outboundfeeds/rss/category/{}/?outputType=xml"
# County FIPS -> county-section feeds (every item is about that county).
COUNTY_FEEDS: dict[str, tuple[str, ...]] = {
    "34003": (NJCOM_FEED.format("bergen"),),
    "34013": (NJCOM_FEED.format("essex"),),
    "34017": (NJCOM_FEED.format("hudson"),),
    "34023": (NJCOM_FEED.format("middlesex"),),
    "34025": (NJCOM_FEED.format("monmouth"),),
    "34027": (NJCOM_FEED.format("morris"),),
    "34029": (NJCOM_FEED.format("ocean"),),
    "34031": (NJCOM_FEED.format("passaic-county"),),
    "34035": (NJCOM_FEED.format("somerset"),),
    "34039": (NJCOM_FEED.format("union"),),
    "36005": ("https://www.bxtimes.com/feed/",),
    "36047": ("https://www.brooklynpaper.com/feed/",),
    "36081": ("https://qns.com/feed/",),
    "36085": ("https://www.silive.com/arc/outboundfeeds/rss/?outputType=xml",),
}
# State-wide feeds: an item counts for a county only if it names the county or a town.
STATE_FEEDS: dict[str, tuple[str, ...]] = {
    "NJ": (NJCOM_FEED.format("weather"),),
}

# NYC boroughs are written by borough name, not county name.
COUNTY_ALIASES: dict[str, tuple[str, ...]] = {
    "36005": ("Bronx",),
    "36047": ("Brooklyn",),
    "36061": ("Manhattan",),
    "36081": ("Queens",),
    "36085": ("Staten Island",),
}
STATE_NAMES = {"NJ": "New Jersey", "NY": "New York", "CT": "Connecticut", "PA": "Pennsylvania"}

# --- relevance ---------------------------------------------------------------
# Strong terms are roofing demand on their own. Weather terms need the story to be
# about the county (place named, or implied by the feed/query); market terms are
# vaguer still ("construction zone crash") and need the place named in the text.
STRONG_TERMS: dict[str, str] = {
    r"roofs?": "roof", r"roofing": "roofing", r"roofers?": "roofer",
    r"hail(?:storms?)?": "hail", r"storm[- ]damage[d]?": "storm damage", r"wind[- ]damage[d]?": "wind damage",
    r"damaging winds?": "damaging winds", r"nor['’]?[- ]?easters?": "nor'easter", r"tornado(?:es)?": "tornado",
    r"downed trees?|trees? down": "downed trees", r"building permits?": "building permits",
    r"new construction": "new construction", r"housing starts?": "housing starts",
    r"severe (?:thunder)?storms?": "severe storm", r"hurricanes?": "hurricane", r"tropical storms?": "tropical storm",
    r"microburst": "microburst",
}
WEATHER_TERMS: dict[str, str] = {
    r"storms?": "storm", r"flood(?:ing|ed|s)?": "flooding", r"high winds?": "high winds",
    r"(?:power )?outages?": "power outage",
}
MARKET_TERMS: dict[str, str] = {
    # Not crash/injury stories ("kills construction worker", "construction zone crash").
    r"construction(?![- ](?:zones?|workers?|crews?))": "construction", r"redevelopment": "redevelopment",
    r"housing": "housing", r"permits?": "permits", r"development": "development",
}
# Headlines that match a term but are never demand signals. Sports write-ups "storm
# back" (St. John's Red Storm play in Queens); listings show off a "motorized roof".
# Ball sports skip "baseball-sized hail", the headline we most want to keep.
NOISE_RE = re.compile(
    r"\b(obituar(?:y|ies)|hiring|job openings?|(?:foot|basket|base|soft|volley)ball(?![- ]?siz)|soccer|hockey|"
    r"lacrosse|wrestling|red storm|players? of the week|stats leaders|home of the week|horoscope|recipes?|movies?)\b"
    r"|\| ?jobs\b",
    re.I,
)
# Press-release wires and their mirrors: company marketing (often competitors' "now
# serving Bergen County" releases), not demand. Live miss: a PSE&G reliability release.
PR_DOMAINS = frozenset({
    "prnewswire.com", "businesswire.com", "globenewswire.com", "einpresswire.com", "accessnewswire.com",
    "newswire.com", "openpr.com", "pr-inside.com", "prweb.com", "finanznachrichten.de", "marketscreener.com",
})
# Newspapers that host wire releases under a path segment
# (manilatimes.net/2026/10/01/tmt-newswire/globenewswire/<public adjuster release>/).
PR_PATH_RE = re.compile(r"/[\w-]*newswire[\w-]*/", re.I)
TRACKING_PARAMS = re.compile(r"^(utm_|fbclid$|gclid$|mc_|cmp$|ref$|ref_src$|ito$|taid$|smid$|sr_share$)", re.I)


def _compile(terms: dict[str, str]) -> list[tuple[re.Pattern[str], str]]:
    return [(re.compile(rf"\b(?:{pat})\b", re.I), label) for pat, label in terms.items()]


_STRONG = _compile(STRONG_TERMS)
_WEATHER = _compile(WEATHER_TERMS)
_MARKET = _compile(MARKET_TERMS)


# ----------------------------------------------------------------------- helpers
def canonical_url(url: str) -> str:
    """Article URL without fragment/tracking params, lower-case host, no trailing '?'."""
    p = urlsplit(url.strip())
    query = urlencode([(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not TRACKING_PARAMS.match(k)])
    path = p.path or "/"
    return urlunsplit((p.scheme.lower() or "https", p.netloc.lower(), path, query, ""))


def _url_key(url: str) -> str:
    """Dedupe key: same article over http/https, with/without www, trailing slash."""
    p = urlsplit(url)
    host = p.netloc.lower().removeprefix("www.")
    return f"{host}{p.path.rstrip('/')}?{p.query}"


def _title_key(title: str, published: datetime) -> str:
    """Syndicated copies share a headline and a day; recurring headlines on other days don't merge.

    Site suffixes are dropped first: iHeart runs one story on ~30 station sites as
    "Cleanup Continues From Powerful Noreaster | NewsRadio 1000 KTOK".
    """
    core = re.split(r"\s+[|–—]\s+", title, maxsplit=1)[0]
    return f"{published:%Y-%m-%d} " + re.sub(r"[^a-z0-9]+", " ", core.lower()).strip()


def _slug_words(url: str) -> str:
    """URL path as words (`/2026/10/roof-blown-off-in-clifton.html` -> 'roof blown off in clifton')."""
    path = urlsplit(url).path
    return re.sub(r"[-_/.]+", " ", re.sub(r"\.(html?|php|aspx?)$", "", path))


def _clean_text(s: str | None, limit: int | None = None) -> str:
    text = re.sub(r"<[^>]+>", " ", html.unescape(s or ""))
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    if limit and len(text) > limit:
        text = text[: limit - 1].rsplit(" ", 1)[0] + "…"
    return text


def _outlet(url: str) -> str:
    return urlsplit(url).netloc.lower().removeprefix("www.")


def is_press_release(url: str, domain: str | None = None) -> bool:
    host = (domain or _outlet(url)).lower()
    return any(host == d or host.endswith("." + d) for d in PR_DOMAINS) or bool(PR_PATH_RE.search(urlsplit(url).path))


def parse_gdelt_date(v: str | None) -> datetime | None:
    """GDELT seendate '20261001T104500Z' -> aware UTC datetime."""
    if not v:
        return None
    try:
        return datetime.strptime(v, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_rss_date(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        dt = parsedate_to_datetime(v.strip())
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def place_names(county: dict[str, Any]) -> list[str]:
    """Names that place a story in this county: 'Bergen County', borough aliases, towns."""
    fips = county.get("county_fips") or ""
    name = (county.get("county_name") or "").strip()
    out: list[str] = []
    if name:
        out.append(name if name.lower().endswith(("county", "parish", "borough")) else f"{name} County")
    out.extend(COUNTY_ALIASES.get(fips, ()))
    out.extend(t.strip() for t in county.get("towns") or () if t and t.strip())
    unique: dict[str, str] = {}
    for n in out:
        unique.setdefault(n.lower(), n)
    return list(unique.values())


def _place_re(names: Iterable[str]) -> re.Pattern[str] | None:
    alts = [re.escape(n).replace(r"\ ", r"[\s-]+") for n in names if n]
    return re.compile(rf"\b(?:{'|'.join(alts)})\b", re.I) if alts else None


def match_terms(text: str) -> tuple[list[str], list[str], list[str]]:
    """(strong, weather, market) labels found in `text`."""
    strong = {label for rx, label in _STRONG if rx.search(text)}
    # Drop labels a strong label already covers ("storm" inside "severe storm").
    weather = {label for rx, label in _WEATHER if rx.search(text) and not any(label in s for s in strong)}
    market = {label for rx, label in _MARKET if rx.search(text) and not any(label in s for s in strong)}
    return sorted(strong), sorted(weather), sorted(market)


def relevance(
    text: str,
    place_rx: re.Pattern[str] | None,
    *,
    place_implied: bool,
    implied_needs_strong: bool = False,
    context: str = "",
) -> list[str] | None:
    """Matched terms if `text` is a local roofing-demand story, else None.

    place_implied: the story is known to be about the county (county-section feed,
    or a GDELT county-phrase hit) even if the headline doesn't name it.
    implied_needs_strong: the implied place is only a mention somewhere in the body
    (GDELT), so without the place in the text a weather word alone is not enough --
    national pieces mention Brooklyn in passing ("Eastern Spain braces for flooding").
    context: extra text (RSS summary) that may name the place but never supplies the
    topic -- live summaries mention roofs and construction in passing ("fire showing
    through the roof", "hit in a marked construction zone in Middlesex County").
    """
    if NOISE_RE.search(text):
        return None
    strong, weather, market = match_terms(text)
    place = (place_rx.search(text) or place_rx.search(context)) if place_rx is not None else None
    if place:
        ok = bool(strong or weather or market)
    elif place_implied:
        ok = bool(strong or (weather and not implied_needs_strong))
    else:
        ok = False
    if not ok:
        return None
    terms = strong + weather + (market if place else [])
    if place:
        terms.append(place.group(0))
    return terms


# ------------------------------------------------------------------- candidates
@dataclass
class Candidate:
    """One article as seen by one source for one county, before merging."""

    county_fips: str
    source: str
    url: str
    title: str
    published_at: datetime
    query: str
    matched_terms: list[str]
    place_in_title: bool
    summary: str | None = None
    outlet: str | None = None


@dataclass
class _Article:
    rep: Candidate
    by_county: dict[str, Candidate] = field(default_factory=dict)


# ------------------------------------------------------------------------ GDELT
def gdelt_query(county: dict[str, Any]) -> str:
    """`"Bergen County" "New Jersey" (roof OR ...) sourcelang:english`, at most ~220 chars.

    GDELT matches full text, so the county phrase anywhere in the article counts;
    the state phrase separates Essex/Union/Middlesex NJ from their namesakes. NYC
    boroughs add their borough name (`("Richmond County" OR "Staten Island") "New
    York"`) and keep the state phrase too: without it, half of the live Staten Island
    hits (36 of 72) were Richmond County GA/Canada/Louisiana pieces, one of which
    passed the filter. Towns are left out on purpose: names like Union, Orange or
    Clifton match stories from every state.
    """
    geo = place_names({**county, "towns": ()})
    geo_clause = " OR ".join(f'"{n}"' if " " in n else n for n in geo)
    if len(geo) > 1:
        geo_clause = f"({geo_clause})"
    state = STATE_NAMES.get((county.get("state") or "").upper())
    state_clause = f' "{state}"' if state else ""
    terms = list(GDELT_TERMS)
    while True:
        # English-language, any country: wire copies abroad (AAP, Times of India) were
        # the only outlets carrying some of the Bergen nor'easter coverage.
        query = f"{geo_clause}{state_clause} ({' OR '.join(terms)}) sourcelang:english"
        if len(query) <= GDELT_MAX_QUERY_CHARS or len(terms) <= 3:
            return query
        terms.pop()


async def _gdelt_get(http: HttpClient, params: dict[str, str]) -> str:
    for wait in (*GDELT_COOLDOWN_S, None):
        resp = await http.get(GDELT_URL, params=params, allow_statuses=(429,), headers={"Accept": "application/json"})
        if resp.status != 429:
            return resp.text
        if wait is None:
            break
        log.info("news: GDELT rate limit hit, cooling down %.0fs", wait)
        await asyncio.sleep(wait)
    raise HttpError("GDELT kept returning 429", status=429, url=GDELT_URL)


def parse_gdelt(text: str) -> list[dict[str, Any]]:
    """ArtList JSON -> article dicts. Errors come back as plain text with HTTP 200."""
    body = text.strip()
    if not body.startswith("{"):
        raise ValueError(f"GDELT error: {body[:200]}")
    data = json.loads(body, strict=False)  # titles occasionally carry raw control characters
    return data.get("articles") or []


def gdelt_candidates(county: dict[str, Any], articles: list[dict[str, Any]], query: str) -> list[Candidate]:
    place_rx = _place_re(place_names(county))
    out: list[Candidate] = []
    for a in articles:
        url, title = a.get("url"), _clean_text(a.get("title"))
        published = parse_gdelt_date(a.get("seendate"))
        if not url or not title or published is None or is_press_release(url, a.get("domain")):
            continue
        # GDELT pads punctuation with spaces ("Nor - easter", "U . S ."); undo the common cases.
        title = re.sub(r"\s+([,.:;!?'’])", r"\1", re.sub(r"\s+-\s+", "-", title))
        text = f"{title} {_slug_words(url)}"
        terms = relevance(text, place_rx, place_implied=True, implied_needs_strong=True)
        if terms is None:
            continue
        out.append(Candidate(
            county_fips=county["county_fips"], source=GDELT_SOURCE, url=canonical_url(url), title=title,
            published_at=published, query=query, matched_terms=terms,
            place_in_title=bool(place_rx and place_rx.search(title)), outlet=a.get("domain") or _outlet(url),
        ))
    return out


async def fetch_gdelt(http: HttpClient, county: dict[str, Any], lookback_days: int = LOOKBACK_DAYS) -> list[Candidate]:
    query = gdelt_query(county)
    params = {"query": query, "mode": "ArtList", "format": "json", "maxrecords": str(GDELT_MAX_RECORDS),
              "timespan": f"{lookback_days}d", "sort": "DateDesc"}
    articles = parse_gdelt(await _gdelt_get(http, params))
    found = gdelt_candidates(county, articles, query)
    log.info("news: GDELT %s -> %d articles, %d relevant", county.get("county_name"), len(articles), len(found))
    return found


# -------------------------------------------------------------------------- RSS
def parse_rss(text: str) -> list[dict[str, Any]]:
    """RSS 2.0 / Atom -> [{title, url, published, summary}]."""
    root = ET.fromstring(text.strip().encode())
    items: list[dict[str, Any]] = []
    for it in root.iter():
        tag = it.tag.rsplit("}", 1)[-1]
        if tag not in ("item", "entry"):
            continue
        fields: dict[str, Any] = {}
        for child in it:
            ctag = child.tag.rsplit("}", 1)[-1]
            if ctag == "link":
                fields.setdefault("url", (child.text or "").strip() or child.get("href"))
            elif ctag in ("title", "description", "summary", "pubDate", "published", "updated", "guid"):
                fields.setdefault(ctag, child.text or "")
        url = fields.get("url") or (fields.get("guid") if (fields.get("guid") or "").startswith("http") else None)
        items.append({
            "title": _clean_text(fields.get("title")),
            "url": url,
            "published": parse_rss_date(fields.get("pubDate") or fields.get("published") or fields.get("updated")),
            "summary": _clean_text(fields.get("description") or fields.get("summary"), limit=300) or None,
        })
    return items


def rss_candidates(
    county: dict[str, Any], items: list[dict[str, Any]], feed_url: str, *, county_feed: bool
) -> list[Candidate]:
    place_rx = _place_re(place_names(county))
    out: list[Candidate] = []
    for it in items:
        if not it.get("url") or not it.get("title") or it.get("published") is None or is_press_release(it["url"]):
            continue
        text = f"{it['title']} {_slug_words(it['url'])}"
        terms = relevance(text, place_rx, place_implied=county_feed, context=it.get("summary") or "")
        if terms is None:
            continue
        out.append(Candidate(
            county_fips=county["county_fips"], source=RSS_SOURCE, url=canonical_url(it["url"]), title=it["title"],
            published_at=it["published"], query=feed_url, matched_terms=terms,
            place_in_title=bool(place_rx and place_rx.search(it["title"])), summary=it.get("summary"),
            outlet=_outlet(it["url"]),
        ))
    return out


def feeds_for(counties: list[dict[str, Any]]) -> dict[str, list[tuple[dict[str, Any], bool]]]:
    """feed URL -> [(county, is_county_section_feed)], each feed fetched once per run."""
    plan: dict[str, list[tuple[dict[str, Any], bool]]] = {}
    for c in counties:
        for f in COUNTY_FEEDS.get(c["county_fips"], ()):
            plan.setdefault(f, []).append((c, True))
        for f in STATE_FEEDS.get((c.get("state") or "").upper(), ()):
            plan.setdefault(f, []).append((c, False))
    return plan


async def fetch_rss(http: HttpClient, settings: Settings, counties: list[dict[str, Any]]) -> list[Candidate]:
    out: list[Candidate] = []
    for feed_url, targets in feeds_for(counties).items():
        http.set_host_interval(urlsplit(feed_url).netloc.lower(), max(RSS_INTERVAL_S, settings.per_host_interval_s))
        try:
            resp = await http.get(feed_url, headers={"Accept": "application/rss+xml, application/xml;q=0.9"})
            items = parse_rss(resp.text)
        except (HttpError, ET.ParseError, ValueError) as e:  # ValueError: undecodable text
            log.warning("news: feed %s failed: %s", feed_url, e)
            continue
        for county, county_feed in targets:
            out.extend(rss_candidates(county, items, feed_url, county_feed=county_feed))
    return out


# ---------------------------------------------------------------------- merging
def _better(a: Candidate, b: Candidate) -> Candidate:
    """Representative copy of a story: RSS (has summary, exact date) > named place > earliest."""
    def rank(c: Candidate) -> tuple:
        return (c.source == RSS_SOURCE, c.summary is not None, c.place_in_title, -c.published_at.timestamp())

    return a if rank(a) >= rank(b) else b


def merge(candidates: list[Candidate], since: datetime) -> list[_Article]:
    """Dedupe by canonical URL and by headline (syndicated wire copies), across counties.

    A story that names a county/town in its headline is kept only for those
    counties; a regional story ("nor'easter batters North Jersey") stays with every
    county whose query/feed surfaced it.
    """
    by_key: dict[str, _Article] = {}
    alias: dict[str, str] = {}
    for c in candidates:
        if c.published_at < since:
            continue
        keys = (_url_key(c.url), "t:" + _title_key(c.title, c.published_at))
        primary = next((alias[k] for k in keys if k in alias), keys[0])
        art = by_key.get(primary)
        if art is None:
            art = by_key[primary] = _Article(rep=c)
        else:
            art.rep = _better(art.rep, c)
        prev = art.by_county.get(c.county_fips)
        if prev is None:
            art.by_county[c.county_fips] = c
        else:
            best = _better(prev, c)
            best.matched_terms = sorted(set(prev.matched_terms) | set(c.matched_terms))
            art.by_county[c.county_fips] = best
        for k in keys:
            alias.setdefault(k, primary)
    out = list(by_key.values())
    for art in out:
        named = {f: c for f, c in art.by_county.items() if c.place_in_title}
        if named:
            art.by_county = named
    return out


def _keep_top(articles: list[_Article], per_county: int) -> list[tuple[_Article, str, Candidate]]:
    """At most `per_county` stories per county: place in headline, then strong terms, then newest.

    A big regional storm otherwise floods a borough with dozens of national write-ups.
    """
    by_county: dict[str, list[tuple[_Article, str, Candidate]]] = {}
    for art in articles:
        for fips, c in art.by_county.items():
            by_county.setdefault(fips, []).append((art, fips, c))

    def rank(item: tuple[_Article, str, Candidate]) -> tuple:
        _, _, c = item
        strong = sum(1 for t in c.matched_terms if t in STRONG_TERMS.values())
        return (c.place_in_title, strong, c.published_at)

    return [x for items in by_county.values() for x in sorted(items, key=rank, reverse=True)[:per_county]]


def to_rows(
    articles: list[_Article], fetched_at: datetime, per_county: int = MAX_PER_COUNTY
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for art, fips, c in _keep_top(articles, per_county):
        rep = art.rep
        payload: dict[str, Any] = {
            "title": rep.title,
            "url": rep.url,
            "outlet": rep.outlet,
            "published_at": rep.published_at.isoformat(),
            "query": c.query,
            "matched_terms": c.matched_terms,
        }
        if rep.summary:
            payload["summary"] = rep.summary
        if len(art.by_county) > 1:
            payload["counties"] = sorted(art.by_county)
        if rep.source == GDELT_SOURCE:
            payload["attribution"] = "GDELT Project (https://www.gdeltproject.org/)"
        rows.append({
            "county_fips": fips,
            "kind": KIND,
            "source": rep.source,
            "external_id": rep.url[:512],
            "payload": payload,
            "valid_from": rep.published_at,
            "valid_to": rep.published_at + timedelta(days=VALID_DAYS),
            "fetched_at": fetched_at,
        })
    rows.sort(key=lambda r: (r["county_fips"], r["valid_from"]))
    return rows


# -------------------------------------------------------------------- entry point
async def fetch_county_news(
    http: HttpClient,
    settings: Settings,
    counties: list[dict[str, Any]],
    *,
    sources: tuple[str, ...] = (GDELT_SOURCE, RSS_SOURCE),
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Roofing-demand news from the last 30 days as `regional_signals` rows (kind='news').

    counties: [{"county_fips", "county_name", "state"}], optionally "towns": [..]
    (lead cities in the county) to widen the place match. A failing county or feed
    is logged and skipped; the rest of the run still returns rows.
    """
    now = now or datetime.now(timezone.utc)
    counties = [c for c in counties if c.get("county_fips")]
    candidates: list[Candidate] = []
    if GDELT_SOURCE in sources:
        http.set_host_interval(GDELT_HOST, max(GDELT_INTERVAL_S, settings.per_host_interval_s))
        for county in counties:
            if not county.get("county_name") and county["county_fips"] not in COUNTY_ALIASES:
                # A state-only query would pin every state-wide story on this county.
                log.warning("news: no county name for %s, skipping GDELT", county["county_fips"])
                continue
            try:
                found = await fetch_gdelt(http, county)
            except (HttpError, ValueError) as e:
                log.warning("news: GDELT failed for %s (%s): %s", county.get("county_name"), county["county_fips"], e)
                continue
            candidates.extend(found)
    if RSS_SOURCE in sources:
        candidates.extend(await fetch_rss(http, settings, counties))
    articles = merge(candidates, since=now - timedelta(days=LOOKBACK_DAYS))
    return to_rows(articles, fetched_at=now)
