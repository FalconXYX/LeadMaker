"""NYC Department of Consumer & Worker Protection (DCWP) Home Improvement Contractor licenses.

Anyone doing home-improvement work in the five boroughs -- including NJ/Long Island
firms -- must hold a DCWP HIC license, so "has an active NYC HIC license" is a strong
signal that a contractor actively works NYC jobs (and the license gives a legal name,
phone and address).

Source: NYC Open Data "Issued Licenses" (Socrata, keyless), filtered to
business_category = 'Home Improvement Contractor' (~19k rows, one category -- there
is no separate salesperson category in this dataset). The whole category is
bulk-loaded once in `prepare()` and matched in memory:

  * phone match (GAF phone == license contact_phone) -- strongest signal;
  * otherwise a strict name match (legal forms removed, trade words kept) against
    business_name / dba_trade_name >= 0.9, adjusted by locality (zip/city/distance),
    token rarity within the HIC corpus and legal-form agreement.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections import Counter, defaultdict
from typing import Any

from ..http import HttpClient
from ..models import Contact, EnrichmentResult
from ._registry_match import (
    compare_locality,
    distinctive_tokens,
    legal_form,
    strict_key,
    strict_similarity,
    title_case_person,
)
from .base import Enricher, LeadContext
from .matching import haversine_miles, name_similarity, phone_digits

log = logging.getLogger(__name__)

DATASET_ID = "w7w3-xahh"
DATASET_URL = f"https://data.cityofnewyork.us/resource/{DATASET_ID}.json"
HIC_CATEGORY = "Home Improvement Contractor"
PAGE_SIZE = 5000
MAX_PAGES = 40  # 200k rows: generous safety stop (category has ~19k)
ACCEPT = 0.6
NAME_MIN = 0.9

SELECT_FIELDS = (
    "license_nbr", "business_name", "dba_trade_name", "business_unique_id", "business_category",
    "license_type", "license_status", "license_creation_date", "lic_expir_dd", "contact_phone",
    "address_building", "address_street_name", "address_street_name_2", "unit_type", "apt_suite",
    "address_city", "address_state", "address_zip", "address_borough", "latitude", "longitude",
)
STATUS_RANK = {"Active": 3, "Expired": 1, "Failed to Renew": 1, "Suspended": 0, "Surrendered": 0,
               "Revoked": 0, "Voided": 0, "Out of Business": 0}


def license_url(license_number: str) -> str:
    return f"{DATASET_URL}?license_nbr={license_number}"


def _date(v: str | None) -> str | None:
    return v[:10] if v else None


def _float(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and f != 0 else None


def format_address(r: dict[str, Any]) -> str | None:
    street = " ".join(x for x in (r.get("address_building"), r.get("address_street_name")) if x)
    if r.get("address_street_name_2"):
        street = f"{street} & {r['address_street_name_2']}" if street else r["address_street_name_2"]
    unit = " ".join(x for x in (r.get("unit_type"), r.get("apt_suite")) if x)
    state_zip = " ".join(x for x in (r.get("address_state"), r.get("address_zip")) if x)
    parts = [p for p in (street, unit, r.get("address_city"), state_zip) if p]
    return ", ".join(parts) or None


def _is_individual(r: dict[str, Any]) -> bool:
    """Sole proprietors are listed as 'LAST, FIRST' with the trade name in dba_trade_name."""
    bn = r.get("business_name") or ""
    return bn.count(",") == 1 and not legal_form(bn) and len(bn.split()) <= 4


class HicIndex:
    """In-memory indexes over HIC license rows."""

    def __init__(self, rows: list[dict[str, Any]]):
        self.rows = rows
        self.by_phone: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.by_token: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self.token_df: Counter[str] = Counter()
        for r in rows:
            p = phone_digits(r.get("contact_phone"))
            if p:
                self.by_phone[p].append(r)
            seen: set[str] = set()
            for name in self.names_of(r):
                k = strict_key(name)
                if k:
                    self.by_key[k].append(r)
                for t in distinctive_tokens(name):
                    if t not in seen:
                        seen.add(t)
                        self.by_token[t].append(r)
            self.token_df.update(seen)

    @staticmethod
    def names_of(r: dict[str, Any]) -> list[str]:
        out = []
        if r.get("business_name") and not _is_individual(r):
            out.append(r["business_name"])
        if r.get("dba_trade_name"):
            out.append(r["dba_trade_name"])
        if not out and r.get("business_name"):
            out.append(r["business_name"])
        return out

    def name_candidates(self, name: str) -> list[dict[str, Any]]:
        """Rows sharing the exact strict key, or the rarest distinctive token."""
        out: dict[int, dict[str, Any]] = {id(r): r for r in self.by_key.get(strict_key(name), [])}
        toks = sorted(distinctive_tokens(name), key=lambda t: self.token_df.get(t, 0))
        for t in toks[:2]:
            hits = self.by_token.get(t, [])
            if len(hits) <= 400:
                out.update((id(r), r) for r in hits)
        return list(out.values())


class NycDcwpEnricher(Enricher):
    name = "nyc_dcwp"

    def __init__(self, settings):
        super().__init__(settings)
        self.index: HicIndex | None = None
        self._gaf_phone_counts: Counter[str] = Counter()
        self._lock = asyncio.Lock()

    # -- loading ---------------------------------------------------------------
    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self.settings.socrata_app_token:
            h["X-App-Token"] = self.settings.socrata_app_token
        return h

    async def fetch_all(self, http: HttpClient) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for page in range(MAX_PAGES):
            params = {
                "$select": ",".join(SELECT_FIELDS),
                "$where": f"business_category='{HIC_CATEGORY}'",
                "$order": ":id",
                "$limit": str(PAGE_SIZE),
                "$offset": str(page * PAGE_SIZE),
            }
            resp = await http.get(DATASET_URL, params=params, headers=self._headers())
            batch = resp.json()
            if not isinstance(batch, list):
                raise ValueError(f"unexpected DCWP response: {str(batch)[:200]}")
            rows.extend(batch)
            if len(batch) < PAGE_SIZE:
                break
        return rows

    async def prepare(self, http: HttpClient, contractors: list[dict[str, Any]]) -> None:
        self._gaf_phone_counts = Counter(
            p for p in (phone_digits(c.get("phone")) for c in contractors) if p
        )
        async with self._lock:
            if self.index is None:
                rows = await self.fetch_all(http)
                self.index = HicIndex(rows)
                log.info("nyc_dcwp: loaded %d HIC license rows (%d phones)", len(rows), len(self.index.by_phone))

    # -- matching --------------------------------------------------------------
    def score(self, ctx: LeadContext, r: dict[str, Any]) -> dict[str, Any]:
        """Evidence + confidence that license row `r` belongs to the contractor."""
        assert self.index is not None
        c = ctx.contractor
        names = ctx.names()
        lic_names = HicIndex.names_of(r)
        best_sim, best_pair = 0.0, (None, None)
        loose_sim = 0.0
        for n in names:
            for ln in lic_names:
                s = strict_similarity(n, ln)
                if s > best_sim:
                    best_sim, best_pair = s, (n, ln)
                loose_sim = max(loose_sim, name_similarity(n, ln))
        cp = phone_digits(c.get("phone"))
        phone_match = bool(cp and cp == phone_digits(r.get("contact_phone")))
        dist = None
        lat, lon = _float(r.get("latitude")), _float(r.get("longitude"))
        if lat is not None and lon is not None and c.get("latitude") and c.get("longitude"):
            dist = haversine_miles(float(c["latitude"]), float(c["longitude"]), lat, lon)
        loc = compare_locality(c, city=r.get("address_city"), state=r.get("address_state"),
                               zip_code=r.get("address_zip"), distance_miles=dist)

        reasons: list[str] = []
        conf = 0.0
        if phone_match:
            shared = self._gaf_phone_counts.get(cp or "", 0) > 1
            if best_sim >= 0.9 or loose_sim >= 0.95:
                conf = 0.97
            elif best_sim >= 0.6 or loose_sim >= 0.85:
                conf = 0.93
            else:  # e.g. "Abraham Roofing" listed under its corp "M.D.R., Inc." with no DBA
                conf = 0.82
            reasons.append("phone")
            if shared and best_sim < 0.7:
                # The same phone is listed for several GAF contractors: phone alone is ambiguous.
                conf = 0.5
                reasons.append("phone_shared_by_multiple_gaf_contractors")
        if best_sim >= NAME_MIN:
            nconf = 0.45 + (0.15 if best_sim >= 0.97 else 0.05)
            nconf += loc.bonus()
            distinct = distinctive_tokens(best_pair[1])
            dfs = [self.index.token_df.get(t, 0) for t in distinct]
            if not distinct:
                nconf -= 0.2
                reasons.append("generic_name")
            elif min(dfs) <= 3:
                nconf += 0.1
                reasons.append("rare_name")
            elif min(dfs) >= 25:
                nconf -= 0.1
                reasons.append("common_name")
            lf_c = legal_form(best_pair[0]) or legal_form(c.get("legal_name"))
            lf_r = legal_form(best_pair[1]) or legal_form(r.get("business_name"))
            if lf_c and lf_r and lf_c != lf_r:
                nconf -= 0.05
                reasons.append("legal_form_mismatch")
            nconf = min(nconf, 0.9)
            if nconf > conf:
                conf = nconf
            reasons.append(f"name={best_sim:.2f}")
        reasons.append(f"loc={loc.describe()}")
        return {
            "confidence": round(min(conf, 0.99), 3),
            "phone_match": phone_match,
            "name_similarity": round(best_sim, 3),
            "matched_names": list(best_pair),
            "locality": loc.describe(),
            "reasons": reasons,
        }

    def candidates(self, ctx: LeadContext) -> list[dict[str, Any]]:
        assert self.index is not None
        out: dict[int, dict[str, Any]] = {}
        cp = phone_digits(ctx.get("phone"))
        if cp:
            out.update((id(r), r) for r in self.index.by_phone.get(cp, []))
        for n in ctx.names():
            out.update((id(r), r) for r in self.index.name_candidates(n))
        return list(out.values())

    @staticmethod
    def _rank_key(item: tuple[dict[str, Any], dict[str, Any]]) -> tuple:
        r, ev = item
        return (ev["confidence"], STATUS_RANK.get(r.get("license_status") or "", 0),
                r.get("lic_expir_dd") or "", r.get("license_creation_date") or "")

    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        if self.index is None:
            await self.prepare(http, [ctx.contractor])
        assert self.index is not None
        scored = [(r, self.score(ctx, r)) for r in self.candidates(ctx)]
        accepted = sorted((x for x in scored if x[1]["confidence"] >= ACCEPT), key=self._rank_key, reverse=True)
        if not accepted:
            near = sorted(scored, key=lambda x: x[1]["confidence"], reverse=True)[:3]
            return self.no_match(data={
                "candidates_checked": len(scored),
                "near_misses": [
                    {"license_number": r.get("license_nbr"), "business_name": r.get("business_name"),
                     "dba": r.get("dba_trade_name"), "confidence": ev["confidence"], "reasons": ev["reasons"]}
                    for r, ev in near if ev["confidence"] > 0
                ],
            })
        best, ev = accepted[0]
        # Other licenses held by the same business (e.g. an older expired license).
        best_conf = ev["confidence"]
        others = [
            {"license_number": r.get("license_nbr"), "license_status": r.get("license_status"),
             "license_creation_date": _date(r.get("license_creation_date")),
             "license_expiration_date": _date(r.get("lic_expir_dd")), "business_name": r.get("business_name")}
            for r, e in accepted[1:] if e["confidence"] >= best_conf - 0.15
        ]
        lic = best.get("license_nbr")
        holder = best.get("business_name")
        data = {
            "license_number": lic,
            "license_status": best.get("license_status"),
            "license_creation_date": _date(best.get("license_creation_date")),
            "license_expiration_date": _date(best.get("lic_expir_dd")),
            "business_name": holder,
            "dba": best.get("dba_trade_name"),
            "contact_phone": best.get("contact_phone"),
            "address": format_address(best),
            "address_borough": best.get("address_borough"),
            "address_state": best.get("address_state"),
            "license_type": best.get("license_type"),
            "business_unique_id": best.get("business_unique_id"),
            "is_active": best.get("license_status") == "Active",
            "match_method": "+".join(m for m, on in (("phone", ev["phone_match"]),
                                                     ("name", ev["name_similarity"] >= NAME_MIN)) if on),
            "match_evidence": ev,
            "other_licenses": others,
        }
        contacts = []
        if holder and _is_individual(best):
            # Sole proprietor: the licensee *is* the owner.
            person = title_case_person(holder)
            if person:
                contacts.append(Contact(
                    name=person, title="Owner (NYC DCWP sole-proprietor license holder)", source=self.name,
                    phone=best.get("contact_phone"), source_url=license_url(lic or ""),
                    confidence=round(best_conf * 0.9, 3),
                ))
        return self.ok(data, best_conf, contacts=contacts, source_urls=[license_url(lic or "")])
