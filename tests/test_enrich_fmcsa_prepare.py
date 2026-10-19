"""FMCSA (USDOT census) enricher: bulk prepare(), Socrata paging, candidate index (offline).

Fixture: tests/fixtures/fmcsa_census_sample.json -- 145 real rows of
data.transportation.gov dataset az4n-8mr2 captured 2026-10-18 (e-mail local parts redacted).
FakeHttp evaluates the two SoQL shapes prepare() sends (phone IN-lists, state + keyword LIKEs)
against those rows and pages them by $offset/$limit like Socrata does.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from leadmaker.config import Settings
from leadmaker.enrich import fmcsa
from leadmaker.enrich.base import LeadContext
from leadmaker.enrich.fmcsa import COLS, HOST, KEYWORDS, MIN_CONFIDENCE, URL, FmcsaEnricher, score
from leadmaker.enrich.matching import phone_digits
from leadmaker.http import Response
from leadmaker.models import EnrichmentStatus

FIX = Path(__file__).parent / "fixtures" / "fmcsa_census_sample.json"
ROWS: list[dict[str, Any]] = json.loads(FIX.read_text())
BY_DOT = {r["dot_number"]: r for r in ROWS}

# Real GAF contractor rows (subset of columns) from the scraped DB.
C = {
    "nerm": {"gaf_id": "1000630", "name": "Northeast Roof Maintenance Inc", "legal_name": "Northeast Roof Maintenance Inc",
             "dba": None, "city": "Perth Amboy", "state": "NJ", "postal_code": "08861", "phone": "(732) 442-2020"},
    "wilbers": {"gaf_id": "1136777", "name": "Wilber's Roofing Inc", "legal_name": "Wilber's Roofing Inc", "dba": None,
                "city": "Maplewood", "state": "NJ", "postal_code": "07040", "phone": "(973) 762-6333"},
    "multi": {"gaf_id": "1000574", "name": "Multi Roofing System Inc", "legal_name": "Multi Roofing System Inc",
              "dba": None, "city": "Edison", "state": "NJ", "postal_code": "08837", "phone": "(732) 609-6424"},
    "lopezway": {"gaf_id": "1163497", "name": "Lopezway Construction", "legal_name": "Lopezway Construction",
                 "dba": None, "city": "Westbury", "state": "NY", "postal_code": "11590", "phone": "(516) 652-0401"},
}


def _like(pattern: str, value: str | None) -> bool:
    rx = "^" + ".*".join(re.escape(p) for p in pattern.split("%")) + "$"
    return bool(value and re.match(rx, value.upper(), re.S))


class FakeHttp:
    """Evaluates prepare()'s SoQL against fixture rows; pages by $offset/$limit ordered by dot_number."""

    def __init__(self, rows: list[dict[str, Any]], *, phone_rows: list[dict[str, Any]] | None = None):
        self.rows = rows
        self.phone_rows = phone_rows  # optional different view served to phone queries
        self.calls: list[dict[str, Any]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    def _match(self, where: str) -> list[dict[str, Any]]:
        if where.startswith("phone in("):
            m = re.fullmatch(r"phone in\(([^)]*)\) OR cell_phone in\(([^)]*)\)", where)
            assert m and m.group(1) == m.group(2), where
            phones = set(re.findall(r"'(\d{10})'", m.group(1)))
            src = self.phone_rows if self.phone_rows is not None else self.rows
            return [r for r in src if phone_digits(r.get("phone")) in phones or phone_digits(r.get("cell_phone")) in phones]
        m = re.fullmatch(r"phy_state in\(([^)]*)\) AND \((.*)\)", where)
        assert m, where
        states = set(re.findall(r"'([A-Z]{2})'", m.group(1)))
        likes = re.findall(r"upper\((legal_name|dba_name)\) like '([^']+)'", m.group(2))
        return [r for r in self.rows if r.get("phy_state") in states and any(_like(p, r.get(col)) for col, p in likes)]

    async def get(self, url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
                  **kw: Any) -> Response:
        params = dict(params or {})
        self.calls.append({"url": url, "params": params, "headers": dict(headers or {}), "kw": kw})
        rows = sorted(self._match(params["$where"]), key=lambda r: int(r["dot_number"]))
        off, lim = int(params["$offset"]), int(params["$limit"])
        return Response(url=url, status=200, text=json.dumps(rows[off:off + lim]), headers={})


def _phone_calls(http: FakeHttp) -> list[dict[str, Any]]:
    return [c for c in http.calls if c["params"]["$where"].startswith("phone in(")]


def _keyword_calls(http: FakeHttp) -> list[dict[str, Any]]:
    return [c for c in http.calls if c["params"]["$where"].startswith("phy_state in(")]


async def _prepared(contractors=None, settings: Settings | None = None, http: FakeHttp | None = None):
    e = FmcsaEnricher(settings or Settings(socrata_app_token=None))
    http = http or FakeHttp(ROWS)
    await e.prepare(http, list(C.values()) if contractors is None else contractors)  # type: ignore[arg-type]
    return e, http


# -- request shape ----------------------------------------------------------------------------------

async def test_prepare_is_polite_and_sends_full_socrata_query():
    e, http = await _prepared(settings=Settings(socrata_app_token="tok123"))
    assert http.intervals == {HOST: 1.2}  # robots.txt Crawl-delay 1
    assert len(_phone_calls(http)) == 1 and len(_keyword_calls(http)) == 1
    for c in http.calls:
        p = c["params"]
        assert c["url"] == URL == "https://data.transportation.gov/resource/az4n-8mr2.json"
        assert p["$select"] == COLS and p["$order"] == "dot_number"
        assert p["$limit"] == fmcsa.PAGE and p["$offset"] == 0
        assert c["headers"] == {"Accept": "application/json", "X-App-Token": "tok123"}
        assert c["kw"] == {"timeout": 180}


async def test_phone_lookup_batches_40_distinct_valid_phones_per_request():
    contractors = [{"gaf_id": str(i), "name": f"Firm {i}", "state": "NJ", "phone": f"(201) 555-{i:04d}"}
                   for i in range(85)]
    contractors += [{"gaf_id": "dup", "name": "Dup", "state": "NJ", "phone": "201-555-0000"},   # same digits as #0
                    {"gaf_id": "bad", "name": "Bad", "state": "NJ", "phone": "555-1234"},      # not 10 digits
                    {"gaf_id": "none", "name": "None", "state": "NJ", "phone": None}]
    _, http = await _prepared(contractors)
    # Every quoted value in the IN-list, whatever its shape, so a malformed number would show up.
    batches = [re.findall(r"'([^']*)'", c["params"]["$where"].split(" OR ")[0]) for c in _phone_calls(http)]
    assert [len(b) for b in batches] == [40, 40, 5]
    flat = [p for b in batches for p in b]
    assert flat == sorted(flat) and len(set(flat)) == 85
    assert all(re.fullmatch(r"\d{10}", p) for p in flat)  # "555-1234" and None never reach the query
    assert flat[0] == "2015550000" and flat[-1] == "2015550084"


async def test_no_phones_means_only_the_keyword_query():
    _, http = await _prepared([{"gaf_id": "1", "name": "Somebody Roofing", "state": "NY", "phone": None}])
    assert _phone_calls(http) == [] and len(_keyword_calls(http)) == 1


async def test_keyword_query_covers_every_trade_word_in_both_name_columns_for_contractor_states():
    _, http = await _prepared([{**C["nerm"], "state": "nj"}, {**C["lopezway"], "state": "CT"}, {**C["multi"]}])
    where = _keyword_calls(http)[0]["params"]["$where"]
    assert where.startswith("phy_state in('CT','NJ') AND (")
    for k in KEYWORDS:
        assert f"upper(legal_name) like '%{k}%'" in where and f"upper(dba_name) like '%{k}%'" in where


async def test_keyword_query_defaults_to_nj_and_ny_when_states_are_unknown():
    _, http = await _prepared([{"gaf_id": "1", "name": "X Roofing", "state": None, "phone": None}])
    assert _keyword_calls(http)[0]["params"]["$where"].startswith("phy_state in('NJ','NY') AND (")


# -- paging ----------------------------------------------------------------------------------------

async def test_query_pages_until_a_short_page(monkeypatch):
    monkeypatch.setattr(fmcsa, "PAGE", 25)
    e = FmcsaEnricher(Settings(socrata_app_token=None))
    http = FakeHttp(ROWS)
    rows = await e._query(http, "phy_state in('NJ','NY') AND (upper(legal_name) like '%%')")  # type: ignore[arg-type]
    assert [c["params"]["$offset"] for c in http.calls] == [0, 25, 50, 75, 100, 125]  # 145 rows -> 6 pages
    assert all(c["params"]["$limit"] == 25 for c in http.calls)
    assert [r["dot_number"] for r in rows] == sorted(BY_DOT, key=int)


async def test_exact_multiple_of_page_size_ends_on_an_empty_page(monkeypatch):
    monkeypatch.setattr(fmcsa, "PAGE", 29)  # 145 = 5 x 29
    e = FmcsaEnricher(Settings(socrata_app_token=None))
    http = FakeHttp(ROWS)
    rows = await e._query(http, "phy_state in('NJ','NY') AND (upper(legal_name) like '%%')")  # type: ignore[arg-type]
    assert [c["params"]["$offset"] for c in http.calls] == [0, 29, 58, 87, 116, 145]
    assert len(rows) == len({r["dot_number"] for r in rows}) == 145


async def test_prepare_with_small_pages_loads_the_same_rows(monkeypatch):
    big, _ = await _prepared()
    monkeypatch.setattr(fmcsa, "PAGE", 7)
    small, http = await _prepared()
    assert len(http.calls) > 2 and small.rows == big.rows
    assert set(small.by_phone) == set(big.by_phone) and set(small.by_token) == set(big.by_token)


# -- index -----------------------------------------------------------------------------------------

async def test_index_holds_phone_hits_and_trade_word_rows_from_contractor_states():
    e, _ = await _prepared()
    assert {"2352866", "4223463"} <= set(e.rows)  # phone hits (NERM, Wilber's)
    assert {"3984402", "4470508"} <= set(e.rows)  # keyword hits (MULTI ROOFING..., LOPEZWAY CONSTRUCTION...)
    assert all(r["phy_state"] in {"NJ", "NY"} for r in e.rows.values())
    assert e.by_phone["7324422020"] == {"2352866"}
    assert "2352866" in e.by_token["northeast"] and "4470508" in e.by_token["lopezway"]
    # dba_name is tokenised too: these words appear only in the carriers' DBA, not their legal name.
    assert "1132621" in e.by_token["asphalt"]     # ATLAS HOME IMPROVEMENT CORP... dba ATLAS ASPHALT
    assert "1042818" in e.by_token["riverhead"]   # POOL BUILDERS SUPPLY dba STONE CENTER OF RIVERHEAD


async def test_carrier_known_only_by_its_dba_is_found_and_matched():
    e, http = await _prepared()
    stone = {"gaf_id": "s", "name": "Stone Center of Riverhead", "legal_name": None, "dba": None,
             "city": "Riverhead", "state": "NY", "postal_code": "11901", "phone": None}
    assert "1042818" in e.candidates(stone)
    r = await e.enrich(LeadContext(contractor=stone), http)  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.OK and r.data["dot_number"] == "1042818" and r.confidence == 0.9
    assert r.data["legal_name"] == "POOL BUILDERS SUPPLY" and r.data["dba_name"] == "STONE CENTER OF RIVERHEAD"
    assert r.data["officers"] == ["Sharon Coleman", "Ronald Coleman"]
    assert [c.email is not None for c in r.contacts] == [True, False]  # e-mail goes to officer 1 only


async def test_cell_phone_is_indexed_and_matched():
    atlas = BY_DOT["1132621"]  # ATLAS HOME IMPROVEMENT CORP OF LONG ISLAND, separate cell phone
    c = {"gaf_id": "x", "name": "Atlas Home Improvement", "legal_name": None, "dba": None, "state": "NY",
         "city": atlas["phy_city"].title(), "postal_code": atlas["phy_zip"], "phone": "(631) 374-6045"}
    e, http = await _prepared([c])
    assert "6313746045" in _phone_calls(http)[0]["params"]["$where"]
    assert e.by_phone["6313746045"] == {"1132621"}
    r = await e.enrich(LeadContext(contractor=c), http=None)  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.OK and r.data["dot_number"] == "1132621"
    assert r.data["match_evidence"]["phone_match"] is True
    assert r.contacts and r.contacts[0].phone == "6313746045"  # officer 1 gets the cell phone


async def test_phone_query_row_wins_over_keyword_row_for_same_carrier():
    phone_view = [{**BY_DOT["2352866"], "company_officer_1": "FROM PHONE QUERY"}]
    http = FakeHttp([{**BY_DOT["2352866"], "company_officer_1": "FROM KEYWORD QUERY"}], phone_rows=phone_view)
    e, _ = await _prepared([C["nerm"]], http=http)
    assert e.rows["2352866"]["company_officer_1"] == "FROM PHONE QUERY"


async def test_candidates_skip_tokens_too_common_to_discriminate():
    e, _ = await _prepared()
    e.by_token["construction"] |= {f"x{i}" for i in range(2000)}
    cands = e.candidates(C["lopezway"])
    assert "4470508" in cands  # still found through the rare token "lopezway"
    assert not any(k.startswith("x") for k in cands)
    e.by_token["lopezway"] |= {f"y{i}" for i in range(2000)}
    assert e.candidates({**C["lopezway"], "phone": None}) == set()


def test_common_token_cutoff_is_exactly_2000_hits():
    e = FmcsaEnricher(Settings(socrata_app_token=None))
    e.by_token["acme"] = {"a1"}
    e.by_token["siding"] = {f"s{i}" for i in range(1999)}
    acme = {"gaf_id": "x", "name": "Acme Siding", "phone": None}
    assert len(e.candidates(acme)) == 2000  # 1999 hits: still used
    e.by_token["siding"].add("s1999")
    assert e.candidates(acme) == {"a1"}    # 2000 hits: too common, skipped


# -- end-to-end on real rows (values equal the live run's fmcsa results) ----------------------------

@pytest.mark.parametrize(("key", "dot", "conf", "officer", "phone_match"), [
    ("nerm", "2352866", 0.99, "Andrew Hooey", True),
    ("wilbers", "4223463", 0.99, "Wilber Antonio Vargas", True),
    ("multi", "3984402", 0.9, "Randall Cecilliano", False),
    ("lopezway", "4470508", 0.9, "Heidy Lopez", False),
])
async def test_prepared_index_reproduces_live_matches(key, dot, conf, officer, phone_match):
    e, http = await _prepared()
    r = await e.enrich(LeadContext(contractor=C[key]), http)  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.OK
    assert (r.data["dot_number"], r.confidence) == (dot, conf)
    assert r.data["officers"] == [officer] and r.contacts[0].name == officer
    assert r.data["match_evidence"]["phone_match"] is phone_match
    assert r.data["email"] == BY_DOT[dot]["email_address"].lower()
    assert r.source_urls == [f"https://data.transportation.gov/d/az4n-8mr2?dot_number={dot}"]


async def test_exact_name_elsewhere_without_phone_is_below_min_confidence():
    e, http = await _prepared()
    # Same legal name as carrier 2352866 (Perth Amboy), but another town and another phone: 0.70.
    far = {**C["nerm"], "city": "Trenton", "postal_code": "08608", "phone": "(609) 000-0000"}
    r = await e.enrich(LeadContext(contractor=far), http)  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.NO_MATCH and r.contacts == []
    assert r.data == {"best_confidence": 0.7} and 0.7 < MIN_CONFIDENCE
    # Same town (different ZIP) adds enough locality evidence to accept: 0.80.
    near = {**C["nerm"], "postal_code": "08862", "phone": "(609) 000-0000"}
    r = await e.enrich(LeadContext(contractor=near), http)  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.OK and r.data["dot_number"] == "2352866" and r.confidence == 0.8
    assert r.data["match_evidence"] == {"phone_match": False, "name_sim": 1.0, "same_zip": False, "same_city": True}


async def test_contractor_absent_from_index_is_no_match_without_score():
    e, http = await _prepared()
    c = {"gaf_id": "z", "name": "Zzyzx Quarry Works", "state": "NJ", "phone": "(201) 000-0000"}
    r = await e.enrich(LeadContext(contractor=c), http)  # type: ignore[arg-type]
    assert r.status == EnrichmentStatus.NO_MATCH and r.data == {"best_confidence": None}


# Live run 2026-10-18: name-only matches accepted at exactly MIN_CONFIDENCE (0.75) whose
# distinctive words differ -- each produced a wrong "company officer" contact. Carrier rows
# rebuilt from the stored fmcsa results (no e-mail).
NAMESAKES = [
    ({"gaf_id": "1140738", "name": "RH Development Corp", "legal_name": "RH Development Corp", "dba": None,
      "city": "North Bellmore", "state": "NY", "postal_code": "11710", "phone": "(516) 376-3330"},
     {"dot_number": "3896694", "legal_name": "RJS CONSTRUCTION & DEVELOPMENT INC", "phy_street": "2365 MERRICK ROAD",
      "phy_city": "BELLMORE", "phy_state": "NY", "phy_zip": "11710", "phone": "5162209242",
      "company_officer_1": "RONALD JOHN SMITH JR"}),
    ({"gaf_id": "1111609", "name": "Allied Roofing Solutions", "legal_name": None, "dba": None,
      "city": "Elmwood Park", "state": "NJ", "postal_code": "07407", "phone": "(973) 767-3633"},
     {"dot_number": "3984430", "legal_name": "ALL SOLUTIONS CONTRACTING INC", "phy_street": "24 CHURCH ST",
      "phy_city": "ELMWOOD PARK", "phy_state": "NJ", "phy_zip": "07407-2005", "phone": "2018739418",
      "company_officer_1": "LUIS F ARCILA FAJARDO"}),
    ({"gaf_id": "1151181", "name": "All State Roofing & Chimney NJ", "legal_name": "All State Roofing & Chimney NJ",
      "dba": None, "city": "Garfield", "state": "NJ", "postal_code": "07026", "phone": "(862) 295-7864"},
     {"dot_number": "4447352", "legal_name": "USA ROOFING & CHIMNEY LLC", "phy_street": "138 MACARTHUR AVE # 2 # 2",
      "phy_city": "GARFIELD", "phy_state": "NJ", "phy_zip": "07026-1546", "phone": "5056442424",
      "company_officer_1": "JASHAR PEPOSHI"}),
]


@pytest.mark.parametrize(("contractor", "row"), NAMESAKES, ids=[c["name"] for c, _ in NAMESAKES])
async def test_trade_word_namesake_in_same_zip_is_rejected(contractor, row):
    conf, ev = score(contractor, row)
    assert ev["phone_match"] is False and ev["same_zip"] is True
    e = FmcsaEnricher(Settings(socrata_app_token=None))
    e.rows[row["dot_number"]] = row
    for t in ("rh", "development", "allied", "solutions", "all", "state", "chimney", "usa", "rjs"):
        e.by_token[t].add(row["dot_number"])
    r = await e.enrich(LeadContext(contractor=contractor), http=None)  # type: ignore[arg-type]
    assert conf < MIN_CONFIDENCE and r.status == EnrichmentStatus.NO_MATCH
