"""Offline tests for the NYC DCWP Home Improvement Contractor license enricher.

Fixture: tests/fixtures/nyc_dcwp_hic_sample.json -- real rows captured from
https://data.cityofnewyork.us/resource/w7w3-xahh.json (HIC category) on 2026-10-18:
licenses of contractors used below plus 40 random rows as noise.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from leadmaker.config import Settings
from leadmaker.enrich import nyc_dcwp
from leadmaker.enrich._registry_match import strict_similarity, title_case_person
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.nyc_dcwp import HicIndex, NycDcwpEnricher, format_address
from leadmaker.http import Response
from leadmaker.models import EnrichmentStatus

FIX = Path(__file__).parent / "fixtures" / "nyc_dcwp_hic_sample.json"
ROWS: list[dict[str, Any]] = json.loads(FIX.read_text())

# Real GAF contractor rows (subset of columns) from the scraped DB.
C = {
    "adh": {"gaf_id": "1136285", "name": "ADH Group", "dba": None, "legal_name": "Makabad Corp",
            "city": "College Point", "state": "NY", "postal_code": "11356", "phone": "(929) 215-3378",
            "latitude": 40.783825, "longitude": -73.846635},
    "skyward": {"gaf_id": "1137783", "name": "Skyward Roofing LLC", "dba": None, "legal_name": None,
                "city": "Elmwood Park", "state": "NJ", "postal_code": "07407", "phone": "(917) 553-3588",
                "latitude": 40.905889, "longitude": -74.118576},
    "doda": {"gaf_id": "1148956", "name": "Doda Brothers Construction LLC", "dba": None,
             "legal_name": "Doda Brothers Construction LLC", "city": "Cliffside Park", "state": "NJ",
             "postal_code": "07010", "phone": "(551) 866-7756", "latitude": 40.819847, "longitude": -73.988501},
    "top": {"gaf_id": "1149251", "name": "Top Roof LLC", "dba": None, "legal_name": None, "city": "Englewood",
            "state": "NJ", "postal_code": "07631", "phone": "(201) 989-0999",
            "latitude": 40.894067, "longitude": -73.975505},
    "gothic": {"gaf_id": "1136704", "name": "Gothic Construction", "dba": None, "legal_name": None,
               "city": "Elmwood Park", "state": "NJ", "postal_code": "07407", "phone": "(862) 926-4986",
               "latitude": 40.897585, "longitude": -74.112942},
    "window_depot": {"gaf_id": "1100471", "name": "Window Depot USA of Lower NY", "dba": None, "legal_name": None,
                     "city": "South Hempstead", "state": "NY", "postal_code": "11550", "phone": "(516) 564-4400",
                     "latitude": 40.684435, "longitude": -73.615229},
    "swiftbuild": {"gaf_id": "1148385", "name": "SwiftBuild", "dba": None, "legal_name": None,
                   "city": "Little Neck", "state": "NY", "postal_code": "11362", "phone": "(516) 906-6807",
                   "latitude": 40.750049, "longitude": -73.737661},
    "prime_one": {"gaf_id": "1155041", "name": "Prime One Roofing LLC", "dba": None, "legal_name": None,
                  "city": "Little Neck", "state": "NY", "postal_code": "11362", "phone": "(516) 906-6807",
                  "latitude": 40.750251, "longitude": -73.736938},
    "rivertown": {"gaf_id": "1161773", "name": "Rivertown Solar LLC", "dba": None, "legal_name": None,
                  "city": "Dobbs Ferry", "state": "NY", "postal_code": "10522", "phone": "(914) 231-6866",
                  "latitude": 41.012661, "longitude": -73.877182},
    "abraham": {"gaf_id": "1002062", "name": "Abraham Roofing", "dba": None, "legal_name": None,
                "city": "Lynbrook", "state": "NY", "postal_code": "11563", "phone": "(800) 347-0913",
                "latitude": 40.658036, "longitude": -73.672887},
    "carlton": {"gaf_id": "1145215", "name": "Carlton Construction Management", "dba": None, "legal_name": None,
                "city": "Iselin", "state": "NJ", "postal_code": "08830", "phone": "(732) 688-2056",
                "latitude": 40.568515, "longitude": -74.301091},
}


class FakeHttp:
    """Serves the fixture rows page by page and records requests."""

    def __init__(self, rows: list[dict[str, Any]]):
        self.rows = rows
        self.calls: list[dict[str, Any]] = []

    async def get(self, url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
                  **kw: Any) -> Response:
        self.calls.append({"url": url, "params": dict(params or {}), "headers": dict(headers or {})})
        off, lim = int(params["$offset"]), int(params["$limit"])
        return Response(url=url, status=200, text=json.dumps(self.rows[off:off + lim]), headers={})


async def _enricher(contractors: list[dict[str, Any]] | None = None, settings: Settings | None = None):
    e = NycDcwpEnricher(settings or Settings())
    http = FakeHttp(ROWS)
    await e.prepare(http, contractors if contractors is not None else list(C.values()))
    return e, http


async def _run(key: str, e: NycDcwpEnricher | None = None):
    if e is None:
        e, _ = await _enricher()
    return await e.enrich(LeadContext(contractor=C[key]), None)  # type: ignore[arg-type]


async def test_prepare_pages_through_category(monkeypatch):
    monkeypatch.setattr(nyc_dcwp, "PAGE_SIZE", 25)
    e, http = await _enricher(settings=Settings(socrata_app_token="tok123"))
    assert e.index is not None and len(e.index.rows) == len(ROWS)
    assert [c["params"]["$offset"] for c in http.calls] == ["0", "25", "50"]  # 60 rows -> 3 pages
    p = http.calls[0]["params"]
    assert p["$where"] == "business_category='Home Improvement Contractor'"
    assert p["$order"] == ":id"
    assert http.calls[0]["url"] == "https://data.cityofnewyork.us/resource/w7w3-xahh.json"
    assert http.calls[0]["headers"]["X-App-Token"] == "tok123"


async def test_no_app_token_header_by_default(monkeypatch):
    monkeypatch.delenv("SOCRATA_APP_TOKEN", raising=False)
    _, http = await _enricher(settings=Settings(socrata_app_token=None))
    assert "X-App-Token" not in http.calls[0]["headers"]


async def test_legal_name_match_makabad():
    r = await _run("adh")  # GAF "ADH Group", legal name "Makabad Corp", different phone
    assert r.status == EnrichmentStatus.OK
    d = r.data
    assert d["license_number"] == "2083986-DCA"
    assert d["license_status"] == "Active"
    assert d["license_creation_date"] == "2019-04-01"
    assert d["license_expiration_date"] == "2027-02-28"
    assert d["business_name"] == "MAKABAD CORP"
    assert d["contact_phone"] == "(929) 832-0268"
    assert d["address"] == "9604 NORTHERN BLVD, FLUSHING, NY 11368"
    assert d["match_method"] == "name"
    assert r.confidence >= 0.8
    assert r.source_urls == ["https://data.cityofnewyork.us/resource/w7w3-xahh.json?license_nbr=2083986-DCA"]


async def test_name_match_same_city_nj_firm():
    r = await _run("skyward")
    assert r.status == EnrichmentStatus.OK
    assert r.data["license_number"] == "2100010-DCA"
    assert r.data["is_active"] is True
    assert "same_city" in r.data["match_evidence"]["locality"]


async def test_phone_match_via_dba():
    r = await _run("window_depot")
    assert r.status == EnrichmentStatus.OK
    assert r.data["business_name"] == "JARC HOME IMPROVEMENTS INC."
    assert r.data["dba"] == "WINDOW DEPOT USA OF LOWER NEW YORK"
    assert r.data["match_method"] == "phone+name"
    assert r.confidence >= 0.95


async def test_phone_and_dba_reveal_legal_entity():
    r = await _run("abraham")  # trades as "Abraham Roofing", license held by "M.D.R., INC."
    assert r.status == EnrichmentStatus.OK
    assert r.data["business_name"] == "M.D.R., INC."
    assert r.data["license_number"] == "1425501-DCA"


async def test_rejects_similar_trade_names():
    # "Doda Brothers Construction" vs "CANDO BROTHERS CONSTRUCTION CORP." scores 0.9 by raw
    # SequenceMatcher; the distinctive words (doda/cando) disagree.
    assert strict_similarity("Doda Brothers Construction LLC", "CANDO BROTHERS CONSTRUCTION CORP.") < 0.9
    assert (await _run("doda")).status == EnrichmentStatus.NO_MATCH
    # Loose normalisation reduces both "Top Roof" and "TOP HOME IMPROVEMENT" to "top".
    assert (await _run("top")).status == EnrichmentStatus.NO_MATCH
    assert (await _run("carlton")).status == EnrichmentStatus.NO_MATCH  # vs STANTON CONSTRUCTION MANAGEMENT


async def test_rejects_out_of_state_namesake():
    r = await _run("gothic")  # NJ firm vs GOTHIC CONSTRUCTION CORP. in Glen Cove NY, different phone
    assert r.status == EnrichmentStatus.NO_MATCH
    assert r.data["near_misses"][0]["business_name"] == "GOTHIC CONSTRUCTION CORP."
    assert r.data["near_misses"][0]["confidence"] < 0.6


async def test_shared_phone_is_ambiguous_without_name_support():
    e, _ = await _enricher()
    # SwiftBuild and Prime One Roofing list the same phone on GAF; the license is Prime One's.
    prime = await _run("prime_one", e)
    assert prime.status == EnrichmentStatus.OK and prime.data["business_name"] == "PRIME ONE ROOFING LLC"
    swift = await _run("swiftbuild", e)
    assert swift.status == EnrichmentStatus.NO_MATCH
    # ...but a phone unique among GAF contractors is accepted on its own.
    e2, _ = await _enricher([C["swiftbuild"]])
    swift2 = await _run("swiftbuild", e2)
    assert swift2.status == EnrichmentStatus.OK and swift2.data["match_method"] == "phone"
    assert 0.6 <= swift2.confidence < 0.9


async def test_prefers_active_license_and_lists_others():
    r = await _run("rivertown")  # Expired 2110446-DCA and Active 2129990-DCWP, same phone
    assert r.status == EnrichmentStatus.OK
    assert r.data["license_number"] == "2129990-DCWP"
    assert r.data["license_status"] == "Active"
    assert [o["license_number"] for o in r.data["other_licenses"]] == ["2110446-DCA"]


async def test_sole_proprietor_license_yields_owner_contact():
    contractor = {"gaf_id": "x1", "name": "Top Home Improvement", "city": "Bronx", "state": "NY",
                  "postal_code": "10462", "phone": "646-641-9321"}
    e, _ = await _enricher([contractor])
    r = await e.enrich(LeadContext(contractor=contractor), None)  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.OK
    assert r.data["business_name"] == "DIAZ JR, ROBERTO"
    assert [c.name for c in r.contacts] == ["Roberto Diaz Jr."]
    assert r.contacts[0].source == "nyc_dcwp"
    assert r.contacts[0].confidence == pytest.approx(r.confidence * 0.9, abs=0.002)


def test_index_and_helpers():
    idx = HicIndex(ROWS)
    assert "9298320268" in idx.by_phone
    assert idx.by_key["makabad"][0]["license_nbr"] == "2083986-DCA"
    assert isinstance(idx.token_df, Counter)
    row = next(r for r in ROWS if r["license_nbr"] == "2083986-DCA")
    assert format_address(row) == "9604 NORTHERN BLVD, FLUSHING, NY 11368"
    assert title_case_person("DIAZ JR, ROBERTO") == "Roberto Diaz Jr."


async def test_enrich_without_prepare_loads_lazily():
    e = NycDcwpEnricher(Settings())
    r = await e.enrich(LeadContext(contractor=C["skyward"]), FakeHttp(ROWS))  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.OK
