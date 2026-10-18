"""Google Places API (New) enricher.

Two modes:

* **Keyed** (``GOOGLE_MAPS_API_KEY`` set): Place Details by the place id GAF
  publishes for ~55% of contractors; otherwise (or when that id is stale) a Text
  Search biased to the contractor's coordinates, with the best candidate chosen
  by phone / name / distance evidence (accepted only at confidence >= 0.6).
  Returns the full ``google_places`` data contract from ``base.py`` and sets
  ``result.website`` from ``websiteUri``.
* **Keyless** (no key): stays enabled. Contractors with a GAF-supplied place id
  get an OK result carrying the id and a canonical Google Maps link (place ids
  may be stored indefinitely under the Maps ToS); the rest are SKIPPED.

Billing note: the field mask below includes ``websiteUri``/``nationalPhoneNumber``/
``rating``/``regularOpeningHours`` so each call bills at the *Enterprise* SKU
(Place Details Enterprise / Text Search Enterprise). See ``FIELDS``.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from ..http import HttpClient, HttpError, Response
from ..models import EnrichmentResult
from .base import Enricher, LeadContext
from .matching import haversine_miles, match_confidence, name_similarity, normalize_name, same_phone, zip5

log = logging.getLogger(__name__)

API_HOST = "places.googleapis.com"
DETAILS_URL = "https://places.googleapis.com/v1/places/{place_id}"
SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

# Place fields requested (Place Details mask; Text Search prefixes each with "places.").
FIELDS: tuple[str, ...] = (
    "id",
    "displayName",
    "formattedAddress",
    "nationalPhoneNumber",
    "internationalPhoneNumber",
    "websiteUri",
    "googleMapsUri",
    "rating",
    "userRatingCount",
    "businessStatus",
    "primaryType",
    "types",
    "regularOpeningHours.weekdayDescriptions",
    "pureServiceAreaBusiness",  # Pro-tier field; many roofers hide their address on Google
    # Essentials-tier (no billing change): coordinates to check that the place is near the contractor.
    # Needed on Details too -- GAF's place id is sometimes a same-name firm in another state.
    "location",
)
SEARCH_FIELDS: tuple[str, ...] = FIELDS
DETAILS_FIELD_MASK = ",".join(FIELDS)
SEARCH_FIELD_MASK = ",".join(f"places.{f}" for f in SEARCH_FIELDS)

MIN_CONFIDENCE = 0.6
LOCAL_RADIUS_MI = 3.0  # name-only matches must be this close (or same ZIP/city)
# A GAF place id that resolves this far away (and has no phone match) is a different business:
# live check found GAF's id for "All Point Construction" (Cliffside Park, NJ) pointing at
# "AllPoint Construction" in Allen Park, MI -- near-identical name, 500+ miles away.
FAR_MI = 25.0
BIAS_RADIUS_M = 2000.0
SEARCH_PAGE_SIZE = 5
MAX_QUERIES = 2  # listing name + address, then legal name + address or name + city
QUOTA_BREAKER = 3  # consecutive 429s (after HttpClient retries) before we stop calling for this run
HOST_INTERVAL_S = 0.15  # ~6 req/s: well under Places per-minute quotas, still finishes 424 rows in ~1 min

# Profile/directory hosts: not a company website -> data["social_url"], never result.website.
SOCIAL_HOSTS = (
    "facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "yelp.com",
    "houzz.com", "angi.com", "angieslist.com", "homeadvisor.com", "thumbtack.com", "nextdoor.com",
    "linktr.ee", "business.site", "youtube.com", "tiktok.com", "bbb.org", "google.com", "g.page",
)


def maps_url_for(place_id: str) -> str:
    return f"https://www.google.com/maps/place/?q=place_id:{place_id}"


def maps_search_url_for(place_id: str, query: str | None) -> str:
    """Documented Maps URLs 'search' action; `query` is the fallback if the id has gone stale."""
    q = quote((query or "").strip() or place_id, safe="")
    return f"https://www.google.com/maps/search/?api=1&query={q}&query_place_id={quote(place_id, safe='')}"


def _clean_website(url: str | None) -> str | None:
    """Drop tracking params (utm_*, gclid, ...) that Google Business Profiles often carry."""
    if not url:
        return None
    url = url.strip()
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if not parts.scheme or not parts.netloc:
        return url
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
         if not (k.lower().startswith("utm_") or k.lower() in {"gclid", "fbclid", "y_source"})]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), ""))


def _is_social(url: str | None) -> bool:
    if not url:
        return False
    try:
        host = urlsplit(url).netloc.lower().split(":")[0]
    except ValueError:
        return False
    host = host[4:] if host.startswith("www.") else host
    return any(host == h or host.endswith("." + h) for h in SOCIAL_HOSTS)


def _zip_from_address(addr: str | None) -> str | None:
    """'1314 8th St, North Bergen, NJ 07047, USA' -> '07047'."""
    if not addr:
        return None
    m = re.search(r"\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b", addr)
    return m.group(1) if m else None


def _state_from_address(addr: str | None) -> str | None:
    """'7420 Allen Rd, Allen Park, MI 48101, USA' -> 'MI'."""
    if not addr:
        return None
    m = re.search(r"\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b", addr)
    return m.group(1) if m else None


def details_verdict(ctx: LeadContext, place: dict[str, Any], cd: "Candidate") -> float | None:
    """Confidence that GAF's place id is this contractor, or None if the place is clearly elsewhere."""
    dist = cd.distance_miles
    if not cd.phone_match:
        if dist is not None and dist > FAR_MI:
            return None
        if dist is None:
            cs = (ctx.get("state") or "").strip().upper()
            ps = _state_from_address(place.get("formattedAddress"))
            if cs and ps and cs != ps and not {cs, ps} <= {"NY", "NJ", "CT", "PA"}:
                return None
    # "Brooklyn" covers 70 sq mi, so city equality only counts when there are no coordinates.
    near = cd.same_zip or (dist is not None and dist <= LOCAL_RADIUS_MI) or (dist is None and cd.same_city)
    if cd.phone_match or (cd.name_similarity >= 0.7 and near):
        return 1.0
    if cd.name_similarity >= 0.7 or near:
        return 0.85
    return 0.7  # GAF asserted it, but neither name, phone nor locality corroborates


