"""FMCSA Company Census (USDOT registrations) -- officers, contact e-mail and fleet size.

Any contractor that runs a commercial vehicle (>10,000 lb GVWR, or any truck crossing a
state line -- routine between NJ and NY) must hold a USDOT number and refile form MCS-150
every two years. The public census file lists, per registration: legal/DBA name, physical
address, phone + cell phone, contact e-mail, up to two COMPANY OFFICERS, power units
(trucks/tractors) and drivers. For a roofing distributor's reps that is:

  * decision-maker names (company_officer_1/2 -- usually the owner/president),
  * a direct e-mail and often a cell phone,
  * a size proxy (trucks, drivers) and recency (MCS-150 filing date, active/inactive).

Source: data.transportation.gov Socrata dataset az4n-8mr2 (keyless open data, ~2M carriers;
robots.txt Crawl-delay 1; use SOCRATA_APP_TOKEN for higher rate limits). Matching:

  1. `prepare()` pulls every census row whose phone or cell phone equals one of the
     contractors' GAF phones (batched IN-lists, ~11 requests for 424 contractors);
  2. per contractor without a phone hit, a name query on legal/DBA name restricted to the
     contractor's state + NY/NJ;
  3. candidates are scored with the strict registry helpers: phone match -> 0.9;
     otherwise exact strict name (>= 0.97) on a distinctive name plus same ZIP/city.

Measured on the 424 GAF contractors near 10013 (research/company_people_data): 99 matched
(78 by phone, 21 by name+ZIP/city); 98 with an officer name, 97 with an e-mail, 86 active.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..http import HttpClient
from ..models import Contact, EnrichmentResult
from ._registry_match import (
    compare_locality,
    distinctive_tokens,
    looks_like_person,
    strict_similarity,
    strict_tokens,
    title_case_person,
)
from .base import Enricher, LeadContext
from .matching import phone_digits

log = logging.getLogger(__name__)

DATASET_ID = "az4n-8mr2"
DATASET_URL = f"https://data.transportation.gov/resource/{DATASET_ID}.json"
COLUMNS = (
    "dot_number,legal_name,dba_name,phy_street,phy_city,phy_state,phy_zip,phone,cell_phone,email_address,"
    "company_officer_1,company_officer_2,power_units,truck_units,total_drivers,total_cdl,mcs150_date,add_date,"
    "status_code,carrier_operation,business_org_desc,crgo_construct,crgo_bldgmat,mcs150_mileage,mcs150_mileage_year"
)
PHONE_BATCH = 40
NAME_LIMIT = 200
ACCEPT = 0.8
PERSONAL_EMAIL = re.compile(
    r"@(gmail|yahoo|aol|hotmail|outlook|live|msn|icloud|me|verizon|optonline|optimum|comcast|att|sbcglobal|"
    r"frontiernet|earthlink|ymail|protonmail)\.", re.I)


def record_url(dot_number: str) -> str:
    return f"{DATASET_URL}?dot_number={dot_number}"


def safer_url(dot_number: str) -> str:
    """Human-readable FMCSA SAFER company snapshot."""
    return ("https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot"
            f"&query_param=USDOT&query_string={dot_number}")


def _int(v: Any) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _date(v: str | None) -> str | None:
    """'20260105' or '2026-01-05T00:00:00.000' -> '2026-01-05'."""
    if not v:
        return None
    d = re.sub(r"\D", "", v)[:8]
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else None


def name_pattern(name: str | None) -> str | None:
    """SoQL LIKE pattern on distinctive words ('Multi Roofing System Inc' -> '%MULTI%SYSTEM%').

    All-generic names ("Roofing Company") return None: a name-only lookup would be noise.
    """
    toks = distinctive_tokens(name)
    if not toks:
        return None
    words = [re.sub(r"[^A-Z0-9]", "", t.upper()) for t in toks]
    words = [w for w in words if w]
    return "%" + "%".join(words) + "%" if words else None


def score(contractor: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    """Same-business probability of a census row for a GAF contractor + evidence."""
    ph = phone_digits(contractor.get("phone"))
    phone_match = bool(ph and ph in {phone_digits(row.get("phone")), phone_digits(row.get("cell_phone"))})
    ns, used = 0.0, None
    for n in (contractor.get("legal_name"), contractor.get("name"), contractor.get("dba")):
        for f in ("legal_name", "dba_name"):
            if n and row.get(f):
                s = strict_similarity(n, row[f])
                if s > ns:
                    ns, used = s, n
    loc = compare_locality(contractor, city=row.get("phy_city"), state=row.get("phy_state"), zip_code=row.get("phy_zip"))
    reasons = [f"name={ns:.2f}", f"loc={loc.describe()}"]
    if phone_match:
        conf = 0.9 + (0.05 if ns >= 0.85 else 0.0) + (0.03 if loc.bonus() >= 0.2 else 0.0)
        reasons.insert(0, "phone")
    elif ns >= 0.97 and used and distinctive_tokens(used) and loc.bonus() >= 0.2:
        conf = 0.85
    elif ns >= 0.97 and used and distinctive_tokens(used) and loc.bonus() >= 0.1:
        conf = 0.65  # same area only -- below ACCEPT, reported as a near miss
    else:
        conf = 0.0
    if conf and row.get("status_code") and row["status_code"] != "A":
        reasons.append("inactive_registration")
    return {"confidence": round(min(conf, 0.97), 3), "phone_match": phone_match, "name_similarity": round(ns, 3),
            "locality": loc.describe(), "reasons": reasons}


class FmcsaCensusEnricher(Enricher):
    name = "fmcsa_census"
    input_fields = ("name", "legal_name", "dba", "phone", "city", "state", "postal_code")

    def __init__(self, settings):
        super().__init__(settings)
        self._by_phone: dict[str, list[dict[str, Any]]] = {}
        self._name_cache: dict[str, list[dict[str, Any]]] = {}
        self._prepared = False

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json"}
        token = getattr(self.settings, "socrata_app_token", None)
        if token:
            h["X-App-Token"] = token
        return h

    async def query(self, http: HttpClient, where: str, limit: int = 1000) -> list[dict[str, Any]]:
        params = {"$select": COLUMNS, "$where": where, "$limit": str(limit), "$offset": "0", "$order": "dot_number"}
        resp = await http.get(DATASET_URL, params=params, headers=self._headers())
        rows = resp.json()
        if not isinstance(rows, list):
            raise ValueError(f"unexpected FMCSA census response: {str(rows)[:200]}")
        return rows

    def _index_phone_rows(self, rows: list[dict[str, Any]]) -> None:
        for r in rows:
            for f in ("phone", "cell_phone"):
                p = phone_digits(r.get(f))
                if p:
                    lst = self._by_phone.setdefault(p, [])
                    if all(x.get("dot_number") != r.get("dot_number") for x in lst):
                        lst.append(r)

    async def prepare(self, http: HttpClient, contractors: list[dict[str, Any]]) -> None:
        phones = sorted({p for c in contractors if (p := phone_digits(c.get("phone")))})
        for i in range(0, len(phones), PHONE_BATCH):
            lst = ",".join(f"'{p}'" for p in phones[i:i + PHONE_BATCH])
            self._index_phone_rows(await self.query(http, f"phone in({lst}) OR cell_phone in({lst})", limit=5000))
        self._prepared = True

    async def _name_rows(self, http: HttpClient, ctx: LeadContext) -> tuple[list[dict[str, Any]], list[str]]:
        states = sorted({(ctx.get("state") or "").upper(), "NY", "NJ"} - {""})
        st = ",".join(f"'{s}'" for s in states)
        rows: list[dict[str, Any]] = []
        urls: list[str] = []
        for n in ctx.names():
            pat = name_pattern(n)
            if not pat or "'" in pat:
                continue
            if pat not in self._name_cache:
                where = f"phy_state in({st}) AND (upper(legal_name) like '{pat}' OR upper(dba_name) like '{pat}')"
                self._name_cache[pat] = await self.query(http, where, limit=NAME_LIMIT)
            rows += self._name_cache[pat]
            urls.append(f"{DATASET_URL}?$where=upper(legal_name) like '{pat}'")
        return rows, urls

    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        c = ctx.contractor
        ph = phone_digits(c.get("phone"))
        urls: list[str] = []
        if ph and not self._prepared:  # enrich() called without prepare() (single-lead runs)
            self._index_phone_rows(await self.query(http, f"phone in('{ph}') OR cell_phone in('{ph}')"))
        cands = {r["dot_number"]: r for r in self._by_phone.get(ph or "-", []) if r.get("dot_number")}
        scored = [(r, score(c, r)) for r in cands.values()]
        if not any(ev["confidence"] >= ACCEPT for _, ev in scored):
            rows, urls = await self._name_rows(http, ctx)
            for r in rows:
                if r.get("dot_number") and r["dot_number"] not in cands:
                    cands[r["dot_number"]] = r
                    scored.append((r, score(c, r)))
        # Prefer: confidence, then an active registration, then the most recent MCS-150 filing.
        scored.sort(key=lambda x: (x[1]["confidence"], x[0].get("status_code") == "A",
                                   _date(x[0].get("mcs150_date")) or ""), reverse=True)
        if not scored or scored[0][1]["confidence"] < ACCEPT:
            return self.no_match(
                data={"candidates_checked": len(scored),
                      "near_misses": [{"dot_number": r.get("dot_number"), "legal_name": r.get("legal_name"),
                                       "confidence": ev["confidence"], "reasons": ev["reasons"]}
                                      for r, ev in scored[:3] if ev["confidence"] > 0]},
                source_urls=urls)
        row, ev = scored[0]
        return self._result(row, ev, urls, others=[r for r, e in scored[1:] if e["confidence"] >= ACCEPT])

    def _result(self, row: dict[str, Any], ev: dict[str, Any], urls: list[str],
                others: list[dict[str, Any]]) -> EnrichmentResult:
        dot = row["dot_number"]
        conf = ev["confidence"]
        email = (row.get("email_address") or "").strip().lower() or None
        officers = []
        for f in ("company_officer_1", "company_officer_2"):
            raw = (row.get(f) or "").strip()
            person = title_case_person(raw) if raw and looks_like_person(raw, row.get("legal_name")) else None
            if person and person.lower() not in {o.lower() for o in officers}:
                officers.append(person)
        addr = ", ".join(x for x in (row.get("phy_street"), row.get("phy_city"),
                                     " ".join(y for y in (row.get("phy_state"), row.get("phy_zip")) if y)) if x)
        data = {
            "dot_number": dot,
            "legal_name": row.get("legal_name"),
            "dba_name": row.get("dba_name"),
            "status": "active" if row.get("status_code") == "A" else ("inactive" if row.get("status_code") else None),
            "officers": officers,
            "email": email,
            "email_domain": email.split("@", 1)[1] if email and "@" in email else None,
            "email_is_personal": bool(email and PERSONAL_EMAIL.search(email)),
            "phone": row.get("phone"),
            "cell_phone": row.get("cell_phone"),
            "address": addr or None,
            "power_units": _int(row.get("power_units")),
            "truck_units": _int(row.get("truck_units")),
            "drivers": _int(row.get("total_drivers")),
            "cdl_drivers": _int(row.get("total_cdl")),
            "mcs150_date": _date(row.get("mcs150_date")),
            "registered_date": _date(row.get("add_date")),
            "mileage": _int(row.get("mcs150_mileage")),
            "mileage_year": _int(row.get("mcs150_mileage_year")),
            "business_org": row.get("business_org_desc"),
            "hauls_construction_cargo": (row.get("crgo_construct") or "").upper() == "X",
            "hauls_building_materials": (row.get("crgo_bldgmat") or "").upper() == "X",
            "other_matching_dot_numbers": [r.get("dot_number") for r in others][:5],
            "snapshot_url": safer_url(dot),
            "match_evidence": ev,
        }
        url = record_url(dot)
        contacts = []
        for i, person in enumerate(officers):
            contacts.append(Contact(
                name=person,
                title="Company officer (FMCSA MCS-150 filing)",
                # The census e-mail/cell are the registrant's contact details; in small firms the
                # first officer is almost always the filer, so attach them to officer 1 only.
                email=email if i == 0 else None,
                phone=(row.get("cell_phone") or None) if i == 0 else None,
                source=self.name, source_url=url,
                confidence=round(conf * (0.9 if i == 0 else 0.8), 3),
            ))
        return self.ok(data, conf, contacts=contacts, source_urls=[url] + urls)
