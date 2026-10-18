"""FMCSA Company Census (USDOT registrations) -> company officers, email, fleet size.

Any contractor running a truck >10,001 lb GVWR across state lines (NJ<->NY trips
count) must hold a USDOT number and file an MCS-150 listing up to two COMPANY
OFFICERS, phone, e-mail, power units and drivers. That makes it the best free
decision-maker source we found for NJ (research/company_people_data: 101/424
matches at >=0.75, 78 by phone, officer name on 100).

Source: data.transportation.gov dataset az4n-8mr2 (Socrata, open, no key;
robots Crawl-delay 1 -> we keep >=1.2 s between requests).
prepare(): ~11 phone batches (`phone IN (...) OR cell_phone IN (...)`) + one
keyword query for NY/NJ construction-like names, then local matching.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from ..http import HttpClient
from ..models import Contact, EnrichmentResult
from .base import Enricher, LeadContext
from .matching import match_confidence, name_similarity, normalize_name, phone_digits, zip5

log = logging.getLogger(__name__)

HOST = "data.transportation.gov"
URL = f"https://{HOST}/resource/az4n-8mr2.json"
DATASET_PAGE = "https://data.transportation.gov/d/az4n-8mr2"
COLS = ("dot_number,legal_name,dba_name,phy_street,phy_city,phy_state,phy_zip,phone,cell_phone,email_address,"
        "company_officer_1,company_officer_2,power_units,truck_units,total_drivers,mcs150_date,add_date,status_code,"
        "carrier_operation,business_org_desc")
KEYWORDS = ("ROOF", "CONSTRUC", "CONTRACT", "SIDING", "HOME IMPROV", "REMODEL", "EXTERIOR", "RENOVAT", "BUILD", "GUTTER")
MIN_CONFIDENCE = 0.75
PAGE = 50_000


def _title(name: str) -> str:
    return " ".join(w.capitalize() if w.isupper() or w.islower() else w for w in name.split())


def score(contractor: dict[str, Any], row: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    ph = phone_digits(contractor.get("phone"))
    pm = bool(ph and ph in {phone_digits(row.get("phone")), phone_digits(row.get("cell_phone"))})
    names = [contractor.get(k) for k in ("legal_name", "name", "dba") if contractor.get(k)]
    ns = max((name_similarity(n, x) for n in names for x in (row.get("legal_name"), row.get("dba_name")) if x),
             default=0.0)
    same_zip = zip5(contractor.get("postal_code")) is not None and zip5(contractor.get("postal_code")) == zip5(row.get("phy_zip"))
    same_city = bool(contractor.get("city")) and (contractor.get("city") or "").lower() == (row.get("phy_city") or "").lower()
    conf = match_confidence(name_sim=ns, phone_match=pm, same_zip=same_zip, same_city=same_city)
    core = normalize_name(contractor.get("legal_name") or contractor.get("name"))
    if not pm and len(core) <= 3:  # very short names ("ABC") collide too easily without a phone match
        conf = min(conf, 0.5)
    return conf, {"phone_match": pm, "name_sim": round(ns, 2), "same_zip": same_zip, "same_city": same_city}


class FmcsaEnricher(Enricher):
    name = "fmcsa"

    def __init__(self, settings):
        super().__init__(settings)
        self.rows: dict[str, dict[str, Any]] = {}
        self.by_phone: dict[str, set[str]] = defaultdict(set)
        self.by_token: dict[str, set[str]] = defaultdict(set)

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self.settings.socrata_app_token:
            h["X-App-Token"] = self.settings.socrata_app_token
        return h

    async def _query(self, http: HttpClient, where: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        offset = 0
        while True:
            resp = await http.get(URL, params={"$select": COLS, "$where": where, "$order": "dot_number",
                                               "$limit": PAGE, "$offset": offset},
                                  headers=self._headers(), timeout=180)
            page = resp.json()
            out += page
            if len(page) < PAGE:
                return out
            offset += PAGE

    async def prepare(self, http: HttpClient, contractors: list[dict[str, Any]]) -> None:
        http.set_host_interval(HOST, 1.2)
        phones = sorted({p for c in contractors if (p := phone_digits(c.get("phone")))})
        for i in range(0, len(phones), 40):
            lst = ",".join(f"'{p}'" for p in phones[i : i + 40])
            for r in await self._query(http, f"phone in({lst}) OR cell_phone in({lst})"):
                self.rows[r["dot_number"]] = r
        cond = " OR ".join(f"upper(legal_name) like '%{k}%' OR upper(dba_name) like '%{k}%'" for k in KEYWORDS)
        states = sorted({(c.get("state") or "").upper() for c in contractors if c.get("state")}) or ["NJ", "NY"]
        state_list = ",".join(f"'{s}'" for s in states)
        for r in await self._query(http, f"phy_state in({state_list}) AND ({cond})"):
            self.rows.setdefault(r["dot_number"], r)
        for k, r in self.rows.items():
            for x in (r.get("phone"), r.get("cell_phone")):
                if (p := phone_digits(x)):
                    self.by_phone[p].add(k)
            for x in (r.get("legal_name"), r.get("dba_name")):
                for t in normalize_name(x).split():
                    self.by_token[t].add(k)
        log.info("fmcsa: loaded %d carrier rows (%d phones)", len(self.rows), len(self.by_phone))

    def candidates(self, contractor: dict[str, Any]) -> set[str]:
        cand = set(self.by_phone.get(phone_digits(contractor.get("phone")) or "-", set()))
        for n in (contractor.get("legal_name"), contractor.get("name"), contractor.get("dba")):
            for t in normalize_name(n).split():
                hits = self.by_token.get(t, set())
                if len(hits) < 2000:  # skip tokens too common to discriminate
                    cand |= hits
        return cand

    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        best: tuple[float, dict[str, Any], dict[str, Any]] | None = None
        for k in self.candidates(ctx.contractor):
            conf, ev = score(ctx.contractor, self.rows[k])
            if best is None or conf > best[0]:
                best = (conf, self.rows[k], ev)
        if best is None or best[0] < MIN_CONFIDENCE:
            return self.no_match({"best_confidence": round(best[0], 3) if best else None})
        conf, r, ev = best
        officers = [_title(o) for o in (r.get("company_officer_1"), r.get("company_officer_2")) if o and o.strip()]
        email = (r.get("email_address") or "").strip().lower() or None
        data = {
            "dot_number": r.get("dot_number"),
            "legal_name": r.get("legal_name"),
            "dba_name": r.get("dba_name"),
            "address": ", ".join(x for x in (r.get("phy_street"), r.get("phy_city"), r.get("phy_state"), r.get("phy_zip")) if x),
            "phone": r.get("phone"),
            "cell_phone": r.get("cell_phone"),
            "email": email,
            "officers": officers,
            "power_units": r.get("power_units"),
            "total_drivers": r.get("total_drivers"),
            "mcs150_date": r.get("mcs150_date"),
            "status_code": r.get("status_code"),
            "carrier_operation": r.get("carrier_operation"),
            "business_org": r.get("business_org_desc"),
            "match_evidence": ev,
        }
        url = f"{DATASET_PAGE}?dot_number={r.get('dot_number')}"
        contacts = [
            Contact(name=o, title="Company officer (FMCSA MCS-150)", email=email if i == 0 else None,
                    phone=r.get("cell_phone") if i == 0 else None, source="fmcsa", source_url=url,
                    confidence=round(conf * 0.9, 3))
            for i, o in enumerate(officers)
        ]
        return self.ok(data, conf, contacts=contacts, source_urls=[url])