@dataclass
class GoogleApiError:
    status: int
    code: str = ""  # e.g. NOT_FOUND, INVALID_ARGUMENT, PERMISSION_DENIED, RESOURCE_EXHAUSTED
    message: str = ""
    reasons: list[str] = field(default_factory=list)  # ErrorInfo reasons, e.g. API_KEY_INVALID

    @classmethod
    def from_response(cls, resp: Response) -> "GoogleApiError":
        code, message, reasons = "", "", []
        try:
            err = (resp.json() or {}).get("error") or {}
            code = str(err.get("status") or "")
            message = str(err.get("message") or "")
            for d in err.get("details") or []:
                if isinstance(d, dict) and d.get("reason"):
                    reasons.append(str(d["reason"]))
        except (ValueError, AttributeError):
            message = (resp.text or "")[:300]
        return cls(status=resp.status, code=code, message=message, reasons=reasons)

    @property
    def is_auth(self) -> bool:
        """Key missing/invalid/restricted or API not enabled: every further call will fail too."""
        if self.status in (401, 403):
            return True
        return any(r.startswith("API_KEY") or r in {"SERVICE_DISABLED", "BILLING_DISABLED"} for r in self.reasons)

    @property
    def is_stale_id(self) -> bool:
        """Obsolete (404 NOT_FOUND) or malformed (400 INVALID_ARGUMENT, non-key) place id."""
        if self.is_auth:
            return False
        return self.status == 404 or (self.status == 400 and self.code in {"INVALID_ARGUMENT", ""})

    def __str__(self) -> str:
        extra = f" [{','.join(self.reasons)}]" if self.reasons else ""
        return f"HTTP {self.status} {self.code}{extra}: {self.message}".strip()


class _Fatal(Exception):
    """Auth/quota condition that should stop further API calls in this run."""


@dataclass
class Candidate:
    place: dict[str, Any]
    confidence: float
    name_similarity: float
    phone_match: bool
    distance_miles: float | None
    same_zip: bool
    same_city: bool

    def evidence(self) -> dict[str, Any]:
        return {
            "name_similarity": round(self.name_similarity, 3),
            "phone_match": self.phone_match,
            "distance_miles": None if self.distance_miles is None else round(self.distance_miles, 2),
            "same_zip": self.same_zip,
            "same_city": self.same_city,
        }


