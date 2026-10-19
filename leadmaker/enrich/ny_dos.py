"""NY Department of State corporation registry ("Active Corporations: Beginning 1800").

Gives a contractor's legal entity (DOS ID, type, formation date, county) and -- for
business corporations -- the *chairman/CEO* name from the biennial statement, i.e. the
owner/decision-maker a sales rep wants. For LLCs (no chairman field) the
service-of-process addressee is frequently the owner and is emitted as a
lower-confidence contact.

Source: data.ny.gov Socrata dataset n9v6-gdp6 (keyless; ~4.3M active entities, names
upper-case). Per contractor we query `current_entity_name like '%TOK1%TOK2%'` built
from each candidate name (GAF legal name first, then listing name / DBA, then the legal
holder name of a matched NYC DCWP license), and score the candidates locally:

  * strict name similarity (legal forms removed, trade words kept);
  * locality of the DOS process / chairman / principal-office addresses vs the
    contractor's GAF address;
  * legal-form agreement (an "LLC" name should be an LLC entity);
  * ambiguity (several same-named entities) and, for non-NY contractors, evidence of a
    foreign registration (jurisdiction = contractor's state, or a DOS address there).
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

from ..http import HttpClient
from ..models import Contact, EnrichmentResult
from ._registry_match import (
    Locality,
    compare_locality,
    distinctive_tokens,
    legal_form,
    looks_like_person,
    strict_similarity,
    title_case_person,
)
from .base import Enricher, LeadContext

log = logging.getLogger(__name__)

DATASET_ID = "n9v6-gdp6"
DATASET_URL = f"https://data.ny.gov/resource/{DATASET_ID}.json"
QUERY_LIMIT = 100
ACCEPT = 0.6
GOOD_ENOUGH = 0.85  # stop trying further name variants once a match this strong is found

STATE_NAMES = {"NY": "NEW YORK", "NJ": "NEW JERSEY", "CT": "CONNECTICUT", "PA": "PENNSYLVANIA",
               "DE": "DELAWARE", "FL": "FLORIDA", "MA": "MASSACHUSETTS"}

_PATTERN_DROP = {"INC", "INCORPORATED", "LLC", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED",
                 "LP", "LLP", "PLLC", "PC", "THE", "AND", "OF", "DBA"}
# Trade words are reduced to stems so CONTRACTOR matches CONTRACTING, ROOFERS matches ROOFING...
_STEMS = (("CONTRACT", "CONTRACT"), ("CONSTRUCT", "CONSTRUCT"), ("ROOF", "ROOF"), ("RENOVAT", "RENOVAT"),
          ("REMODEL", "REMODEL"), ("IMPROVEMENT", "IMPROVEMENT"), ("BUILD", "BUILD"),
          ("ENTERPRISE", "ENTERPRISE"), ("SERVIC", "SERVIC"), ("EXTERIOR", "EXTERIOR"))


def entity_url(dos_id: str) -> str:
    return f"{DATASET_URL}?dos_id={dos_id}"


def _ascii_upper(s: str) -> str:
    s = s.replace("’", "'").replace("‘", "'")
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().upper()


def _pattern_words(name: str | None) -> list[str]:
    if not name:
        return []
    s = _ascii_upper(name)
    s = re.sub(r"\bL\.\s?L\.\s?C\b\.?", " LLC ", s)
    s = s.replace("&", " ").replace("+", " ")
    words = [w for w in re.split(r"[^A-Z0-9]+", s) if w and w not in _PATTERN_DROP]
    out = []
    for w in words:
        for prefix, stem in _STEMS:
            if w.startswith(prefix):
                w = stem
                break
        else:
            if len(w) > 3 and w.endswith("S") and not w.endswith("SS"):
                w = w[:-1]
        out.append(w)
    # "NY" vs "NEW YORK" spelt either way in filings: leave it out of the pattern.
    return [w for w in out if w not in {"NY", "NEW", "YORK"}] or out


def _literal_prefix(name: str) -> str | None:
    """Upper-cased name up to its legal suffix, LIKE-escaped: 'M.D.R., Inc.' -> 'M.D.R.%'."""
    s = _ascii_upper(name).strip()
    for _ in range(2):  # "ROOFING CO., INC." -> "ROOFING"
        s = re.sub(r"[,\s]+(INC|INCORPORATED|LLC|L\.L\.C|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP|PLLC|PC)\.?$",
                   "", s).strip(" ,")
    s = s.strip(" ,")
    if not s or "'" in s or "%" in s or "_" in s:
        return None
    return s + "%"


def like_patterns(name: str | None) -> list[str]:
    """SoQL LIKE patterns for a business name, most specific first.

    Names with a distinctive word -> one contains-pattern ('%MAKABAD%');
    all-generic / initials-only names ("F&F Roofing Co", "M.D.R., Inc.") -> anchored
    prefix patterns only (a contains-pattern would return thousands of rows).
    """
    words = _pattern_words(name)
    if not words or not name:
        return []
    if distinctive_tokens(name):
        return ["%" + "%".join(words) + "%"]
    out = []
    lit = _literal_prefix(name)
    if lit:
        out.append(lit)
    pat = "%".join(words) + "%"
    if pat not in out:
        out.append(pat)
    return out


def _date(v: str | None) -> str | None:
    return v[:10] if v else None


def _addr(row: dict[str, Any], prefix: str) -> str | None:
    parts = [row.get(f"{prefix}_address_1"), row.get(f"{prefix}_address_2"), row.get(f"{prefix}_city")]
    sz = " ".join(x for x in (row.get(f"{prefix}_state"), row.get(f"{prefix}_zip")) if x)
    parts.append(sz)
    s = ", ".join(p.strip() for p in parts if p and p.strip())
    return s or None


def _entity_form(entity_type: str | None) -> str | None:
    et = (entity_type or "").upper()
    if "LIMITED LIABILITY" in et:
        return "llc"
    if "CORPORATION" in et:
        return "corp"
    return None


class NyDosEnricher(Enricher):
    name = "ny_dos"
    # Optional: a matched NYC DCWP license reveals the legal entity behind a trade name
    # ("Long Island Premier Roofing" -> "TUWXR CORP"); only used for ordering.
    depends_on = ("nyc_dcwp",)

    def __init__(self, settings):
        super().__init__(settings)
        self._cache: dict[str, list[dict[str, Any]]] = {}

    def applies_to(self, ctx: LeadContext) -> bool:
        # NY entities plus out-of-state (mostly NJ) firms registered in NY as foreign entities.
        return True

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self.settings.socrata_app_token:
            h["X-App-Token"] = self.settings.socrata_app_token
        return h

    async def query(self, http: HttpClient, pattern: str) -> list[dict[str, Any]]:
        if pattern in self._cache:
            return self._cache[pattern]
        params = {"$where": f"current_entity_name like '{pattern}'", "$limit": str(QUERY_LIMIT)}
        resp = await http.get(DATASET_URL, params=params, headers=self._headers())
        rows = resp.json()
        if not isinstance(rows, list):
            raise ValueError(f"unexpected NY DOS response: {str(rows)[:200]}")
        self._cache[pattern] = rows
        return rows

    # -- name variants -----------------------------------------------------------
    def name_variants(self, ctx: LeadContext) -> list[dict[str, Any]]:
        """[{name, origin, weight, ref}] -- names to look up, most official first."""
        out: list[dict[str, Any]] = []
        seen: set[str] = set()

        def add(name: str | None, origin: str, ref: dict[str, Any] | None = None, weight: float = 1.0) -> None:
            if not name:
                return
            key = " ".join(_pattern_words(name))
            if not key or key in seen:
                return
            seen.add(key)
            out.append({"name": name, "origin": origin, "ref": ref, "weight": weight})

        for k in ("legal_name", "name", "dba"):
            add(ctx.get(k), k)
        dcwp = ctx.ok_prior("nyc_dcwp")
        if dcwp is not None and dcwp.confidence >= 0.6:
            d = dcwp.data
            holder = d.get("business_name")
            # Sole proprietors ("LAST, FIRST") have no DOS entity.
            if holder and not (holder.count(",") == 1 and not legal_form(holder)):
                add(holder, "nyc_dcwp", ref=d, weight=dcwp.confidence)
        return out

    # -- scoring ---------------------------------------------------------------
    @staticmethod
    def locality(contractor: dict[str, Any], row: dict[str, Any], extra: dict[str, Any] | None = None) -> Locality:
        loc = Locality()
        for p in ("dos_process", "chairman", "location"):
            if row.get(f"{p}_zip") or row.get(f"{p}_city"):
                loc = loc.merge(compare_locality(contractor, city=row.get(f"{p}_city"),
                                                 state=row.get(f"{p}_state"), zip_code=row.get(f"{p}_zip")))
        if extra:  # the DCWP license address is a second known address of the business
            addr = extra.get("address") or ""
            m = re.search(r",\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})", addr)
            if m:
                alt = {"city": m.group(1), "state": m.group(2), "postal_code": m.group(3)}
                for p in ("dos_process", "chairman", "location"):
                    if row.get(f"{p}_zip") or row.get(f"{p}_city"):
                        loc = loc.merge(compare_locality(alt, city=row.get(f"{p}_city"),
                                                         state=row.get(f"{p}_state"), zip_code=row.get(f"{p}_zip")))
        return loc

    def score(self, ctx: LeadContext, row: dict[str, Any], variant: dict[str, Any],
              n_results: int) -> dict[str, Any]:
        c = ctx.contractor
        entity = row.get("current_entity_name") or ""
        ns = strict_similarity(variant["name"], entity)
        reasons = [f"name={ns:.2f}({variant['origin']})"]
        if ns < 0.85:
            return {"confidence": 0.0, "name_similarity": round(ns, 3), "reasons": reasons}
        conf = 0.6 if ns >= 0.97 else 0.5 if ns >= 0.9 else 0.4
        loc = self.locality(c, row, variant["ref"] if variant["origin"] == "nyc_dcwp" else None)
        conf += loc.bonus()
        reasons.append(f"loc={loc.describe()}")
        if not distinctive_tokens(variant["name"]):
            conf -= 0.2
            reasons.append("generic_name")
        elif n_results <= 3:
            conf += 0.05
            reasons.append("rare_name")
        lf_name = legal_form(variant["name"])
        lf_ent = _entity_form(row.get("entity_type"))
        if lf_name and lf_ent:
            if lf_name == lf_ent:
                conf += 0.05
            else:
                conf -= 0.1
                reasons.append("legal_form_mismatch")
        if variant["origin"] == "legal_name":
            conf += 0.05
        state = (c.get("state") or "").upper()
        if state and state != "NY":
            # Out-of-state contractor: only a foreign registration from its home state,
            # or a filing address there, makes a namesake NY entity believable.
            juris = (row.get("jurisdiction") or "").upper()
            home = STATE_NAMES.get(state, state)
            if juris == home:
                conf += 0.1
                reasons.append(f"foreign_from_{state}")
            elif not loc.same_state:
                conf = min(conf, 0.45)
                reasons.append("no_home_state_evidence")
            if ns < 0.95:
                conf = min(conf, 0.5)
        if variant["origin"] == "nyc_dcwp":
            conf *= float(variant["weight"])
            reasons.append("via_dcwp_license")
        return {"confidence": round(max(0.0, min(conf, 0.95)), 3), "name_similarity": round(ns, 3),
                "locality": loc.describe(), "loc_bonus": loc.bonus(), "reasons": reasons,
                "matched_name": variant["name"], "origin": variant["origin"]}

    # -- main ----------------------------------------------------------------------
    async def enrich(self, ctx: LeadContext, http: HttpClient) -> EnrichmentResult:
        urls: list[str] = []
        scored: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
        queried = 0
        for variant in self.name_variants(ctx):
            for pattern in like_patterns(variant["name"]):
                rows = await self.query(http, pattern)
                queried += 1
                urls.append(f"{DATASET_URL}?$where=current_entity_name like '{pattern}'")
                for row in rows:
                    dos_id = row.get("dos_id")
                    if not dos_id:
                        continue
                    ev = self.score(ctx, row, variant, len(rows))
                    if dos_id not in scored or ev["confidence"] > scored[dos_id][1]["confidence"]:
                        scored[dos_id] = (row, ev)
            best_now = max((ev["confidence"] for _, ev in scored.values()), default=0.0)
            if best_now >= GOOD_ENOUGH:
                break

        ranked = sorted(scored.values(), key=lambda x: (x[1]["confidence"], x[1].get("name_similarity", 0),
                                                        x[1].get("loc_bonus", 0),
                                                        x[0].get("initial_dos_filing_date") or ""), reverse=True)
        if not ranked or ranked[0][1]["confidence"] < ACCEPT:
            return self.no_match(
                data={"queries": queried, "candidates_checked": len(scored),
                      "near_misses": [{"dos_id": r.get("dos_id"), "entity_name": r.get("current_entity_name"),
                                       "jurisdiction": r.get("jurisdiction"), "confidence": ev["confidence"],
                                       "reasons": ev["reasons"]}
                                      for r, ev in ranked[:3] if ev["confidence"] > 0]},
                source_urls=urls,
            )
        row, ev = ranked[0]
        conf = ev["confidence"]
        # Ambiguity: an equally good same-named entity with no better locality evidence.
        if len(ranked) > 1:
            r2, ev2 = ranked[1]
            if (ev2["name_similarity"] >= 0.97 and ev["name_similarity"] >= 0.97
                    and ev2.get("loc_bonus", 0) >= ev.get("loc_bonus", 0)):
                conf = round(conf - 0.15, 3)
                ev["reasons"].append(f"ambiguous_with_{r2.get('dos_id')}")
                if conf < ACCEPT:
                    return self.no_match(data={"queries": queried, "ambiguous": [
                        {"dos_id": r.get("dos_id"), "entity_name": r.get("current_entity_name"),
                         "confidence": e["confidence"]} for r, e in ranked[:3]]}, source_urls=urls)
        return self._result(row, ev, conf, urls)

    def _result(self, row: dict[str, Any], ev: dict[str, Any], conf: float, urls: list[str]) -> EnrichmentResult:
        dos_id = row["dos_id"]
        url = entity_url(dos_id)
        entity = row.get("current_entity_name")
        chairman = title_case_person(row.get("chairman_name"))
        process_name = row.get("dos_process_name")
        data = {
            "dos_id": dos_id,
            "entity_name": entity,
            "entity_type": row.get("entity_type"),
            "initial_filing_date": _date(row.get("initial_dos_filing_date")),
            "county": row.get("county"),
            "jurisdiction": row.get("jurisdiction"),
            "chairman_name": chairman,
            "chairman_address": _addr(row, "chairman"),
            "process_name": process_name,
            "process_address": _addr(row, "dos_process"),
            "principal_office_name": row.get("location_name"),
            "principal_office_address": _addr(row, "location"),
            "registered_agent_name": row.get("registered_agent_name"),
            "entity_url": url,
            "match_evidence": ev,
        }
        contacts: list[Contact] = []
        if chairman and looks_like_person(row.get("chairman_name"), entity):
            contacts.append(Contact(name=chairman, title="Chairman/CEO (NY DOS filing)", source=self.name,
                                    source_url=url, confidence=round(conf * 0.9, 3)))
        proc = re.sub(r"^\s*(c/o|attn:?|attention:?)\s+", "", process_name or "", flags=re.I).strip()
        if proc and looks_like_person(proc, entity):
            person = title_case_person(proc)
            if person and (not chairman or person.lower() != chairman.lower()):
                is_llc = _entity_form(row.get("entity_type")) == "llc"
                contacts.append(Contact(
                    name=person,
                    title="Service-of-process contact (NY DOS filing" + ("; often the LLC's owner)" if is_llc else ")"),
                    source=self.name, source_url=url, confidence=round(conf * (0.6 if is_llc else 0.4), 3),
                ))
        return self.ok(data, conf, contacts=contacts, source_urls=[url] + urls)
