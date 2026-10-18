"""Domain models shared by sources, enrichers, storage and the CLI."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Tier(str, Enum):
    """GAF residential certification tier, highest first."""

    MASTER_ELITE = "master_elite"
    CERTIFIED_PLUS = "certified_plus"
    CERTIFIED = "certified"
    NONE = "none"


TIER_RANK = {Tier.MASTER_ELITE: 3, Tier.CERTIFIED_PLUS: 2, Tier.CERTIFIED: 1, Tier.NONE: 0}


class SearchArea(BaseModel):
    postal_code: str
    country: str = "US"
    radius_miles: float = 25
    latitude: float
    longitude: float
    geocoder: str = "unknown"


class Contractor(BaseModel):
    """A contractor as listed in GAF's locator index (Coveo)."""

    gaf_id: str
    name: str
    dba: str | None = None
    contractor_type: str = "Residential"
    address: str | None = None
    street: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    country: str | None = None
    phone: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    rating: float | None = None
    review_count: int = 0
    profile_url: str
    image_url: str | None = None
    tier: Tier = Tier.NONE
    certifications: list[str] = Field(default_factory=list)  # human-readable, e.g. "GAF Master Elite® - Certification"
    designation_codes: list[str] = Field(default_factory=list)  # raw, e.g. "MASTER_ELITE^_^RESIDENTIAL^_^C"
    specialties: list[str] = Field(default_factory=list)  # e.g. SOLAR, METAL, FORTIFIED
    presidents_club_stars: int = 0
    gaf_leads_enrolled: bool = False
    google_place_id: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class SearchHit(BaseModel):
    """Query-relative facts: distance only makes sense relative to a search origin."""

    gaf_id: str
    distance_miles: float | None
    rank: int  # 1-based position in distance-sorted results
    gaf_recommended: bool = False  # present in GAF's own "Most Relevant" pipeline result
    gaf_recommended_rank: int | None = None


class Review(BaseModel):
    author: str | None = None
    rating: float | None = None
    text: str | None = None
    published_at: datetime | None = None
    source: str | None = None


class ContractorProfile(BaseModel):
    """Extra facts only available on the contractor's GAF profile page."""

    gaf_id: str
    legal_name: str | None = None
    description: str | None = None
    in_business_since: int | None = None
    employees_range: str | None = None
    distinctions: list[str] = Field(default_factory=list)
    reviews: list[Review] = Field(default_factory=list)
    details: dict[str, str] = Field(default_factory=dict)  # every label/value pair under "Details"


class Contact(BaseModel):
    """A person at the contractor (decision-maker candidate)."""

    name: str
    title: str | None = None
    email: str | None = None
    phone: str | None = None
    source: str
    source_url: str | None = None
    confidence: float = 0.5


class EnrichmentStatus(str, Enum):
    OK = "ok"
    NO_MATCH = "no_match"
    SKIPPED = "skipped"
    ERROR = "error"


class EnrichmentResult(BaseModel):
    """Output of one enricher for one contractor. Stored verbatim with provenance."""

    source: str
    status: EnrichmentStatus
    confidence: float = 0.0  # how sure we are this record is the same business
    data: dict[str, Any] = Field(default_factory=dict)
    contacts: list[Contact] = Field(default_factory=list)
    website: str | None = None  # a discovered company website, if any
    source_urls: list[str] = Field(default_factory=list)
    error: str | None = None
    fetched_at: datetime | None = None