def score_candidate(ctx: LeadContext, place: dict[str, Any]) -> Candidate:
    c = ctx.contractor
    display = ((place.get("displayName") or {}).get("text") or "").strip()
    names = ctx.names() or [c.get("name") or ""]
    sim = max((name_similarity(n, display) for n in names), default=0.0)
    phone = c.get("phone")
    phone_match = same_phone(phone, place.get("nationalPhoneNumber")) or same_phone(
        phone, place.get("internationalPhoneNumber")
    )
    dist = None
    loc = place.get("location") or {}
    if c.get("latitude") is not None and c.get("longitude") is not None and \
            loc.get("latitude") is not None and loc.get("longitude") is not None:
        dist = haversine_miles(float(c["latitude"]), float(c["longitude"]),
                               float(loc["latitude"]), float(loc["longitude"]))
    addr = place.get("formattedAddress") or ""
    cz, pz = zip5(c.get("postal_code")), _zip_from_address(addr)
    same_zip = bool(cz and pz and cz == pz)
    city = (c.get("city") or "").strip().lower()
    same_city = bool(city and city in addr.lower())
    conf = match_confidence(name_sim=sim, phone_match=phone_match, same_zip=same_zip,
                            same_city=same_city, distance_miles=dist)
    # Name-only evidence is not enough for generic names ("Elite Roofing" exists in every county):
    # without a phone match, require some locality corroboration.
    near = same_zip or same_city or (dist is not None and dist <= LOCAL_RADIUS_MI)
    if not phone_match and not near:
        conf = min(conf, 0.45)
    return Candidate(place, conf, sim, phone_match, dist, same_zip, same_city)


def pick_best(ctx: LeadContext, places: list[dict[str, Any]]) -> Candidate | None:
    """Highest-confidence candidate; ties -> operational, then nearest."""
    scored = [score_candidate(ctx, p) for p in places if isinstance(p, dict) and p.get("id")]
    if not scored:
        return None

    def key(cd: Candidate) -> tuple:
        operational = (cd.place.get("businessStatus") or "OPERATIONAL") == "OPERATIONAL"
        return (cd.confidence, operational, -(cd.distance_miles if cd.distance_miles is not None else 1e9))

    return max(scored, key=key)


def place_to_data(place: dict[str, Any]) -> dict[str, Any]:
    """Map a Places API (New) Place object onto the google_places data contract (base.py)."""
    pid = place.get("id")
    raw_site = place.get("websiteUri")
    site = _clean_website(raw_site)
    hours = (place.get("regularOpeningHours") or {}).get("weekdayDescriptions")
    data: dict[str, Any] = {
        "place_id": pid,
        "display_name": (place.get("displayName") or {}).get("text"),
        # A Facebook/Yelp/etc. profile is not a company website: keep it, but under social_url.
        "website": None if _is_social(site) else site,
        "social_url": site if _is_social(site) else None,
        "google_maps_url": place.get("googleMapsUri") or (maps_url_for(pid) if pid else None),
        "rating": place.get("rating"),
        "user_rating_count": place.get("userRatingCount"),
        "business_status": place.get("businessStatus"),
        "primary_type": place.get("primaryType"),
        "types": list(place.get("types") or []),
        "phone": place.get("nationalPhoneNumber"),
        "international_phone": place.get("internationalPhoneNumber"),
        "formatted_address": place.get("formattedAddress"),
        "opening_hours": list(hours) if hours else None,
        "pure_service_area_business": place.get("pureServiceAreaBusiness"),
        "api": True,
    }
    return data


