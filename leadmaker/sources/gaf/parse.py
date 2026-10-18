"""Pure parsing functions for GAF data (no I/O) -- unit-tested against saved fixtures."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from selectolax.lexbor import LexborHTMLParser

from ...models import Contractor, ContractorProfile, Review, Tier

GAF_ORIGIN = "https://www.gaf.com"

# Known-good values captured from gaf.com (Oct 2026). Used only if live discovery fails.
DEFAULT_COVEO = {
    "ApiKey": "xx3cfe6ca4-11f2-45b6-83ad-41e053e06504",
    "OrganizationId": "gafmaterialscorporationproduction3yalqk12",
    "SearchHubPipeline": "prod-gaf-recommended-residential-contractors",
}
DEFAULT_FIELDS = {
    "latitudeField": "gaf_latitude",
    "longitudeField": "gaf_longitude",
    "distanceInMiles": "distanceinmiles",
    "countryCode": "gaf_f_country_code",
}
DEFAULT_RECOMMENDED_CONTEXT = {"sortingStrategy": "gafrecommended-initial"}

_TIER_CODES = (
    ("MASTER_ELITE", Tier.MASTER_ELITE),
    ("CERTIFIED_PLUS", Tier.CERTIFIED_PLUS),
    ("CERTIFIED", Tier.CERTIFIED),
)
_PLACEHOLDER_IMAGE = "no_profile_image"


@dataclass
class CoveoConfig:
    organization_id: str
    api_key: str
    search_hub: str
    fields: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_FIELDS))
    recommended_context: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_RECOMMENDED_CONTEXT))
    discovered: bool = False

    @property
    def endpoint(self) -> str:
        return f"https://{self.organization_id}.org.coveo.com/rest/search/v2"

    @classmethod
    def default(cls) -> "CoveoConfig":
        return cls(
            organization_id=DEFAULT_COVEO["OrganizationId"],
            api_key=DEFAULT_COVEO["ApiKey"],
            search_hub=DEFAULT_COVEO["SearchHubPipeline"],
        )


def parse_listing_config(html: str) -> CoveoConfig | None:
    """Extract the public Coveo search config the locator page hands to its JS widget.

    Discovering it at runtime (rather than hard-coding) means a rotated search key
    or renamed field doesn't silently break ingestion.
    """
    tree = LexborHTMLParser(html)
    node = tree.css_first("section.coveo-listing__data-wrapper[data-coveo]") or tree.css_first(
        '[data-module="contractor-listing"][data-coveo]'
    )
    if node is None:
        return None
    try:
        coveo = json.loads(node.attributes.get("data-coveo") or "")
    except json.JSONDecodeError:
        return None
    if not all(k in coveo for k in ("ApiKey", "OrganizationId", "SearchHubPipeline")):
        return None
    fields = dict(DEFAULT_FIELDS)
    try:
        fields.update(json.loads(node.attributes.get("data-search-fields") or "{}"))
    except json.JSONDecodeError:
        pass
    context = dict(DEFAULT_RECOMMENDED_CONTEXT)
    try:
        sorts = json.loads(node.attributes.get("data-sort-fields") or "[]")
        if sorts and isinstance(sorts[0].get("context"), dict):
            ctx = sorts[0]["context"]
            if ctx.get("sortingStrategy"):
                context = {"sortingStrategy": ctx["sortingStrategy"]}
    except (json.JSONDecodeError, AttributeError, IndexError):
        pass
    return CoveoConfig(
        organization_id=coveo["OrganizationId"],
        api_key=coveo["ApiKey"],
        search_hub=coveo["SearchHubPipeline"],
        fields=fields,
        recommended_context=context,
        discovered=True,
    )


def tier_from_codes(codes: list[str]) -> Tier:
    upper = [c.split("^_^")[0].upper() for c in codes]
    for code, tier in _TIER_CODES:
        if code in upper:
            return tier
    return Tier.NONE


def presidents_club_stars(raw: dict[str, Any], codes: list[str]) -> int:
    stars = raw.get("gaf_residential_presidents_club_stars_count")
    if isinstance(stars, (int, float)) and stars > 0:
        return int(stars)
    for c in codes:
        m = re.search(r"President.s Club (\d+) Star", c)
        if m:
            return int(m.group(1))
    return 0


def street_from_address(address: str | None, city: str | None, state: str | None, postal: str | None) -> str | None:
    """'133-38 Denis St Jamaica, NY 11434' -> '133-38 Denis St'."""
    if not address:
        return None
    s = address.strip()
    if city:
        m = re.search(rf"\s*{re.escape(city)},?\s*{re.escape(state or '')}\s*{re.escape(postal or '')}\s*$", s, re.I)
        if m:
            return s[: m.start()].strip(" ,") or None
    m = re.match(r"^(.*?)(?:,\s*[^,]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)$", s)
    return (m.group(1) if m else s).strip(" ,") or None


def _clean_phone(p: Any) -> str | None:
    if not p or not isinstance(p, str):
        return None
    return p.strip() or None


def parse_coveo_result(result: dict[str, Any]) -> Contractor:
    raw = result.get("raw", {})
    codes = list(raw.get("gaf_f_contractor_designations_residential") or [])
    certs = list(raw.get("gaf_f_contractor_certifications_and_awards_residential") or [])
    review_count = int(raw.get("gaf_number_of_reviews") or 0)
    rating = raw.get("gaf_rating")
    image = raw.get("gaf_featured_image_src")
    if image and _PLACEHOLDER_IMAGE in image:
        image = None
    elif image and image.startswith("/"):
        image = GAF_ORIGIN + image
    city, state, postal = raw.get("gaf_f_city"), raw.get("gaf_f_state_code"), raw.get("gaf_postal_code")
    specialties = sorted(
        set(raw.get("gaf_f_contractor_raq_specialties_residential") or [])
        | set(raw.get("gaf_f_contractor_specialties_residential") or [])
    )
    name = raw.get("gaf_navigation_title") or result.get("title") or ""
    dba = raw.get("gaf_contractor_dba")
    return Contractor(
        gaf_id=str(raw.get("gaf_contractor_id")),
        name=name.strip(),
        dba=dba.strip() if isinstance(dba, str) and dba.strip() and dba.strip() != name.strip() else None,
        contractor_type=raw.get("gaf_contractor_type") or "Residential",
        address=raw.get("gaf_address"),
        street=street_from_address(raw.get("gaf_address"), city, state, postal),
        city=city,
        state=state,
        postal_code=postal,
        country=raw.get("gaf_f_country_code"),
        phone=_clean_phone(raw.get("gaf_phone")),
        latitude=raw.get("gaf_latitude"),
        longitude=raw.get("gaf_longitude"),
        rating=float(rating) if rating and review_count > 0 else None,
        review_count=review_count,
        profile_url=raw.get("uri") or result.get("clickUri") or result.get("uri"),
        image_url=image,
        tier=tier_from_codes(codes),
        certifications=certs,
        designation_codes=codes,
        specialties=specialties,
        presidents_club_stars=presidents_club_stars(raw, codes),
        gaf_leads_enrolled=bool(raw.get("gaf_enrolled_in_gaf_leads")),
        google_place_id=raw.get("gaf_google_place_id") or None,
        raw=raw,
    )


def _parse_dt(s: Any) -> datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        # Python <3.11 can't parse 'Z' or >6 fractional digits; normalise both.
        s2 = re.sub(r"(\.\d{6})\d+", r"\1", s.replace("Z", "+00:00"))
        return datetime.fromisoformat(s2)
    except ValueError:
        return None


def normalize_employees(value: str | None) -> str | None:
    """GAF renders the same bucket several ways: '1 - 5', '1-5', 'None'."""
    if not value:
        return None
    v = " ".join(value.split())
    if v.lower() in {"none", "n/a", "na", "-", "unknown"}:
        return None
    return re.sub(r"\s*-\s*", "-", v)


def parse_profile_html(html: str, gaf_id: str) -> ContractorProfile:
    tree = LexborHTMLParser(html)
    legal_name = description = None
    for node in tree.css('script[type="application/ld+json"]'):
        try:
            data = json.loads(node.text())
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("@type") == "LocalBusiness":
            legal_name = (data.get("name") or "").strip() or None
            description = (data.get("description") or "").strip() or None
            break

    details: dict[str, str] = {}
    for info in tree.css(".contractor-details__info"):
        title = info.css_first(".contractor-details__title")
        desc = info.css_first(".contractor-details__description")
        if title and desc:
            details[" ".join(title.text().split())] = " ".join(desc.text().split())
    in_business_since = None
    years_txt = details.get("Years in Business", "")
    m = re.search(r"(18|19|20)\d{2}", years_txt)
    if m:
        in_business_since = int(m.group(0))

    distinctions: list[str] = []
    for t in tree.css(".certifications-block__list .certifications-content-item__title"):
        name = " ".join(t.text().split())
        if name and name not in distinctions:
            distinctions.append(name)

    reviews: list[Review] = []
    rnode = tree.css_first('[data-module="contractor-reviews"]')
    if rnode is not None and rnode.attributes.get("data-reviews"):
        try:
            for r in json.loads(rnode.attributes["data-reviews"]):
                reviews.append(
                    Review(
                        author=r.get("AuthorName"),
                        rating=r.get("Rating"),
                        text=r.get("Text"),
                        published_at=_parse_dt(r.get("PublishTime")),
                        source=r.get("ReviewSource"),
                    )
                )
        except (json.JSONDecodeError, TypeError):
            pass

    return ContractorProfile(
        gaf_id=gaf_id,
        legal_name=legal_name,
        description=description,
        in_business_since=in_business_since,
        employees_range=normalize_employees(details.get("Number of Employees")),
        distinctions=distinctions,
        reviews=reviews,
        details=details,
    )


def looks_blocked(html: str) -> bool:
    """Akamai denial pages are tiny and say 'Access Denied'."""
    return len(html) < 5000 and "Access Denied" in html
