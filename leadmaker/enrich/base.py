"""Enricher contract.

An enricher looks a contractor up in one secondary source and returns an
`EnrichmentResult` (raw facts + match confidence + provenance). Enrichers are
independent plug-ins; the orchestrator (leadmaker.pipeline.enrich) handles
ordering (`depends_on`), concurrency, TTL-based skipping and persistence.

Rules for implementers
  * Never raise for "not found" -- return `no_match(...)`. Raise (or return
    `error(...)`) only for genuine failures; the orchestrator records and retries
    errors on the next run.
  * `confidence` is the probability the matched record is the *same business*
    (0..1). Use `leadmaker.enrich.matching` helpers; a phone-number match is the
    strongest signal, name similarity + locality next.
  * Put source-specific facts in `data` (JSON-serialisable), people in
    `contacts`, a company website (if this source knows one) in `website`, and
    every URL you read in `source_urls`.
  * Bulk sources should load once in `prepare()` and match in memory.

Data contracts consumed by downstream enrichers / tagging (keys in `data`):
  google_places:      website, google_maps_url, rating, user_rating_count, business_status,
                      primary_type, types, phone, formatted_address, opening_hours
  osm:                website, email, phone, osm_url, opening_hours, tags
  ny_dos:             dos_id, entity_name, entity_type, initial_filing_date, county,
                      chairman_name, process_name, process_address
  nyc_dcwp:           license_number, license_status, license_creation_date,
                      license_expiration_date, business_name, dba, contact_phone, address
  website_discovery:  website, candidates[{url, score, evidence}], method
  website_crawl:      pages[{url, title, text}], emails, phones, social{platform:url},
                      services[], service_areas[], founded_year, team_size_hint,
                      leadership[{name, title, evidence}]
  llm_extract:        decision_makers[{name, title, evidence, verified_in, confidence}],
                      services[] (taxonomy keys), llm_services[], materials[], brands_mentioned[],
                      company_size, residential_commercial_mix, summary, custom_slots{key: value|null},
                      provider, model, prompt_version
  bbb:                bbb_id, profile_url, bbb_name, alt_names, rating, accredited, business_start,
                      years_in_business, entity_type, employees, out_of_business, categories,
                      services[], licenses[], website, phone, address, complaints_*, people[]
"""

from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar

from ..config import Settings
from ..http import HttpClient
from ..models import Contact, EnrichmentResult, EnrichmentStatus

def _json_hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


# When several sources know a website, prefer the verified one.
WEBSITE_PRIORITY = ("website_discovery", "google_places", "osm", "bbb")


@dataclass
class LeadContext:
    """What an enricher knows about a contractor when it runs."""

    contractor: dict[str, Any]  # a row of the `contractors` table
    prior: dict[str, EnrichmentResult] = field(default_factory=dict)  # earlier enrichers' results

    def get(self, key: str, default: Any = None) -> Any:
        return self.contractor.get(key, default)

    @property
    def gaf_id(self) -> str:
        return self.contractor["gaf_id"]

    def names(self) -> list[str]:
        """Candidate business names, most-official first (legal name, listing name, DBA)."""
        out: list[str] = []
        for k in ("legal_name", "name", "dba"):
            v = (self.contractor.get(k) or "").strip()
            if v and v.lower() not in {n.lower() for n in out}:
                out.append(v)
        return out

    def ok_prior(self, source: str) -> EnrichmentResult | None:
        r = self.prior.get(source)
        return r if r is not None and r.status == EnrichmentStatus.OK else None

    def best_website(self) -> str | None:
        for src in WEBSITE_PRIORITY:
            r = self.ok_prior(src)
            if r is not None and r.website:
                return r.website
        return self.contractor.get("website")


# Contractor fields that identify the business; a change re-triggers enrichment.
DEFAULT_INPUT_FIELDS = (
    "name", "legal_name", "dba", "phone", "address", "city", "state", "postal_code",
    "latitude", "longitude", "google_place_id",
)


class Enricher(ABC):
    name: ClassVar[str]
    depends_on: ClassVar[tuple[str, ...]] = ()
    # Override to widen/narrow what counts as "input changed" for this source.
    input_fields: ClassVar[tuple[str, ...]] = DEFAULT_INPUT_FIELDS

    def input_hash(self, ctx: "LeadContext") -> str:
        """Fingerprint of everything this enricher reads: identity fields + dependency outputs.

        Incremental updates: a stored result is reused inside its TTL only while this
        hash is unchanged (e.g. a newly discovered website re-triggers website_crawl).
        """
        deps = []
        for d in self.depends_on:
            r = ctx.prior.get(d)
            deps.append(None if r is None else (r.status.value, r.website, _json_hash(r.data)))
        return _json_hash([self.name, [ctx.contractor.get(f) for f in self.input_fields], deps])

    def __init__(self, settings: Settings):
        self.settings = settings

    def is_enabled(self) -> tuple[bool, str]:
        """(enabled, reason-if-disabled). Override for key-gated sources."""
        return True, ""

    def applies_to(self, ctx: LeadContext) -> bool:
        """False -> recorded as SKIPPED (e.g. a NY-only registry for an NJ contractor)."""
        return True

    async def prepare(self, http: HttpClient, contractors: list[dict[str, Any]]) -> None:
        """Optional bulk preload before per-contractor calls."""

    @abstractmethod
    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult: ...

    # Convenience constructors -------------------------------------------------
    def ok(
        self,
        data: dict[str, Any],
        confidence: float,
        *,
        contacts: list[Contact] | None = None,
        website: str | None = None,
        source_urls: list[str] | None = None,
    ) -> EnrichmentResult:
        return EnrichmentResult(
            source=self.name, status=EnrichmentStatus.OK, confidence=round(confidence, 3), data=data,
            contacts=contacts or [], website=website, source_urls=source_urls or [],
        )

    def no_match(self, data: dict[str, Any] | None = None, source_urls: list[str] | None = None) -> EnrichmentResult:
        return EnrichmentResult(
            source=self.name, status=EnrichmentStatus.NO_MATCH, data=data or {}, source_urls=source_urls or []
        )

    def skipped(self, reason: str) -> EnrichmentResult:
        return EnrichmentResult(source=self.name, status=EnrichmentStatus.SKIPPED, data={"reason": reason})

    def error(self, message: str) -> EnrichmentResult:
        return EnrichmentResult(source=self.name, status=EnrichmentStatus.ERROR, error=message[:2000])