class GooglePlacesEnricher(Enricher):
    name = "google_places"

    def __init__(self, settings):
        super().__init__(settings)
        self.api_key: str | None = (settings.google_maps_api_key or "").strip() or None
        self._fatal: str | None = None  # set once auth fails -> no more calls this run
        self._consecutive_quota = 0
        # The first keyed call runs alone, so a bad key costs one request, not one per worker.
        self._probe_lock = asyncio.Lock()
        self._key_checked = False

    # Keyless mode keeps the enricher useful (place ids + maps links), so it is always enabled.
    def is_enabled(self) -> tuple[bool, str]:
        return True, ""

    @property
    def mode(self) -> str:
        return "api" if self.api_key else "keyless"

    def input_hash(self, ctx: LeadContext) -> str:
        """Fold the mode into the fingerprint.

        Keyless OK/SKIPPED rows would otherwise count as fresh for the whole enrichment
        TTL (30 days) after a key is configured; a mode change now re-triggers the call.
        """
        base = super().input_hash(ctx)
        return hashlib.sha256(f"{base}|{self.mode}".encode()).hexdigest()

    async def prepare(self, http: HttpClient, contractors: list[dict[str, Any]]) -> None:
        if self.api_key and hasattr(http, "set_host_interval"):
            http.set_host_interval(API_HOST, HOST_INTERVAL_S)

    # ------------------------------------------------------------------ public
    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        place_id = (ctx.get("google_place_id") or "").strip() or None
        if not self.api_key:
            return self._keyless(ctx, place_id)
        if not self._key_checked:
            async with self._probe_lock:
                if not self._key_checked and not self._fatal:
                    result = await self._guarded(ctx, http, place_id)
                    self._key_checked = True
                    return result
        return await self._guarded(ctx, http, place_id)

    async def _guarded(self, ctx: LeadContext, http: HttpClient, place_id: str | None) -> EnrichmentResult:
        if self._fatal:
            return self.error(f"google places API unavailable this run: {self._fatal}")
        try:
            return await self._enrich_api(ctx, http, place_id)
        except _Fatal as e:
            return self.error(str(e))
        except HttpError as e:
            if e.status == 429:
                self._consecutive_quota += 1
                if self._consecutive_quota >= QUOTA_BREAKER:
                    self._fatal = f"quota exhausted (HTTP 429 x{self._consecutive_quota})"
                return self.error(f"google places quota/rate limit: {e}")
            return self.error(f"google places request failed: {e}")
        except Exception as e:  # never crash the run on malformed payloads
            log.warning("google_places failed for %s: %s", ctx.gaf_id, e)
            return self.error(f"{type(e).__name__}: {e}")

    # ----------------------------------------------------------------- keyless
    def _keyless(self, ctx: LeadContext, place_id: str | None) -> EnrichmentResult:
        if not place_id:
            return self.skipped("no GOOGLE_MAPS_API_KEY")
        url = maps_url_for(place_id)
        c = ctx.contractor
        query = ", ".join(x for x in ((c.get("name") or "").strip(), (c.get("address") or "").strip()) if x)
        data = {"place_id": place_id, "google_maps_url": url, "api": False,
                "maps_search_url": maps_search_url_for(place_id, query)}
        return self.ok(data, 1.0, source_urls=[url])

    # --------------------------------------------------------------------- api
    def _headers(self, mask: str) -> dict[str, str]:
        assert self.api_key
        return {"X-Goog-Api-Key": self.api_key, "X-Goog-FieldMask": mask,
                "Content-Type": "application/json"}

    def _check(self, resp: Response) -> GoogleApiError | None:
        """None if OK. Raises _Fatal on auth errors. Returns the parsed error otherwise."""
        if resp.ok:
            self._consecutive_quota = 0
            return None
        err = GoogleApiError.from_response(resp)
        if err.is_auth:
            self._fatal = str(err)
            raise _Fatal(f"google places auth error: {err}")
        return err

    async def _details(self, http: HttpClient, place_id: str) -> tuple[dict[str, Any] | None, GoogleApiError | None, str]:
        url = DETAILS_URL.format(place_id=quote(place_id, safe=""))
        resp = await http.get(url, headers=self._headers(DETAILS_FIELD_MASK),
                              allow_statuses=(400, 401, 403, 404))
        err = self._check(resp)
        if err is not None:
            return None, err, url
        return resp.json(), None, url

    async def _search(self, http: HttpClient, query: str, ctx: LeadContext) -> tuple[list[dict[str, Any]], GoogleApiError | None]:
        # includePureServiceAreaBusinesses: without it Text Search drops businesses that have no
        # public address -- which describes a large share of residential roofers.
        body: dict[str, Any] = {"textQuery": query, "pageSize": SEARCH_PAGE_SIZE, "regionCode": "US",
                                "includePureServiceAreaBusinesses": True}
        lat, lng = ctx.get("latitude"), ctx.get("longitude")
        if lat is not None and lng is not None:
            body["locationBias"] = {"circle": {"center": {"latitude": float(lat), "longitude": float(lng)},
                                               "radius": BIAS_RADIUS_M}}
        resp = await http.post(SEARCH_URL, headers=self._headers(SEARCH_FIELD_MASK), json=body,
                               allow_statuses=(400, 401, 403, 404))
        err = self._check(resp)
        if err is not None:
            return [], err
        payload = resp.json() or {}  # Google returns {} when nothing matched
        return [p for p in payload.get("places") or [] if isinstance(p, dict)], None

    def search_queries(self, ctx: LeadContext) -> list[str]:
        c = ctx.contractor
        where = (c.get("address") or "").strip() or ", ".join(
            x for x in (c.get("city"), c.get("state"), c.get("postal_code")) if x)
        names: list[str] = []
        keys: set[str] = set()
        for n in [c.get("name"), c.get("legal_name"), c.get("dba")]:
            n = (n or "").strip()
            k = normalize_name(n, strict=True)
            if n and k not in keys:  # "Acme Roofing LLC" ~ "Acme Roofing": one query
                names.append(n)
                keys.add(k)
        qs = [f"{n}, {where}" if where else n for n in names]
        # Many roofers are service-area businesses whose street address Google hides;
        # a name + locality query is the fallback when no second name exists.
        locality = ", ".join(x for x in (c.get("city"), c.get("state")) if x)
        if names and locality:
            qs.append(f"{names[0]}, {locality}")
        return list(dict.fromkeys(qs))[:MAX_QUERIES]

    async def _enrich_api(self, ctx: LeadContext, http: HttpClient, place_id: str | None) -> EnrichmentResult:
        stale: str | None = None
        rejected: dict[str, Any] | None = None
        urls: list[str] = []
        if place_id:
            place, err, url = await self._details(http, place_id)
            urls.append(url)
            if isinstance(place, dict):
                cd = score_candidate(ctx, place)
                # GAF asserted this id; phone / name+locality corroboration pushes it to certainty,
                # a place far away with no phone match means GAF linked the wrong business.
                conf = details_verdict(ctx, place, cd)
                if conf is not None:
                    data = place_to_data(place)
                    data.update(method="place_id", match=cd.evidence())
                    if data.get("place_id") and data["place_id"] != place_id:
                        data["requested_place_id"] = place_id  # Google served a refreshed id
                    return self._ok_from(data, conf, urls)
                rejected = {"place_id": place.get("id") or place_id,
                            "display_name": (place.get("displayName") or {}).get("text"),
                            "formatted_address": place.get("formattedAddress"), **cd.evidence()}
            else:
                if err is None:
                    return self.error("place details returned a non-object payload")
                if not err.is_stale_id:
                    return self.error(f"place details failed: {err}")
                stale = place_id  # obsolete id -> fall back to text search

        seen: dict[str, dict[str, Any]] = {}
        best: Candidate | None = None
        queries = self.search_queries(ctx)
        if not queries:
            return self.no_match({"reason": "no name to search", "stale_place_id": stale,
                                  "rejected_place": rejected, "api": True}, urls)
        for q in queries:
            places, err = await self._search(http, q, ctx)
            urls.append(SEARCH_URL)
            if err is not None:
                return self.error(f"text search failed: {err}")
            for p in places:
                if p.get("id"):
                    seen.setdefault(p["id"], p)
            best = pick_best(ctx, list(seen.values()))
            if best is not None and best.confidence >= MIN_CONFIDENCE:
                break
        urls = list(dict.fromkeys(urls))
        if best is None or best.confidence < MIN_CONFIDENCE:
            data: dict[str, Any] = {"queries": queries, "candidates": len(seen), "api": True}
            if stale:
                data["stale_place_id"] = stale
            if rejected:
                data["rejected_place"] = rejected
            if best is not None:
                data["best_rejected"] = {"place_id": best.place.get("id"),
                                         "display_name": (best.place.get("displayName") or {}).get("text"),
                                         "confidence": round(best.confidence, 3), **best.evidence()}
            return self.no_match(data, urls)
        data = place_to_data(best.place)
        method = "text_search_stale_id" if stale else "text_search_rejected_id" if rejected else "text_search"
        data.update(method=method, match=best.evidence())
        if stale:
            data["stale_place_id"] = stale
        if rejected:
            data["rejected_place"] = rejected
        return self._ok_from(data, best.confidence, urls)

    def _ok_from(self, data: dict[str, Any], conf: float, urls: list[str]) -> EnrichmentResult:
        site = data.get("website")
        if data.get("google_maps_url"):
            urls = urls + [data["google_maps_url"]]
        return self.ok(data, conf, website=site or None,
                       source_urls=list(dict.fromkeys(urls)))
