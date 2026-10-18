"""Better Business Bureau (bbb.org) public business profiles -> named principals, rating, licences.

A BBB profile lists the people the business itself registered as management
("Business Management": owner / president / VP with titles), plus business start date,
entity type, state licence numbers (e.g. NJ HIC 13VH...), website, categories, BBB rating,
accreditation and complaint counts. Measured on a 34-contractor NY/NJ sample
(research/reviews_directories): 12 matched, all phone-verified, 9 with named people,
0 false positives.

PROTOTYPE ONLY. BBB's Terms of Use allow "personal, non-commercial use" of BBB content;
this enricher reads public profile pages under that clause for the case-study prototype.
A production (commercial) deployment must use the official BBB API (IABBB,
developer.bbb.org: Organization records with ContactFirstName/LastName/Title,
BusinessURLs, Phones, PrimaryCategory, AltOrganizationNames, rating/accreditation
dates) instead of HTML pages.

How it finds profiles -- no BBB search pages (robots disallows every `/*?` URL):
  1. robots.txt is fetched every run; its group for `*` is matched with Google-style
     wildcards (urllib.robotparser treats `*` literally) and every bbb.org URL is checked
     before fetching. Only `/us/<st>/<city>/profile/<category>/<slug>-<id>` pages are read.
  2. The robots-advertised `sitemap-business-profiles-index.xml` lists ~580 files of
     10k profile URLs each, ordered by local-bureau code (0121 = BBB Metro New York,
     0221 = BBB Serving New Jersey). The files holding a bureau are located by binary
     search on each file's first <loc> (2 KB Range requests), then downloaded once and
     cached per bureau under data/cache/bbb/ (TTL 7 days; ~250k NY/NJ profile URLs).
  3. Candidates = profile slugs sharing a distinctive name token with the contractor,
     same state, ranked by name similarity + same city + trade category. At most
     MAX_FETCHES profiles per contractor are fetched (>= 1.5 s between bbb.org requests),
     parsed from `window.__PRELOADED_STATE__` + JSON-LD, and verified.
  4. Accepted only with confidence >= 0.9 *and* phone or address agreement; a ZIP / distance
     agreement without a phone also needs the strict name (trade words kept) to agree.

Not used: the profile's e-mail address is deliberately obfuscated by BBB and is not decoded.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlsplit

from ..http import HttpClient, HttpError
from ..models import Contact, EnrichmentResult
from ._registry_match import norm_city, strict_similarity
from .base import Enricher, LeadContext
from .matching import haversine_miles, match_confidence, name_similarity, normalize_name, phone_digits, zip5
from .website_crawl import SERVICE_RES

log = logging.getLogger(__name__)

HOST = "www.bbb.org"
BASE = f"https://{HOST}"
ROBOTS_URL = f"{BASE}/robots.txt"
PROFILES_INDEX = f"{BASE}/sitemap-business-profiles-index.xml"
HOST_INTERVAL_S = 1.5
# Local bureaus whose files are indexed for contractors in each state. Others are skipped
# (applies_to) until their bureau code is added here.
STATE_BUREAUS: dict[str, tuple[str, ...]] = {"NY": ("0121",), "NJ": ("0221",)}
INDEX_TTL_HOURS = float(os.environ.get("LEADMAKER_BBB_INDEX_TTL_HOURS") or 24 * 7)
CACHE_SUBDIR = "bbb"

ACCEPT = 0.9
STRICT_NAME = 0.9  # without phone or same street, names must agree on trade words too
ADDRESS_MILES = 1.0  # "address agreement" = same ZIP, same street address, or within a mile
FETCH_MIN_SIM = 0.7
MAX_FETCHES = 3
COMMON_TOKEN = 4000  # slug tokens in more profiles than this don't narrow anything

SITEMAP_RE = re.compile(r"<loc>\s*(https://www\.bbb\.org/sitemap-business-profiles-(\d+)\.xml)\s*</loc>")
ANY_LOC_RE = re.compile(r"<loc>[^<]*?-(\d{4})-\d+</loc>")
PROFILE_LOC_RE = re.compile(
    r"<loc>https://www\.bbb\.org/us/([a-z]{2})/([^/<]+)/profile/([^/<]+)/([^/<]+?)-((\d{4})-\d+)</loc>")
PROFILE_PATH_RE = re.compile(r"^/us/[a-z]{2}/[^/?#]+/profile/[^/?#]+/[^/?#]+-\d{4}-\d+$")
# BBB category slugs a roofing / exterior contractor plausibly sits under.
TRADE_CATEGORY = re.compile(
    r"roof|siding|gutter|home-improvement|general-contractor|construction|contractor|remodel|window|chimney|"
    r"carpent|masonry|handyman|builder|restoration|waterproof|exterior|skylight|insulation|solar|renovat|"
    r"deck|door|stucco|brick|concrete|basement")  # not "repair"/"paint": they admit auto-body shops
PERSON_BAD = re.compile(r"customer service|office|manager on duty|department|reception|billing|support|^none$", re.I)


def default_cache_dir() -> Path:
    env = os.environ.get("LEADMAKER_CACHE_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "data" / "cache"


# -- robots.txt ------------------------------------------------------------------------
class Robots:
    """robots.txt rules for one user-agent group, with `*` / `$` wildcards, longest match wins."""

    def __init__(self, text: str, agent: str = "*"):
        self.rules: list[tuple[int, bool, re.Pattern[str]]] = []
        self.sitemaps: list[str] = []
        groups: list[tuple[set[str], list[tuple[bool, str]]]] = []
        agents: set[str] = set()
        rules: list[tuple[bool, str]] = []
        in_rules = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            key, sep, val = line.partition(":")
            if not sep:
                continue
            key, val = key.strip().lower(), val.strip()
            if key == "sitemap":
                self.sitemaps.append(val)
            elif key == "user-agent":
                if in_rules:  # a user-agent line after rules starts a new group
                    groups.append((agents, rules))
                    agents, rules, in_rules = set(), [], False
                agents.add(val.lower())
            elif key in ("allow", "disallow"):
                in_rules = True
                if val:  # an empty Disallow means "allow everything"
                    rules.append((key == "allow", val))
        groups.append((agents, rules))
        mine = [r for a, r in groups if agent.lower() in a] or [r for a, r in groups if "*" in a]
        for allow, pat in (x for r in mine for x in r):
            rx = "".join(".*" if ch == "*" else re.escape(ch) for ch in pat.rstrip("$"))
            self.rules.append((len(pat), allow, re.compile(rx + ("$" if pat.endswith("$") else ""))))

    def allowed(self, path: str) -> bool:
        best: tuple[int, bool] | None = None
        for length, allow, rx in self.rules:
            if rx.match(path) and (best is None or length > best[0] or (length == best[0] and allow)):
                best = (length, allow)
        return True if best is None else best[1]


# -- sitemap profile index -------------------------------------------------------------
class ProfileRef(NamedTuple):
    """One profile URL from the sitemaps: /us/<state>/<city>/profile/<category>/<slug>-<bbb_id>."""

    state: str
    city: str
    category: str
    slug: str
    bbb_id: str

    @property
    def url(self) -> str:
        return f"{BASE}/us/{self.state}/{self.city}/profile/{self.category}/{self.slug}-{self.bbb_id}"

    @property
    def name(self) -> str:
        return " ".join(self.slug.split("-"))

    @property
    def bureau(self) -> str:
        return self.bbb_id[:4]


def parse_sitemap_index(xml: str) -> list[str]:
    """Child sitemap URLs of the business-profiles index, in file-number order."""
    found = {int(n): url for url, n in SITEMAP_RE.findall(xml)}
    return [found[n] for n in sorted(found)]


def parse_profile_sitemap(xml: str, bureaus: set[str] | None = None) -> list[ProfileRef]:
    return [ProfileRef(st, city, cat, slug, bid) for st, city, cat, slug, bid, bureau in PROFILE_LOC_RE.findall(xml)
            if bureaus is None or bureau in bureaus]


def slugify(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


class ProfileIndex:
    """In-memory token index over sitemap profile slugs."""

    def __init__(self, rows: list[ProfileRef]):
        self.rows = rows
        self.by_token: dict[str, list[int]] = defaultdict(list)
        for i, r in enumerate(rows):
            for t in set(normalize_name(r.name).split()):
                self.by_token[t].append(i)

    def candidates(self, names: list[str], state: str) -> list[ProfileRef]:
        """Same-state rows sharing a distinctive name token (common tokens only as a fallback)."""
        toks = {t for n in names for t in normalize_name(n).split()}
        rare = [t for t in toks if len(self.by_token.get(t, ())) <= COMMON_TOKEN]
        idx: set[int] = set()
        for t in rare or toks:
            idx.update(self.by_token.get(t, ()))
        st = state.lower()
        return [self.rows[i] for i in sorted(idx) if self.rows[i].state == st]


def rank_candidates(ctx: LeadContext, refs: list[ProfileRef]) -> list[tuple[float, float, ProfileRef]]:
    """(rank score, loose name similarity, ref), best first; drops unlikely slugs before any fetch."""
    names = ctx.names()
    cslug = slugify(ctx.get("city"))
    out = []
    for r in refs:
        loose = max(name_similarity(n, r.name) for n in names)
        if loose < FETCH_MIN_SIM:
            continue
        strict = max(strict_similarity(n, r.name) for n in names)
        trade = bool(TRADE_CATEGORY.search(r.category))
        if not trade and strict < 0.9:  # "Westgate Pharmacy" for "Westgate Roofing"
            continue
        same_city = bool(cslug) and r.city.strip("-") == cslug
        out.append(((loose + strict) / 2 + (0.1 if same_city else 0) + (0.05 if trade else 0), loose, r))
    out.sort(key=lambda x: -x[0])
    return out


# -- profile page ----------------------------------------------------------------------
def _date(v: str | None) -> str | None:
    return v[:10] if v else None


def _val(x: Any) -> Any:
    return x.get("value") if isinstance(x, dict) else x


def _person_name(n: dict[str, Any] | None) -> str | None:
    n = n or {}
    first, last = (n.get("first") or "").strip(), (n.get("last") or "").strip()
    if not first or not last:
        return None
    full = " ".join(x.strip() for x in (first, n.get("middle"), last, n.get("suffix")) if x and x.strip())
    if PERSON_BAD.search(full) or any(ch.isdigit() for ch in full):
        return None
    return full


def parse_profile(html: str) -> dict[str, Any] | None:
    """BBB profile page -> flat dict from `window.__PRELOADED_STATE__` (+ JSON-LD extras), or None."""
    i = html.find("window.__PRELOADED_STATE__")
    j = html.find("{", i) if i >= 0 else -1
    if j < 0:
        return None
    try:
        state, _ = json.JSONDecoder().raw_decode(html, j)
    except ValueError:
        return None
    bp = state.get("businessProfile") if isinstance(state, dict) else None
    if not isinstance(bp, dict) or not bp.get("businessId"):
        return None
    ci = bp.get("contactInformation") or {}
    loc = bp.get("location") or {}
    org = bp.get("orgDetails") or {}
    lic = org.get("license") or {}
    dates = bp.get("dates") or {}
    names = bp.get("names") or {}
    rc = bp.get("reviewsComplaintsSummary") or {}
    rating = bp.get("rating") or {}
    urls = bp.get("urls") or {}
    display = bp.get("display") or {}
    ld: dict[str, Any] = {}
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
        try:
            blocks = json.loads(m.group(1))
        except ValueError:
            continue
        for o in blocks if isinstance(blocks, list) else [blocks]:
            if isinstance(o, dict) and o.get("@type") == "LocalBusiness":
                ld = o
    people = []
    for c in ci.get("contacts") or []:
        person = _person_name(c.get("name"))
        if person and person.lower() not in {p["name"].lower() for p in people}:
            people.append({"name": person, "title": (c.get("title") or "").strip() or None,
                           "prefix": (c.get("name") or {}).get("prefix"),
                           "principal": bool(c.get("isPrincipal")), "management": bool(c.get("isManagement"))})
    pa = loc.get("postalAddress") or {}
    accredited = bool((bp.get("accreditationInformation") or {}).get("isAccredited"))
    return {
        "bbb_id": f"{bp.get('bbbId')}-{bp.get('businessId')}",
        "name": names.get("primary") or ld.get("name"),
        "alt_names": [n for n in (_val(x) for x in names.get("altBusinessNames") or []) if n],
        "phone": ci.get("phoneNumber"),
        "additional_phones": [p for p in (_val(x) for x in ci.get("additionalPhoneNumbers") or []) if p],
        "website": urls.get("primary") or urls.get("website") or None,
        "additional_websites": [w for w in (_val(x) for x in ci.get("additionalWebsiteAddresses") or []) if w],
        "street": " ".join(x for x in (pa.get("addressLine1"), pa.get("addressLine2")) if x) or None,
        "city": pa.get("city"),
        "state": pa.get("stateCode"),
        "zip": pa.get("zipCode"),
        "address": (loc.get("formattedAddress") or "").strip(" ,") or None,
        "latitude": loc.get("latitude"),
        "longitude": loc.get("longitude"),
        "people": people,
        "rating": rating.get("bbbRating"),
        "rating_not_rated_reason": rating.get("ratingReasonNotRated"),
        "accredited": accredited,
        # dates.accredited survives a lapsed accreditation, so it is only "since" while accredited.
        "accredited_since": _date(dates.get("accredited")) if accredited else None,
        "previously_accredited": bool(dates.get("accredited")) and not accredited,
        "business_start": _date(dates.get("businessStart")),
        "incorporated": _date(dates.get("incorporated")),
        "bbb_file_opened": _date(dates.get("bbbFileOpened")),
        "years_in_business": org.get("yearsInBusiness"),
        "entity_type": (org.get("typeOfEntity") or {}).get("name"),
        "employees": org.get("numEmployees") or None,  # 0 = not reported
        "out_of_business": bool(org.get("isOutOfBusiness")),
        "categories": [c["title"] for c in (bp.get("categories") or {}).get("links") or [] if c.get("title")],
        "licenses": [
            {"number": d.get("licenseNumber"), "agency": (d.get("licenseAgency") or {}).get("name"),
             "expiration": _date(d.get("expirationDate")), "notes": d.get("notes") or None}
            for d in lic.get("details") or [] if d.get("licenseNumber")
        ],
        "licensing_text": " ".join(t for t in lic.get("licensingTexts") or [] if t) or None,
        "complaints_total": rc.get("complaintsTotal"),
        "complaints_closed_3y": rc.get("totalClosedComplaintsPastThreeYears"),
        "complaints_closed_12m": rc.get("totalClosedComplaintsPastTwelveMonths"),
        "reviews_total": rc.get("reviewsTotal"),
        "review_rating_avg": rc.get("averageOfReviewStarRatings") or None,
        "social": {s["type"]: s["url"] for s in display.get("socialMediaList") or [] if s.get("type") and s.get("url")},
        "local_bbb": (bp.get("localBbbData") or {}).get("name"),
        "about": org.get("organizationDescription") or ld.get("description"),
    }


def services_from_categories(categories: list[str]) -> list[str]:
    """BBB category titles -> the canonical service keys used by website_crawl / tagging."""
    text = " | ".join(categories)
    return sorted(k for k, rx in SERVICE_RES.items() if rx.search(text))


# -- matching ----------------------------------------------------------------------------
def _street_key(s: str | None) -> tuple[str, str] | None:
    """'5430 44th St' -> ('5430', '44th'); None without a house number."""
    m = re.match(r"\s*(\d+[a-z]?)\s+([a-z0-9]+)", (s or "").lower())
    return (m.group(1), m.group(2)) if m else None


def _float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def score_profile(ctx: LeadContext, p: dict[str, Any], *, phone_shared: bool = False) -> dict[str, Any]:
    """Evidence + same-business confidence for parsed profile `p`."""
    c = ctx.contractor
    names = ctx.names()
    bbb_names = [n for n in [p.get("name"), *p.get("alt_names", [])] if n]
    nsim = max((name_similarity(a, b) for a in names for b in bbb_names), default=0.0)
    ssim = max((strict_similarity(a, b) for a in names for b in bbb_names), default=0.0)
    cp = phone_digits(c.get("phone"))
    phone_match = bool(cp and cp in {phone_digits(x) for x in [p.get("phone"), *p.get("additional_phones", [])]})
    reasons = []
    if phone_match and phone_shared and nsim < 0.7:
        # Same phone listed for several GAF contractors: alone it doesn't say which one this is.
        phone_match = False
        reasons.append("phone_shared_by_multiple_gaf_contractors")
    dist = None
    lat, lon = _float(p.get("latitude")), _float(p.get("longitude"))
    if lat is not None and lon is not None and c.get("latitude") is not None and c.get("longitude") is not None:
        dist = haversine_miles(float(c["latitude"]), float(c["longitude"]), lat, lon)
    same_zip = zip5(c.get("postal_code")) is not None and zip5(c.get("postal_code")) == zip5(p.get("zip"))
    same_city = bool(c.get("city")) and norm_city(c.get("city")) == norm_city(p.get("city"))
    sk = _street_key(c.get("street") or c.get("address"))
    same_street = sk is not None and sk == _street_key(p.get("street")) and (same_zip or same_city)
    address_match = same_zip or same_street or (dist is not None and dist <= ADDRESS_MILES)
    conf = match_confidence(name_sim=nsim, phone_match=phone_match, same_zip=same_zip or same_street,
                            same_city=same_city, distance_miles=dist)
    core = normalize_name(c.get("legal_name") or c.get("name"))
    # "ABC" collides too easily without a phone match -- unless the street, or full name + address, agree.
    if not phone_match and len(core) <= 3 and not (same_street or (ssim >= 0.97 and address_match)):
        conf = min(conf, 0.5)
        reasons.append("short_name")
    # Loose names drop trade words ("Brooklyn Roofing" == "Brooklyn Construction"), and a ZIP or
    # a mile holds many namesakes, so that evidence alone also needs the strict name to agree.
    if not phone_match and not same_street and ssim < STRICT_NAME:
        conf = min(conf, 0.75)
        reasons.append("strict_name_differs")
    reasons += [f"name={nsim:.2f}"] + (["phone"] if phone_match else []) + (["address"] if address_match else [])
    conf = round(conf, 3)  # 0.7 + 0.2 is 0.8999... in floating point
    return {
        "confidence": conf,
        "accept": conf >= ACCEPT and (phone_match or address_match),
        "phone_match": phone_match,
        "address_match": address_match,
        "name_similarity": round(nsim, 3),
        "strict_name_similarity": round(ssim, 3),
        "same_zip": same_zip,
        "same_street": same_street,
        "same_city": same_city,
        "distance_miles": None if dist is None else round(dist, 2),
        "reasons": reasons,
    }


class BbbEnricher(Enricher):
    name = "bbb"

    def __init__(self, settings):
        super().__init__(settings)
        self.cache_dir = Path(getattr(settings, "cache_dir", None) or default_cache_dir())
        self.robots: Robots | None = None
        self.index: ProfileIndex | None = None
        self._profiles: dict[str, asyncio.Future] = {}
        self._gaf_phone_counts: Counter[str] = Counter()
        self._lock = asyncio.Lock()

    def applies_to(self, ctx: LeadContext) -> bool:
        return (ctx.get("state") or "").upper() in STATE_BUREAUS and bool(ctx.names())

    # -- loading -------------------------------------------------------------------------
    async def _get(self, http: HttpClient, url: str, **kw: Any):
        u = urlsplit(url)
        if self.robots is None or not self.robots.allowed((u.path or "/") + (f"?{u.query}" if u.query else "")):
            raise PermissionError(f"robots.txt disallows {url}")
        return await http.get(url, **kw)

    async def _load_robots(self, http: HttpClient) -> None:
        r = await http.get(ROBOTS_URL, timeout=30)
        self.robots = Robots(r.text)
        if not any(s.rstrip("/") == PROFILES_INDEX for s in self.robots.sitemaps):
            raise RuntimeError("bbb.org robots.txt no longer advertises the business-profiles sitemap")

    async def _first_bureau(self, http: HttpClient, url: str, memo: dict[str, str | None]) -> str | None:
        if url not in memo:
            r = await self._get(http, url, headers={"Range": "bytes=0-2047"}, timeout=60)
            m = ANY_LOC_RE.search(r.text)
            memo[url] = m.group(1) if m else None
        return memo[url]

    async def bureau_files(self, http: HttpClient, files: list[str], bureau: str,
                           memo: dict[str, str | None]) -> list[str]:
        """Child sitemaps that can hold `bureau`'s profiles (files are sorted by bureau code)."""

        async def first_index(pred) -> int:
            lo, hi = 0, len(files)
            while lo < hi:
                mid = (lo + hi) // 2
                b = await self._first_bureau(http, files[mid], memo)
                if b is not None and pred(b):
                    hi = mid
                else:
                    lo = mid + 1
            return lo

        start = await first_index(lambda b: b >= bureau)
        end = await first_index(lambda b: b > bureau)
        # The file before `start` may begin with an earlier bureau and end with this one.
        return files[max(start - 1, 0):max(end, start)]

    def _cache_path(self, bureau: str) -> Path:
        return self.cache_dir / CACHE_SUBDIR / f"profiles-{bureau}.tsv.gz"

    def _read_cache(self, bureau: str, max_age_h: float | None) -> list[ProfileRef] | None:
        path = self._cache_path(bureau)
        try:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                meta = json.loads(f.readline().lstrip("#"))
                if max_age_h is not None and time.time() - meta["built_at"] > max_age_h * 3600:
                    return None
                return [ProfileRef(*line.rstrip("\n").split("\t")) for line in f if line.strip()]
        except (OSError, EOFError, ValueError, KeyError, TypeError):  # EOFError: truncated gzip
            return None

    def _write_cache(self, bureau: str, rows: list[ProfileRef], files: list[str]) -> None:
        path = self._cache_path(bureau)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            f.write("#" + json.dumps({"built_at": time.time(), "bureau": bureau, "sitemaps": files}) + "\n")
            f.writelines("\t".join(r) + "\n" for r in rows)
        os.replace(tmp, path)

    async def build_bureaus(self, http: HttpClient, bureaus: list[str]) -> dict[str, list[ProfileRef]]:
        idx = await self._get(http, PROFILES_INDEX, timeout=60)
        files = parse_sitemap_index(idx.text)
        if not files:
            raise ValueError("bbb.org business-profiles sitemap index lists no files")
        memo: dict[str, str | None] = {}
        out: dict[str, list[ProfileRef]] = {}
        for b in bureaus:
            sel = await self.bureau_files(http, files, b, memo)
            rows: list[ProfileRef] = []
            for url in sel:
                r = await self._get(http, url, timeout=180)
                rows += parse_profile_sitemap(r.text, {b})
            log.info("bbb: bureau %s -> %d profile URLs from %d sitemap files", b, len(rows), len(sel))
            self._write_cache(b, rows, sel)
            out[b] = rows
        return out

    async def prepare(self, http: HttpClient, contractors: list[dict[str, Any]]) -> None:
        http.set_host_interval(HOST, HOST_INTERVAL_S)
        self._gaf_phone_counts = Counter(p for p in (phone_digits(c.get("phone")) for c in contractors) if p)
        async with self._lock:
            if self.robots is None:
                await self._load_robots(http)
            if self.index is not None:
                return
            states = {(c.get("state") or "").upper() for c in contractors} & set(STATE_BUREAUS)
            bureaus = sorted({b for s in states for b in STATE_BUREAUS[s]})
            rows: list[ProfileRef] = []
            stale = []
            for b in bureaus:
                cached = self._read_cache(b, INDEX_TTL_HOURS)
                if cached is None:
                    stale.append(b)
                else:
                    rows += cached
            if stale:
                try:
                    for b_rows in (await self.build_bureaus(http, stale)).values():
                        rows += b_rows
                except (HttpError, ValueError) as e:
                    # Keep working from an expired index rather than not at all.
                    old = [self._read_cache(b, None) for b in stale]
                    if any(o is None for o in old):
                        raise
                    log.warning("bbb: sitemap refresh failed (%s); using expired index", e)
                    rows += [r for o in old for r in o or []]
            self.index = ProfileIndex(rows)
            log.info("bbb: profile index has %d NY/NJ-bureau URLs (bureaus %s)", len(rows), bureaus)

    # -- per contractor ------------------------------------------------------------------
    async def _fetch_profile(self, http: HttpClient, url: str) -> dict[str, Any] | None:
        r = await self._get(http, url, retries=2, timeout=60, allow_statuses=(404, 410))
        return parse_profile(r.text) if r.ok else None

    async def profile(self, http: HttpClient, ref: ProfileRef) -> dict[str, Any] | None:
        url = ref.url
        if not PROFILE_PATH_RE.match(urlsplit(url).path):
            return None
        fut = self._profiles.get(url)
        if fut is None:  # several contractors can share a candidate: fetch it once
            fut = self._profiles[url] = asyncio.ensure_future(self._fetch_profile(http, url))
        return await asyncio.shield(fut)

    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        if self.index is None or self.robots is None:
            await self.prepare(http, [ctx.contractor])
        assert self.index is not None
        ranked = rank_candidates(ctx, self.index.candidates(ctx.names(), ctx.get("state") or ""))
        shared = self._gaf_phone_counts.get(phone_digits(ctx.get("phone")) or "-", 0) > 1
        tried: list[dict[str, Any]] = []
        errors: list[str] = []
        best: tuple[dict[str, Any], dict[str, Any], ProfileRef] | None = None
        for _, _, ref in ranked[:MAX_FETCHES]:
            try:
                p = await self.profile(http, ref)
            except (HttpError, PermissionError) as e:
                errors.append(str(e))
                continue
            if p is None:
                tried.append({"url": ref.url, "status": "missing_or_unparsable"})
                continue
            ev = score_profile(ctx, p, phone_shared=shared)
            tried.append({"url": ref.url, "bbb_name": p.get("name"), "confidence": ev["confidence"],
                          "accept": ev["accept"], "reasons": ev["reasons"]})
            if ev["accept"] and (best is None or ev["confidence"] > best[1]["confidence"]):
                best = (p, ev, ref)
            if ev["accept"] and ev["phone_match"]:
                break
        urls = [t["url"] for t in tried]
        if best is None:
            if errors:  # a candidate we couldn't read may be the match: retry next run, not no_match
                return self.error("; ".join(errors))
            return self.no_match({"candidates": len(ranked), "fetched": tried}, source_urls=urls)
        p, ev, ref = best
        conf = ev["confidence"]
        data = {
            "bbb_id": p["bbb_id"],
            "profile_url": ref.url,
            "bbb_name": p["name"],
            "alt_names": p["alt_names"],
            "rating": p["rating"],
            "accredited": p["accredited"],
            "accredited_since": p["accredited_since"],
            "previously_accredited": p["previously_accredited"],
            "business_start": p["business_start"],
            "incorporated": p["incorporated"],
            "years_in_business": p["years_in_business"],
            "entity_type": p["entity_type"],
            "employees": p["employees"],
            "out_of_business": p["out_of_business"],
            "categories": p["categories"],
            "services": services_from_categories(p["categories"]),
            "licenses": p["licenses"],
            "licensing_text": p["licensing_text"],
            "website": p["website"],
            "additional_websites": p["additional_websites"],
            "phone": p["phone"],
            "address": p["address"],
            "complaints_total": p["complaints_total"],
            "complaints_closed_3y": p["complaints_closed_3y"],
            "complaints_closed_12m": p["complaints_closed_12m"],
            "reviews_total": p["reviews_total"],
            "review_rating_avg": p["review_rating_avg"],
            "social": p["social"],
            "local_bbb": p["local_bbb"],
            "about": p["about"],
            "people": p["people"],
            "match_evidence": ev,
            "fetched": tried,
        }
        contacts = [
            Contact(name=x["name"], title=x["title"] or ("Principal" if x["principal"] else "Business management"),
                    source=self.name, source_url=ref.url, confidence=round(conf * 0.9, 3))
            for x in p["people"]
        ]
        return self.ok(data, conf, contacts=contacts, website=p["website"], source_urls=urls)
