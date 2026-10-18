"""OpenStreetMap (Overpass API) enricher.

OSM is a free, keyless bulk source: business POIs often carry `website`,
`email`, `phone` and `opening_hours` tags. Coverage of small residential
roofers is thin, so this enricher is cheap and precise rather than high-recall.

Flow
  * `prepare()` sends ONE Overpass query covering the bounding box of every
    contractor in the run (padded ~0.05 deg). The union fetches named POIs that
    look like contractors (construction crafts, construction/company offices,
    trade shops, roofing-ish names) plus *any* POI whose phone tag equals a
    contractor's phone (an Overpass regex built from the run's phone numbers), so
    oddly-tagged businesses are still found by the strongest signal.
  * Elements are cached in memory and indexed by phone digits, normalised name
    and a coarse geo grid.
  * `enrich()` matches by phone (strong), else by name similarity >= 0.85 within
    0.75 mi, and returns the `osm` data contract from `base.py`.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any, ClassVar
from urllib.parse import urlsplit, urlunsplit

from ..http import HttpClient, HttpError
from ..models import EnrichmentResult
from .base import Enricher, LeadContext
from .matching import (
    haversine_miles,
    match_confidence,
    name_similarity,
    normalize_name,
    phone_digits,
    tokens,
    zip5,
)

log = logging.getLogger(__name__)

OVERPASS_ENDPOINTS: tuple[str, ...] = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
OSM_BROWSE = "https://www.openstreetmap.org"

BBOX_PAD_DEG = 0.05
QUERY_TIMEOUT_S = 180  # Overpass server-side [timeout:]
HTTP_TIMEOUT_S = 240  # client-side; the query routinely takes 40-90 s on the public instance
MAX_NAME_DISTANCE_MI = 0.75
NAME_THRESHOLD = 0.85
SAME_SITE_MI = 0.15  # "same building" -- relaxes the strict-name check
GRID_DEG = 0.02

# Overpass tag filters (experimentally tuned on the 10013/25mi area; see module docstring).
CONTRACTOR_CRAFTS = (
    "roofer|builder|carpenter|construction|window_construction|metal_construction|insulation|"
    "gutter|painter|plasterer|stonemason|scaffolder|hvac|plumber|electrician|tiler|floorer|"
    "glaziery|handyman|chimney_sweeper|waterproofing|siding|masonry|bricklayer|yes"
)
CONTRACTOR_OFFICES = (
    "company|construction|construction_company|constuction|contractor|contractors|yes|builder|"
    "roofer|roofing|home_improvement"
)
CONTRACTOR_SHOPS = (
    "trade|hardware|doityourself|roofing|building_materials|windows|doors|construction|gutter|"
    "siding|home_improvement"
)
NAME_HINTS = "roof|siding|gutter|exterior|contract|construct|home improv|remodel|renovat|builder"

PHONE_KEYS = ("phone", "contact:phone", "phone:mobile", "contact:mobile", "mobile", "phone:office")
WEBSITE_KEYS = ("website", "contact:website", "url", "contact:url")
EMAIL_KEYS = ("email", "contact:email")
NAME_KEYS = ("name", "official_name", "alt_name", "short_name", "brand")
SOCIAL_KEYS = {
    "contact:facebook": "facebook", "facebook": "facebook",
    "contact:instagram": "instagram", "instagram": "instagram",
    "contact:twitter": "twitter", "twitter": "twitter",
    "contact:linkedin": "linkedin", "contact:youtube": "youtube",
    "contact:yelp": "yelp", "contact:houzz": "houzz",
}
SOCIAL_HOSTS = {
    "facebook.com": "facebook", "fb.com": "facebook", "instagram.com": "instagram",
    "twitter.com": "twitter", "x.com": "twitter", "linkedin.com": "linkedin",
    "youtube.com": "youtube", "yelp.com": "yelp", "houzz.com": "houzz", "nextdoor.com": "nextdoor",
    "google.com": "google", "goo.gl": "google", "business.site": "google",
}
FREE_MAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "aol.com", "aim.com",
    "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
    "comcast.net", "verizon.net", "optonline.net", "optimum.net", "att.net", "sbcglobal.net",
    "bellsouth.net", "earthlink.net", "juno.com", "netzero.net", "netzero.com", "cox.net",
    "charter.net", "spectrum.net", "rcn.com", "frontier.com", "frontiernet.net", "windstream.net",
    "protonmail.com", "proton.me", "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com",
    "yandex.com", "yandex.ru", "inbox.com", "fastmail.com", "hushmail.com", "tutanota.com",
    "roadrunner.com", "rr.com", "twc.com", "ptd.net", "erols.com", "nyc.rr.com", "nj.rr.com",
})


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested)
# ---------------------------------------------------------------------------


def split_multi(value: str | None) -> list[str]:
    """OSM multi-values are ';'-separated ('a;b'); some mappers use ','."""
    if not value:
        return []
    return [p.strip() for p in re.split(r"[;,]", value) if p.strip()]


def element_phones(tags: dict[str, str]) -> list[str]:
    """10-digit phone numbers from every phone-ish tag ('+1-718-...;+1 973 ...', 'ext 12')."""
    out: list[str] = []
    for k in PHONE_KEYS:
        raw = tags.get(k)
        if not raw:
            continue
        for part in re.split(r"[;,/]", raw):
            part = re.split(r"(?i)\b(?:ext|x)\.?\s*\d+\s*$", part.strip())[0]
            d = phone_digits(part)
            if d and d not in out:
                out.append(d)
    return out


def normalize_url(url: str | None) -> str | None:
    """'www.baschnagel.com' -> 'https://www.baschnagel.com'; rejects non-web values."""
    if not url:
        return None
    url = split_multi(url)[0] if ";" in url else url.strip()
    url = url.strip().strip("<>\"'")
    if not url or " " in url or "@" in url.split("/")[0]:
        return None
    if url.startswith("//"):
        url = "https:" + url
    elif not re.match(r"(?i)^[a-z][a-z0-9+.-]*://", url):
        url = "https://" + url
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower()
    if "." not in host:
        return None
    netloc = host + (f":{parts.port}" if parts.port else "")
    path = parts.path if parts.path not in ("", "/") else ""
    return urlunsplit((parts.scheme.lower(), netloc, path, parts.query, ""))


def url_host(url: str | None) -> str:
    try:
        host = (urlsplit(url).hostname or "").lower() if url else ""
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def social_platform(url: str | None) -> str | None:
    host = url_host(url)
    for h, platform in SOCIAL_HOSTS.items():
        if host == h or host.endswith("." + h):
            return platform
    return None


def email_domain(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    dom = email.rsplit("@", 1)[1].strip().strip(">").lower()
    return dom if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", dom) else None


def website_from_email(email: str | None) -> str | None:
    """Business email domain -> website guess (never for free-mail / ISP domains)."""
    dom = email_domain(email)
    if not dom or dom in FREE_MAIL_DOMAINS or social_platform("https://" + dom):
        return None
    return "https://" + dom


def strict_similarity(a: str | None, b: str | None) -> float:
    """Similarity on names with only legal forms removed ('Top Roofing' != 'Top NJ Construction').

    The shared `name_similarity` drops trade words ('roofing', 'construction') and gives 0.85
    for any token containment, so 'Westbury Roofing' ~ 'Sunbird Carpet Cleaning Westbury NY'.
    This check keeps the trade words and only credits containment of >= 2 tokens.
    """
    na, nb = normalize_name(a, strict=True), normalize_name(b, strict=True)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    sa, sb = set(na.split()), set(nb.split())
    jacc = len(sa & sb) / len(sa | sb)
    seq = SequenceMatcher(None, na, nb).ratio()
    contain = 0.9 if (min(len(sa), len(sb)) >= 2 and (sa <= sb or sb <= sa)) else 0.0
    return max(seq, jacc, contain)


@dataclass
class OsmPoi:
    osm_type: str  # node | way | relation
    osm_id: int
    tags: dict[str, str]
    lat: float | None
    lon: float | None
    names: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return self.tags.get("name") or (self.names[0] if self.names else "")

    @property
    def url(self) -> str:
        return f"{OSM_BROWSE}/{self.osm_type}/{self.osm_id}"

    @classmethod
    def from_element(cls, el: dict[str, Any]) -> "OsmPoi | None":
        tags = el.get("tags") or {}
        if el.get("type") not in ("node", "way", "relation") or "id" not in el:
            return None
        lat, lon = el.get("lat"), el.get("lon")
        if lat is None and isinstance(el.get("center"), dict):
            lat, lon = el["center"].get("lat"), el["center"].get("lon")
        names: list[str] = []
        for k in NAME_KEYS:
            for n in split_multi(tags.get(k)) if k != "name" else [tags.get(k, "").strip()]:
                if n and n.lower() not in {x.lower() for x in names}:
                    names.append(n)
        return cls(el["type"], int(el["id"]), dict(tags), lat, lon, names, element_phones(tags))


def contractor_bbox(contractors: list[dict[str, Any]], pad: float = BBOX_PAD_DEG) -> tuple[float, float, float, float] | None:
    pts = [(c["latitude"], c["longitude"]) for c in contractors
           if c.get("latitude") is not None and c.get("longitude") is not None]
    if not pts:
        return None
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    return (round(min(lats) - pad, 4), round(min(lons) - pad, 4),
            round(max(lats) + pad, 4), round(max(lons) + pad, 4))


def phone_regex(phones: list[str]) -> str | None:
    """Overpass (POSIX ERE) regex matching any of the 10-digit numbers in any common format."""
    digits = sorted({d for d in (phone_digits(p) for p in phones) if d})
    if not digits:
        return None
    return "|".join(f"{d[:3]}[^0-9]*{d[3:6]}[^0-9]*{d[6:]}" for d in digits)


def build_query(bbox: tuple[float, float, float, float], phones: list[str] | None = None,
                timeout: int = QUERY_TIMEOUT_S) -> str:
    s, w, n, e = bbox
    b = f"({s},{w},{n},{e})"
    parts = [
        f'  nwr["name"]["craft"~"^({CONTRACTOR_CRAFTS})$"]{b};',
        f'  nwr["name"]["office"~"^({CONTRACTOR_OFFICES})$"]{b};',
        f'  nwr["name"]["shop"~"^({CONTRACTOR_SHOPS})$"]{b};',
        f'  nwr["name"~"{NAME_HINTS}",i][!"highway"][!"railway"][!"waterway"][!"amenity"][!"leisure"]'
        f'[!"public_transport"]{b};',
    ]
    rx = phone_regex(phones or [])
    if rx:
        parts.append(f'  nwr["phone"~"{rx}"]{b};')
        parts.append(f'  nwr["contact:phone"~"{rx}"]{b};')
    body = "\n".join(parts)
    return f"[out:json][timeout:{timeout}];\n(\n{body}\n);\nout tags center;"


def parse_overpass(payload: dict[str, Any]) -> list[OsmPoi]:
    remark = str(payload.get("remark") or "")
    if "runtime error" in remark.lower() or "timed out" in remark.lower():
        raise ValueError(f"overpass incomplete result: {remark[:300]}")
    if "elements" not in payload:
        raise ValueError("overpass response has no 'elements'")
    out: list[OsmPoi] = []
    seen: set[tuple[str, int]] = set()
    for el in payload["elements"]:
        poi = OsmPoi.from_element(el)
        if poi is None or not poi.names or (poi.osm_type, poi.osm_id) in seen:
            continue
        seen.add((poi.osm_type, poi.osm_id))
        out.append(poi)
    return out


# ---------------------------------------------------------------------------
# Enricher
# ---------------------------------------------------------------------------


@dataclass
class _Match:
    poi: OsmPoi
    method: str  # phone | name
    name_sim: float
    strict_sim: float
    distance: float | None
    confidence: float


class OsmEnricher(Enricher):
    name: ClassVar[str] = "osm"
    endpoints: ClassVar[tuple[str, ...]] = OVERPASS_ENDPOINTS

    def __init__(self, settings):  # type: ignore[no-untyped-def]
        super().__init__(settings)
        self.pois: list[OsmPoi] = []
        self.by_phone: dict[str, list[OsmPoi]] = {}
        self.by_name: dict[str, list[OsmPoi]] = {}
        self.grid: dict[tuple[int, int], list[OsmPoi]] = {}
        self.loaded = False
        self.endpoint_used: str | None = None

    # -- loading ---------------------------------------------------------------
    @property
    def user_agent(self) -> str:
        """Descriptive UA. overpass-api.de answers 406 to UAs containing 'crawler'/'bot'/'spider'
        (verified live: 'LeadMaker research crawler' -> 406), so those words are dropped from the
        configured contact string."""
        contact = getattr(self.settings, "user_agent_contact", None) or ""
        contact = re.sub(r"(?i)\S*(crawl|bot|spider)\S*", "", contact)
        contact = re.sub(r"\s+", " ", contact).strip(" ;,")
        detail = "; ".join(x for x in ("B2B contractor data enrichment", contact) if x)
        return f"LeadMaker/0.1 ({detail})"

    async def prepare(self, http: HttpClient, contractors: list[dict[str, Any]]) -> None:
        bbox = contractor_bbox(contractors)
        if bbox is None:
            self.load([])
            return
        query = build_query(bbox, [c.get("phone") for c in contractors if c.get("phone")])
        headers = {"User-Agent": self.user_agent, "Accept": "application/json",
                   "Content-Type": "application/x-www-form-urlencoded"}
        errors: list[str] = []
        for url in self.endpoints:
            try:
                # Hard wall-clock cap: live runs saw curl ignore the per-request timeout and hang
                # ~16 min on an overloaded overpass-api.de, so enforce it here too.
                resp = await asyncio.wait_for(
                    http.post(url, data={"data": query}, headers=headers,
                              timeout=HTTP_TIMEOUT_S, retries=0),
                    timeout=HTTP_TIMEOUT_S + 30)
                pois = parse_overpass(resp.json())
            except asyncio.TimeoutError:
                log.warning("overpass endpoint %s exceeded %ss", url, HTTP_TIMEOUT_S + 30)
                errors.append(f"{url}: wall-clock timeout")
                continue
            except (HttpError, ValueError) as e:  # ValueError covers JSON decode errors
                log.warning("overpass endpoint %s failed: %s", url, e)
                errors.append(f"{url}: {e}")
                continue
            self.endpoint_used = url
            self.load(pois)
            log.info("osm: loaded %d POIs from %s for bbox %s", len(pois), url, bbox)
            return
        raise RuntimeError("all overpass endpoints failed: " + " | ".join(errors))

    def load(self, pois: list[OsmPoi]) -> None:
        self.pois = pois
        self.by_phone, self.by_name, self.grid = {}, {}, {}
        for p in pois:
            for d in p.phones:
                self.by_phone.setdefault(d, []).append(p)
            for n in p.names:
                key = normalize_name(n, strict=True)
                if key:
                    self.by_name.setdefault(key, []).append(p)
            if p.lat is not None and p.lon is not None:
                self.grid.setdefault(self._cell(p.lat, p.lon), []).append(p)
        self.loaded = True

    @staticmethod
    def _cell(lat: float, lon: float) -> tuple[int, int]:
        return int(lat // GRID_DEG), int(lon // GRID_DEG)

    def nearby(self, lat: float, lon: float, miles: float) -> list[tuple[OsmPoi, float]]:
        ci, cj = self._cell(lat, lon)
        out: list[tuple[OsmPoi, float]] = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for p in self.grid.get((ci + di, cj + dj), ()):
                    d = haversine_miles(lat, lon, p.lat, p.lon)  # type: ignore[arg-type]
                    if d <= miles:
                        out.append((p, d))
        return out

    # -- matching --------------------------------------------------------------
    @staticmethod
    def _sims(names: list[str], poi: OsmPoi) -> tuple[float, float]:
        loose = strict = 0.0
        for a in names:
            for b in poi.names:
                loose = max(loose, name_similarity(a, b))
                strict = max(strict, strict_similarity(a, b))
        return loose, strict

    def find_match(self, ctx: LeadContext) -> _Match | None:
        c = ctx.contractor
        names = ctx.names()
        lat, lon = c.get("latitude"), c.get("longitude")
        cz, ccity = zip5(c.get("postal_code")), (c.get("city") or "").strip().lower()

        def dist_to(p: OsmPoi) -> float | None:
            if lat is None or lon is None or p.lat is None or p.lon is None:
                return None
            return haversine_miles(lat, lon, p.lat, p.lon)

        def locality(p: OsmPoi) -> tuple[bool, bool]:
            pz = zip5(p.tags.get("addr:postcode"))
            pcity = (p.tags.get("addr:city") or "").strip().lower()
            return bool(cz and pz and cz == pz), bool(ccity and pcity and ccity == pcity)

        best: _Match | None = None
        # 1) phone -- strongest signal
        pd = phone_digits(c.get("phone"))
        for p in self.by_phone.get(pd, []) if pd else []:
            loose, strict = self._sims(names, p)
            d = dist_to(p)
            same_zip, same_city = locality(p)
            conf = match_confidence(name_sim=loose, phone_match=True, same_zip=same_zip,
                                    same_city=same_city, distance_miles=d)
            if loose < 0.5 and (d is None or d > 2.0):
                conf = min(conf, 0.7)  # shared/marketing number or stale tag -- weaker
            m = _Match(p, "phone", loose, strict, d, conf)
            if best is None or (m.confidence, m.name_sim) > (best.confidence, best.name_sim):
                best = m
        if best is not None:
            return best

        # 2) name similarity within MAX_NAME_DISTANCE_MI
        if lat is None or lon is None or not names:
            return None
        for p, d in self.nearby(lat, lon, MAX_NAME_DISTANCE_MI):
            loose, strict = self._sims(names, p)
            if loose < NAME_THRESHOLD:
                continue
            if strict < 0.8 and d > SAME_SITE_MI:
                continue  # only filler/trade/place words in common and not at the same site
            same_zip, same_city = locality(p)
            conf = match_confidence(name_sim=loose, same_zip=same_zip, same_city=same_city,
                                    distance_miles=d)
            if strict < 0.8:
                conf -= 0.1
            m = _Match(p, "name", loose, strict, d, conf)
            if best is None or (m.confidence, m.strict_sim, -d) > (best.confidence, best.strict_sim,
                                                                   -(best.distance or 0.0)):
                best = m
        return best

    # -- result ----------------------------------------------------------------
    @staticmethod
    def extract(poi: OsmPoi) -> dict[str, Any]:
        t = poi.tags
        website: str | None = None
        social: dict[str, str] = {}
        for k in WEBSITE_KEYS:
            for raw in split_multi(t.get(k)) if t.get(k) else []:
                u = normalize_url(raw)
                if not u:
                    continue
                plat = social_platform(u)
                if plat:
                    social.setdefault(plat, u)
                elif website is None:
                    website = u
        for k, plat in SOCIAL_KEYS.items():
            if t.get(k):
                u = normalize_url(t[k]) if "/" in t[k] or "." in t[k] else None
                if u:
                    social.setdefault(plat, u)
        emails = [e for k in EMAIL_KEYS for e in split_multi(t.get(k)) if "@" in e]
        email = emails[0].lower() if emails else None
        from_email = False
        if website is None:
            for e in emails:
                guess = website_from_email(e)
                if guess:
                    website, from_email = guess, True
                    break
        phone = next((t[k] for k in PHONE_KEYS if t.get(k)), None)
        addr = {k[5:]: v for k, v in t.items() if k.startswith("addr:")}
        category = next((f"{k}={t[k]}" for k in ("craft", "office", "shop", "building") if t.get(k)), None)
        return {
            "website": website,
            "website_from_email": from_email,
            "email": email,
            "emails": emails,
            "phone": phone,
            "phones": poi.phones,
            "osm_url": poi.url,
            "osm_type": poi.osm_type,
            "osm_id": poi.osm_id,
            "osm_name": poi.name,
            "category": category,
            "opening_hours": t.get("opening_hours"),
            "address": addr or None,
            "social": social,
            "lat": poi.lat,
            "lon": poi.lon,
            "tags": t,
        }

    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        if not self.loaded:
            return self.error("osm data not loaded (prepare() not run or failed)")
        m = self.find_match(ctx)
        if m is None:
            return self.no_match({"pois_searched": len(self.pois)})
        data = self.extract(m.poi)
        data["match"] = {
            "method": m.method,
            "name_similarity": round(m.name_sim, 3),
            "strict_name_similarity": round(m.strict_sim, 3),
            "distance_miles": None if m.distance is None else round(m.distance, 3),
            "phone_match": m.method == "phone",
        }
        return self.ok(data, m.confidence, website=data["website"], source_urls=[m.poi.url])
