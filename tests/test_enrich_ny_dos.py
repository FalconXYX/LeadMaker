"""Offline tests for the NY Department of State corporation-registry enricher (ny_dos).

Fixtures (data.ny.gov Socrata dataset n9v6-gdp6, keyed by the SoQL LIKE pattern):
  ny_dos_queries.json   -- real responses captured from the live API on 2026-10-18;
  ny_dos_scenarios.json -- rows reconstructed from the ny_dos results the live run stored
                           in data/leadmaker.db (see its "_about" note).
Expected values below (DOS IDs, confidences, contacts) are the ones the live run produced.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from leadmaker.config import Settings
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.ny_dos import (
    ACCEPT,
    DATASET_URL,
    QUERY_LIMIT,
    NyDosEnricher,
    entity_url,
    like_patterns,
)
from leadmaker.http import Response
from leadmaker.models import EnrichmentResult, EnrichmentStatus

FIX = Path(__file__).parent / "fixtures"
QUERIES: dict[str, list[dict[str, Any]]] = {
    **json.loads((FIX / "ny_dos_queries.json").read_text()),
    **json.loads((FIX / "ny_dos_scenarios.json").read_text())["queries"],
}

# Real GAF contractor rows (subset of columns) from the scraped DB.
C: dict[str, dict[str, Any]] = {
    "adh": {"gaf_id": "1136285", "name": "ADH Group", "legal_name": "Makabad Corp", "dba": None,
            "city": "College Point", "state": "NY", "postal_code": "11356"},
    "ff": {"gaf_id": "1100323", "name": "F&F Roofing Company Inc", "legal_name": "F&F Roofing Company Inc",
           "dba": None, "city": "Floral Park", "state": "NY", "postal_code": "11001"},
    "multi": {"gaf_id": "1000574", "name": "Multi Roofing System Inc", "legal_name": "Multi Roofing System Inc",
              "dba": None, "city": "Edison", "state": "NJ", "postal_code": "08837"},
    "nerm": {"gaf_id": "1000630", "name": "Northeast Roof Maintenance Inc",
             "legal_name": "Northeast Roof Maintenance Inc", "dba": None, "city": "Perth Amboy", "state": "NJ",
             "postal_code": "08861"},
    "mcleod": {"gaf_id": "1000796", "name": "McLeod Brothers Inc", "legal_name": "McLeod Brothers Inc", "dba": None,
               "city": "New Rochelle", "state": "NY", "postal_code": "10801"},
    "chris": {"gaf_id": "1136821", "name": "Chris the Roofer NYC", "legal_name": "Chris the Roofer NYC", "dba": None,
              "city": "Staten Island", "state": "NY", "postal_code": "10314"},
    "highrise": {"gaf_id": "1152313", "name": "Highrise Roofing LLC", "legal_name": "Highrise Roofing LLC",
                 "dba": None, "city": "Brooklyn", "state": "NY", "postal_code": "11230"},
    "jc": {"gaf_id": "1136966", "name": "JC Master Inc", "legal_name": "JC Master Inc", "dba": None,
           "city": "Richmond Hill", "state": "NY", "postal_code": "11418"},
    "mighty": {"gaf_id": "1163207", "name": "Mighty Roofing & Siding", "legal_name": "Mighty Roofing & Siding",
               "dba": None, "city": "Brooklyn", "state": "NY", "postal_code": "11201"},
    "david": {"gaf_id": "1003450", "name": "David General Contractor Inc", "legal_name": "D Builder Contractor Inc",
              "dba": None, "city": "Westbury", "state": "NY", "postal_code": "11590"},
    "andrews": {"gaf_id": "1002548", "name": "Andrews Construction LLC", "legal_name": None, "dba": None,
                "city": "Wayne", "state": "NJ", "postal_code": "07470"},
    "great_american": {"gaf_id": "1001655", "name": "The Great American Roofing Company",
                       "legal_name": "GARC Companies LLC", "dba": None, "city": "Ramsey", "state": "NJ",
                       "postal_code": "07446"},
}

# nyc_dcwp results the live run stored for these contractors (the fields ny_dos reads).
DCWP = {
    "jc": (0.8, {"license_number": "2101283-DCA", "business_name": "J C MASTER INC",
                 "address": "11123 JAMAICA AVENUE, RICHMOND HILL, NY 11418"}),
    "mighty": (0.93, {"license_number": "2096878-DCA", "business_name": "Mighty Roofing Corp",
                      "address": "44 COURT ST, BROOKLYN HEIGHTS, NY 11201"}),
    "david": (0.7, {"license_number": "2094639-DCA", "business_name": "D BUILDER CONTRACTOR INC",
                    "address": "84 SUNNYSIDE LN, WESTBURY, NY 11590"}),
}


def _pattern(params: dict[str, Any]) -> str:
    where = params["$where"]
    prefix = "current_entity_name like '"
    assert where.startswith(prefix) and where.endswith("'"), where
    return where[len(prefix):-1]


class FakeHttp:
    """Answers n9v6-gdp6 LIKE queries from the fixtures (unknown pattern -> []) and records them."""

    def __init__(self, queries: dict[str, Any] | None = None):
        self.queries = QUERIES if queries is None else queries
        self.calls: list[dict[str, Any]] = []

    @property
    def patterns(self) -> list[str]:
        return [_pattern(c["params"]) for c in self.calls]

    async def get(self, url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
                  **kw: Any) -> Response:
        params = dict(params or {})
        self.calls.append({"url": url, "params": params, "headers": dict(headers or {})})
        body = self.queries.get(_pattern(params), [])
        return Response(url=url, status=200, text=json.dumps(body), headers={})


def _dcwp(key: str, status: EnrichmentStatus = EnrichmentStatus.OK, confidence: float | None = None):
    conf, data = DCWP[key]
    return EnrichmentResult(source="nyc_dcwp", status=status, confidence=conf if confidence is None else confidence,
                            data=data)


def _ctx(key: str, *, with_dcwp: bool = False, contractor: dict[str, Any] | None = None) -> LeadContext:
    prior = {"nyc_dcwp": _dcwp(key)} if with_dcwp else {}
    return LeadContext(contractor=contractor or C[key], prior=prior)


async def _run(key: str, *, with_dcwp: bool = False, settings: Settings | None = None):
    e = NyDosEnricher(settings or Settings(socrata_app_token=None))
    http = FakeHttp()
    r = await e.enrich(_ctx(key, with_dcwp=with_dcwp), http)  # type: ignore[arg-type]
    return r, http


def _query_url(pattern: str) -> str:
    return f"{DATASET_URL}?$where=current_entity_name like '{pattern}'"


# -- LIKE patterns --------------------------------------------------------------------------------

@pytest.mark.parametrize(("name", "expected"), [
    ("Makabad Corp", ["%MAKABAD%"]),
    ("Northeast Roof Maintenance Inc", ["%NORTHEAST%ROOF%MAINTENANCE%"]),
    ("McLeod Brothers Inc", ["%MCLEOD%BROTHER%"]),           # plural folded so BROTHER/BROTHERS both match
    ("Chris the Roofer NYC", ["%CHRI%ROOF%NYC%"]),            # ROOFER -> ROOF stem, THE dropped, S folded
    ("Window Depot USA of Lower NY", ["%WINDOW%DEPOT%USA%LOWER%"]),  # NY left out (spelt NEW YORK in filings)
    ("Jersey Roofing L.L.C.", ["%JERSEY%ROOF%"]),             # dotted legal form dropped
])
def test_distinctive_names_get_one_contains_pattern(name, expected):
    assert like_patterns(name) == expected


@pytest.mark.parametrize(("name", "expected"), [
    ("F&F Roofing Company Inc", ["F&F ROOFING%", "F%F%ROOF%"]),   # generic -> anchored prefix patterns only
    ("M.D.R., Inc.", ["M.D.R.%", "M%D%R%"]),
    ("D Builder Contractor Inc", ["D BUILDER CONTRACTOR%", "D%BUILD%CONTRACT%"]),
    ("New York Inc", ["NEW YORK%", "NEW%YORK%"]),                 # only NY words left -> keep them
])
def test_generic_or_initials_names_get_anchored_prefix_patterns(name, expected):
    pats = like_patterns(name)
    assert pats == expected
    assert not any(p.startswith("%") for p in pats)  # a leading wildcard would scan millions of rows


@pytest.mark.parametrize("name", [None, "", "The Company, Inc.", "LLC", "  &  "])
def test_names_without_searchable_words_produce_no_query(name):
    assert like_patterns(name) == []


@pytest.mark.parametrize("name", ["A's Roofing", "Tony's Roofing & Siding", "O'Brien Contracting Corp",
                                  "Roofer’s Choice LLC", "D'Angelo & Sons Inc"])
def test_patterns_never_carry_a_quote_into_soql(name):
    pats = like_patterns(name)
    assert pats, name
    assert all("'" not in p and "’" not in p for p in pats)


async def test_contractor_with_only_legal_form_words_makes_no_request():
    e = NyDosEnricher(Settings(socrata_app_token=None))
    http = FakeHttp()
    c = {"gaf_id": "x", "name": "The Company, Inc.", "legal_name": "LLC", "dba": None, "state": "NY"}
    r = await e.enrich(LeadContext(contractor=c), http)  # type: ignore[arg-type]
    assert http.calls == []
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data == {"queries": 0, "candidates_checked": 0, "near_misses": []}


# -- HTTP contract --------------------------------------------------------------------------------

async def test_query_sends_like_filter_limit_and_app_token():
    e = NyDosEnricher(Settings(socrata_app_token="tok123"))
    http = FakeHttp()
    rows = await e.query(http, "%MAKABAD%")  # type: ignore[arg-type]
    assert [r["dos_id"] for r in rows] == ["4688117"]
    (call,) = http.calls
    assert call["url"] == DATASET_URL == "https://data.ny.gov/resource/n9v6-gdp6.json"
    assert call["params"] == {"$where": "current_entity_name like '%MAKABAD%'", "$limit": str(QUERY_LIMIT)}
    assert call["headers"] == {"Accept": "application/json", "X-App-Token": "tok123"}


async def test_no_app_token_header_without_token():
    e = NyDosEnricher(Settings(socrata_app_token=None))
    http = FakeHttp()
    await e.query(http, "%MAKABAD%")  # type: ignore[arg-type]
    assert "X-App-Token" not in http.calls[0]["headers"]


async def test_query_results_are_cached_per_pattern_across_contractors():
    e = NyDosEnricher(Settings(socrata_app_token=None))
    http = FakeHttp()
    twin = {**C["adh"], "gaf_id": "999", "name": "Makabad Corp", "legal_name": None}
    r1 = await e.enrich(_ctx("adh"), http)  # type: ignore[arg-type]
    r2 = await e.enrich(LeadContext(contractor=twin), http)  # type: ignore[arg-type]
    assert http.patterns == ["%MAKABAD%"]  # second contractor served from the cache
    assert r1.data["dos_id"] == r2.data["dos_id"] == "4688117"


async def test_non_list_response_raises_so_the_orchestrator_records_an_error():
    e = NyDosEnricher(Settings(socrata_app_token=None))
    err = {"code": "query.soql.no-such-column", "error": True, "message": "No such column: current_entity"}
    http = FakeHttp({"%MAKABAD%": err})
    with pytest.raises(ValueError, match="unexpected NY DOS response"):
        await e.enrich(_ctx("adh"), http)  # type: ignore[arg-type]
    assert "%MAKABAD%" not in e._cache  # a failed answer is not cached


# -- name variants & the nyc_dcwp dependency -----------------------------------------------------

def test_depends_on_nyc_dcwp_and_applies_to_out_of_state_firms():
    e = NyDosEnricher(Settings())
    assert NyDosEnricher.depends_on == ("nyc_dcwp",)
    assert e.applies_to(_ctx("multi")) and e.applies_to(_ctx("adh"))  # NJ firms may hold NY foreign filings


def test_name_variants_order_and_dedupe():
    e = NyDosEnricher(Settings())
    c = {"gaf_id": "1", "legal_name": "Jersey Roofing LLC", "name": "JERSEY ROOFING, L.L.C.", "dba": "Garden State Roof"}
    vs = e.name_variants(LeadContext(contractor=c))
    assert [(v["name"], v["origin"], v["weight"], v["ref"]) for v in vs] == [
        ("Jersey Roofing LLC", "legal_name", 1.0, None),
        ("Garden State Roof", "dba", 1.0, None),  # listing name had the same search key as the legal name
    ]


def test_matched_dcwp_license_holder_becomes_a_weighted_variant():
    e = NyDosEnricher(Settings())
    vs = e.name_variants(_ctx("mighty", with_dcwp=True))
    assert [v["origin"] for v in vs] == ["legal_name", "nyc_dcwp"]
    v = vs[1]
    assert v["name"] == "Mighty Roofing Corp" and v["weight"] == 0.93 and v["ref"] == DCWP["mighty"][1]


def test_dcwp_variant_with_same_search_key_is_not_repeated():
    e = NyDosEnricher(Settings())
    vs = e.name_variants(_ctx("david", with_dcwp=True))  # holder D BUILDER CONTRACTOR INC == legal name
    assert [v["origin"] for v in vs] == ["legal_name", "name"]


@pytest.mark.parametrize(("status", "confidence", "holder", "included"), [
    (EnrichmentStatus.OK, 0.93, "Mighty Roofing Corp", True),
    (EnrichmentStatus.OK, 0.59, "Mighty Roofing Corp", False),       # weak license match is ignored
    (EnrichmentStatus.NO_MATCH, 0.93, "Mighty Roofing Corp", False),
    (EnrichmentStatus.OK, 0.93, "SMITH, JOHN", False),               # sole proprietor: no DOS entity
    (EnrichmentStatus.OK, 0.93, "ACME ROOFING, INC.", True),         # comma before a legal form is fine
])
def test_dcwp_variant_requires_confident_ok_entity_license(status, confidence, holder, included):
    e = NyDosEnricher(Settings())
    prior = EnrichmentResult(source="nyc_dcwp", status=status, confidence=confidence,
                             data={"business_name": holder, "address": DCWP["mighty"][1]["address"]})
    vs = e.name_variants(LeadContext(contractor=C["mighty"], prior={"nyc_dcwp": prior}))
    assert any(v["origin"] == "nyc_dcwp" for v in vs) is included


# -- end-to-end matching on real registry rows ---------------------------------------------------

async def test_legal_name_match_gives_entity_and_chairman_contact():
    r, http = await _run("adh")  # GAF "ADH Group", legal name "Makabad Corp"
    assert r.status == EnrichmentStatus.OK and r.confidence == 0.95
    assert http.patterns == ["%MAKABAD%"]  # GOOD_ENOUGH: the listing-name variant is never queried
    d = r.data
    assert d["dos_id"] == "4688117" and d["entity_name"] == "MAKABAD CORP."
    assert d["entity_type"] == "DOMESTIC BUSINESS CORPORATION"
    assert d["initial_filing_date"] == "2015-01-05" and d["county"] == "Queens" and d["jurisdiction"] == "New York"
    assert d["chairman_name"] == "Andres Abadia"
    assert d["chairman_address"] == "ANDRES ABADIA, JACKSON HEIGHTS, NY 11372"
    assert d["process_name"] == "MAKABAD CORP." and d["process_address"] == "15-09 121st st, COLLEGE POINT, NY 11356"
    assert d["principal_office_address"] is None and d["entity_url"] == entity_url("4688117")
    ev = d["match_evidence"]
    assert ev["origin"] == "legal_name" and ev["name_similarity"] == 1.0 and ev["loc_bonus"] == 0.3
    assert "rare_name" in ev["reasons"]
    (c,) = r.contacts  # process addressee is the corporation itself -> no second contact
    assert (c.name, c.title, c.source, c.confidence) == ("Andres Abadia", "Chairman/CEO (NY DOS filing)", "ny_dos",
                                                         0.855)
    assert c.source_url == "https://data.ny.gov/resource/n9v6-gdp6.json?dos_id=4688117"
    assert r.source_urls == [entity_url("4688117"), _query_url("%MAKABAD%")]


async def test_generic_name_tries_both_prefix_patterns_and_is_penalised():
    r, http = await _run("ff")
    assert http.patterns == ["F&F ROOFING%", "F%F%ROOF%"]
    assert r.status == EnrichmentStatus.OK and r.data["dos_id"] == "578088"
    assert r.confidence == 0.8  # 0.6 name + 0.3 same ZIP + 0.05 corp form + 0.05 legal-name origin - 0.2 generic
    assert "generic_name" in r.data["match_evidence"]["reasons"]
    assert r.data["principal_office_address"] == "311 JERICHO TURNPIKE, FLORAL PARK, NY 11001"
    assert [c.name for c in r.contacts] == ["Pasquale Giugliano"]


async def test_nj_contractor_matches_its_foreign_ny_registration():
    r, _ = await _run("multi")
    assert r.status == EnrichmentStatus.OK and r.confidence == 0.95
    assert r.data["dos_id"] == "4941014" and r.data["jurisdiction"] == "New Jersey"
    assert "foreign_from_NJ" in r.data["match_evidence"]["reasons"]
    assert r.contacts == []  # no chairman, process addressee is the company


async def test_nj_contractor_with_domestic_ny_namesake_is_a_near_miss():
    r, _ = await _run("nerm")  # NY-domestic "NORTHEAST ROOF MAINTENANCE, INC." in Jamaica, Queens
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data["queries"] == 1 and r.data["candidates_checked"] == 1
    (nm,) = r.data["near_misses"]
    assert nm["dos_id"] == "6496650" and nm["confidence"] == 0.45 < ACCEPT
    assert "no_home_state_evidence" in nm["reasons"] and "loc=other_state" in nm["reasons"]
    assert r.source_urls == [_query_url("%NORTHEAST%ROOF%MAINTENANCE%")]


async def test_llc_process_addressee_is_a_lower_confidence_owner_contact():
    r, _ = await _run("chris")
    assert r.status == EnrichmentStatus.OK and r.data["dos_id"] == "5882416" and r.confidence == 0.95
    (c,) = r.contacts
    assert c.name == "Christopher Vroom"
    assert c.title == "Service-of-process contact (NY DOS filing; often the LLC's owner)"
    assert c.confidence == round(0.95 * 0.6, 3)


async def test_registered_agent_company_is_not_emitted_as_a_contact():
    r, _ = await _run("highrise")
    assert r.status == EnrichmentStatus.OK and r.data["process_name"] == "YMS CONSULTING SERVICES LLC"
    assert r.contacts == []


async def test_dcwp_license_holder_finds_the_legal_entity_behind_a_trade_name():
    r, http = await _run("mighty", with_dcwp=True)
    assert http.patterns == ["%MIGHTY%ROOF%SIDING%", "%MIGHTY%ROOF%"]
    assert r.status == EnrichmentStatus.OK and r.data["dos_id"] == "5787827"
    ev = r.data["match_evidence"]
    assert ev["origin"] == "nyc_dcwp" and "via_dcwp_license" in ev["reasons"]
    assert r.confidence == 0.93  # scaled by the license match confidence
    assert r.data["process_address"] == "44 court street, unit 1004, BROOKLYN, NY 11201"


async def test_without_the_dcwp_result_the_trade_name_finds_nothing():
    r, http = await _run("mighty", with_dcwp=False)
    assert http.patterns == ["%MIGHTY%ROOF%SIDING%"]
    assert r.status == EnrichmentStatus.NO_MATCH and r.data["near_misses"] == []


async def test_corporation_process_addressee_contact_via_dcwp_variant():
    r, http = await _run("jc", with_dcwp=True)
    assert http.patterns == ["%JC%MASTER%", "%J%C%MASTER%"]
    assert r.status == EnrichmentStatus.OK and r.data["dos_id"] == "6018308"
    assert r.confidence == 0.76  # (0.6 + 0.3 + 0.05 corp) x 0.8 license confidence; 4 results -> not rare
    assert "rare_name" not in r.data["match_evidence"]["reasons"]
    (c,) = r.contacts
    assert c.name == "Julian Tellez" and c.title == "Service-of-process contact (NY DOS filing)"
    assert c.confidence == round(0.76 * 0.4, 3)


async def test_ambiguous_namesake_lowers_confidence_and_chairman_is_not_duplicated():
    r, http = await _run("david", with_dcwp=True)
    assert http.patterns == ["D BUILDER CONTRACTOR%", "D%BUILD%CONTRACT%", "%DAVID%GENERAL%CONTRACT%"]
    assert r.status == EnrichmentStatus.OK and r.data["dos_id"] == "2942609"
    assert r.confidence == 0.8  # 0.95 - 0.15 for the equally-named LLC at the same address
    assert "ambiguous_with_5615790" in r.data["match_evidence"]["reasons"]
    assert r.data["match_evidence"]["confidence"] == 0.95
    (c,) = r.contacts  # process addressee == chairman -> only one contact
    assert c.name == "Luis David Pizha" and c.title.startswith("Chairman/CEO") and c.confidence == 0.72
    assert len(r.source_urls) == 4


async def test_ambiguity_below_accept_returns_no_match_with_candidates():
    r, _ = await _run("andrews")
    assert r.status == EnrichmentStatus.NO_MATCH and r.contacts == []
    assert r.data == {"queries": 1, "ambiguous": [
        {"dos_id": "3589866", "entity_name": "ANDREWS CONSTRUCTION, L.L.C.", "confidence": 0.6},
        {"dos_id": "3714867", "entity_name": "ANDREW CONSTRUCTION CORP.", "confidence": 0.35},
        {"dos_id": "6226467", "entity_name": "ANDREW CONSTRUCTION GROUP LLC", "confidence": 0.3},
    ]}


async def test_legal_form_mismatch_is_penalised_but_foreign_filing_still_matches():
    r, http = await _run("great_american")
    assert http.patterns == ["%GARC%COMPANIE%", "%GREAT%AMERICAN%ROOF%"]
    assert r.status == EnrichmentStatus.OK and r.data["dos_id"] == "3417122"
    reasons = r.data["match_evidence"]["reasons"]
    assert "legal_form_mismatch" in reasons and "foreign_from_NJ" in reasons
    assert r.data["match_evidence"]["origin"] == "name"
    assert r.confidence == 0.65


async def test_rows_without_dos_id_are_ignored():
    rows = [{**QUERIES["%MAKABAD%"][0], "dos_id": None}]
    e = NyDosEnricher(Settings(socrata_app_token=None))
    r = await e.enrich(_ctx("adh"), FakeHttp({"%MAKABAD%": rows}))  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.NO_MATCH and r.data["candidates_checked"] == 0


async def test_exact_legal_name_beats_newer_near_namesake():
    r, _ = await _run("mcleod")
    assert r.status == EnrichmentStatus.OK
    assert r.data["entity_name"] == "MCLEOD BROTHERS, INC." and r.data["dos_id"] == "2390064"
    assert [c.name for c in r.contacts] == ["Vicente J Cueva"]


# -- scoring rules ----------------------------------------------------------------------------------

def _variant(name: str, origin: str = "legal_name") -> dict[str, Any]:
    return {"name": name, "origin": origin, "ref": None, "weight": 1.0}


def test_weak_name_similarity_scores_zero_without_further_evidence():
    e = NyDosEnricher(Settings())
    row = QUERIES["%ANDREW%CONSTRUCT%"][3]  # ANDREWS CONSTRUCTION MANAGEMENT INC.
    ev = e.score(_ctx("andrews"), row, _variant("Andrews Construction LLC", "name"), 4)
    assert ev["confidence"] == 0.0 and ev["name_similarity"] < 0.85
    assert ev["reasons"] == [f"name={ev['name_similarity']:.2f}(name)"] and "locality" not in ev


def test_out_of_state_inexact_name_is_capped_even_with_home_state_filing():
    e = NyDosEnricher(Settings())
    c = {"gaf_id": "1", "name": "Doda Brothers Construction LLC", "legal_name": "Doda Brothers Construction LLC",
         "city": "Cliffside Park", "state": "NJ", "postal_code": "07010"}
    row = {"dos_id": "1", "current_entity_name": "DODA BROTHERS CONSTRUCTION II LLC", "jurisdiction": "New Jersey",
           "entity_type": "FOREIGN LIMITED LIABILITY COMPANY", "dos_process_city": "CLIFFSIDE PARK",
           "dos_process_state": "NJ", "dos_process_zip": "07010"}
    ev = e.score(LeadContext(contractor=c), row, _variant(c["legal_name"]), 1)
    assert 0.85 <= ev["name_similarity"] < 0.95
    assert "foreign_from_NJ" in ev["reasons"] and ev["confidence"] == 0.5 < ACCEPT


@pytest.mark.parametrize(("entity_type", "delta", "mismatch"), [
    ("DOMESTIC BUSINESS CORPORATION", 0.05, False),      # "Corp" name, corporation entity: bonus
    ("DOMESTIC LIMITED LIABILITY COMPANY", -0.1, True),  # "Corp" name, LLC entity: penalty
    ("DOMESTIC LIMITED PARTNERSHIP", 0.0, False),        # form unknown for partnerships: no evidence either way
])
def test_legal_form_agreement_between_name_and_entity_type(entity_type, delta, mismatch):
    e = NyDosEnricher(Settings())
    row = {**QUERIES["%MAKABAD%"][0], "entity_type": entity_type}
    base = {**row, "entity_type": None}
    v = _variant("Makabad Corp")
    lo = {**C["adh"], "postal_code": "14201", "city": "Buffalo"}  # keep the total below the 0.95 cap
    ev = e.score(LeadContext(contractor=lo), row, v, 1)
    ev0 = e.score(LeadContext(contractor=lo), base, v, 1)
    assert round(ev["confidence"] - ev0["confidence"], 3) == delta
    assert ("legal_form_mismatch" in ev["reasons"]) is mismatch


def test_dcwp_license_address_counts_as_a_second_known_address():
    contractor = {"city": "Hoboken", "state": "NJ", "postal_code": "07030"}  # GAF lists a different office
    row = QUERIES["%MIGHTY%ROOF%"][0]
    alone = NyDosEnricher.locality(contractor, row)
    assert alone.other_state and alone.bonus() == -0.15
    both = NyDosEnricher.locality(contractor, row, {"address": "44 COURT ST, BROOKLYN HEIGHTS, NY 11201"})
    assert both.same_zip and not both.other_state and both.bonus() == 0.3
    unparsable = NyDosEnricher.locality(contractor, row, {"address": "44 COURT ST BROOKLYN"})
    assert unparsable == alone
