"""Run completeness guard: short Coveo reads must not delist contractors (offline).

Pages are built from the real Coveo response fixture, cloned with new contractor ids
so an area can hold any number of results.
"""

import copy
import json
from json import dumps
from pathlib import Path

import pytest

from leadmaker.config import Settings
from leadmaker.http import HttpError, Response
from leadmaker.models import SearchArea, SearchHit

from dbutil import gaf_ids
from leadmaker.pipeline import scrape as scrape_mod
from leadmaker.pipeline.scrape import (
    ScrapeOptions,
    assess_completeness,
    previous_complete_read,
    run_scrape,
)
from leadmaker.sources.gaf import client as gaf_client
from leadmaker.sources.gaf.client import AreaSearch, GafClient
from leadmaker.sources.gaf.parse import CoveoConfig, parse_coveo_result

FIX = Path(__file__).parent / "fixtures"
BASE = json.loads((FIX / "coveo_search_response.json").read_text())
AREA = SearchArea(postal_code="10013", radius_miles=25, latitude=40.7185, longitude=-74.0025)


def results(n: int, start: int = 0) -> list[dict]:
    out = []
    for i in range(start, start + n):
        r = copy.deepcopy(BASE["results"][i % len(BASE["results"])])
        r["raw"]["gaf_contractor_id"] = 900000 + i
        out.append(r)
    return out


class FakeCoveo:
    """Stands in for HttpClient: serves Coveo pages from `items`, claiming `total` results."""

    def __init__(self, items: list[dict], total: int | None = None):
        self.items = items
        self.total = len(items) if total is None else total
        self.stats = {"requests": 0, "retries": 0, "failures": 0}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    def set_host_interval(self, host, seconds):
        pass

    async def get(self, url, **kw):
        raise HttpError("offline", status=503, url=url)  # listing page -> built-in Coveo config

    async def post(self, url, json=None, **kw):
        self.stats["requests"] += 1
        if "sortCriteria" not in json:  # GAF "recommended" ranking request
            page: list[dict] = []
        else:
            page = self.items[json["firstResult"] : json["firstResult"] + json["numberOfResults"]]
        body = dict(BASE, totalCount=self.total, results=page)
        return Response(url=url, status=200, text=dumps(body), headers={})


def gaf(fake: FakeCoveo) -> GafClient:
    c = GafClient(fake)
    c.config = CoveoConfig.default()
    return c


# ---------------------------------------------------------------- client: stop reasons
async def test_paginates_until_total():
    found = await gaf(FakeCoveo(results(7))).search_area_detailed(AREA, page_size=3)
    assert (found.total, len(found.results), found.pages, found.stop_reason) == (7, 7, 3, "exhausted")
    assert await gaf(FakeCoveo(results(7))).search_area(AREA, page_size=3) == (7, found.results)


async def test_empty_page_before_total_is_reported():
    found = await gaf(FakeCoveo(results(4), total=10)).search_area_detailed(AREA, page_size=3)
    assert found.stop_reason == "empty_page" and len(found.results) == 4 and found.total == 10


async def test_depth_limit_is_reported(monkeypatch):
    monkeypatch.setattr(gaf_client, "COVEO_MAX_DEPTH", 4)
    found = await gaf(FakeCoveo(results(6))).search_area_detailed(AREA, page_size=3)
    assert found.stop_reason == "depth_limit" and len(found.results) == 4 and found.total == 6


async def test_duplicate_and_idless_results_are_counted():
    items = results(5)
    items[3] = copy.deepcopy(items[1])  # unstable sort repeats a contractor
    del items[4]["raw"]["gaf_contractor_id"]
    found = await gaf(FakeCoveo(items)).search_area_detailed(AREA, page_size=2)
    assert len(found.results) == 3 and found.duplicates == 1 and found.missing_ids == 1


# ------------------------------------------------------------------ the verdict itself
def _found(n, total, stop="exhausted"):
    return AreaSearch(total=total, results=results(n), stop_reason=stop)


@pytest.mark.parametrize(
    "found, previous, reason",
    [
        (_found(6, 6), None, None),
        (_found(6, 6), {"run_id": 1, "results": 7}, None),  # 86%: within tolerance
        (_found(5, 6, "empty_page"), None, "count_mismatch"),
        (_found(0, 0), None, "zero_total"),
        (_found(4, 4), {"run_id": 1, "results": 6}, "count_drop"),  # 67%
        (_found(4, 9, "depth_limit"), None, "depth_limit"),
    ],
)
def test_assess_completeness(found, previous, reason):
    verdict = assess_completeness(found, previous)
    assert verdict["complete"] is (reason is None)
    assert verdict["reason"] == reason
    assert verdict["results"] == len(found.results) and verdict["total"] == found.total
    assert verdict["previous"] == previous


def test_depth_limit_says_to_tile_and_drop_can_be_accepted():
    assert "tile the area" in assess_completeness(_found(4, 9, "depth_limit"), None)["message"].lower()
    prev = {"run_id": 3, "results": 6}
    assert "#3" in assess_completeness(_found(4, 4), prev)["message"]
    assert assess_completeness(_found(4, 4), prev, accept_count_drop=True)["complete"] is True


# ------------------------------------------------------------- previous complete read


def _past_run(repo, area, n, stats):
    cs = [parse_coveo_result(r) for r in results(n)]
    repo.upsert_contractors(cs)
    run = repo.start_run("gaf_ingest", {})
    repo.record_search_hits(run, area, [SearchHit(company_id=repo.company_id(c.gaf_id), distance_miles=1.0, rank=i + 1)
                                        for i, c in enumerate(cs)])
    repo.finish_run(run, "succeeded", stats)
    return run


def test_previous_complete_read_uses_verdict_or_legacy_counts(repo):
    legacy = _past_run(repo, AREA, 6, {"coveo_total": 6, "results": 6})  # run from before the guard
    _past_run(repo, AREA, 3, {"completeness": {"complete": False, "results": 3}})
    other = AREA.model_copy(update={"postal_code": "07030"})
    _past_run(repo, other, 5, {"completeness": {"complete": True, "results": 5}})
    assert previous_complete_read(repo, AREA, 99) == {"run_id": legacy, "results": 6}
    assert previous_complete_read(repo, AREA, legacy) is None
    newer = _past_run(repo, AREA, 6, {"completeness": {"complete": True, "results": 6}})
    assert previous_complete_read(repo, AREA, 99) == {"run_id": newer, "results": 6}


# --------------------------------------------------------------------- run_scrape
@pytest.fixture
def scrape(repo, monkeypatch):
    """Run run_scrape against a FakeCoveo; returns (report, stats)."""

    async def go(items, total=None, **opts):
        fake = FakeCoveo(items, total)
        monkeypatch.setattr(scrape_mod, "HttpClient", lambda settings: fake)
        o = ScrapeOptions(latitude=AREA.latitude, longitude=AREA.longitude, fetch_profiles=False, **opts)
        rep = await run_scrape(Settings(database_url="sqlite://"), repo, o)
        return rep, rep.stats["completeness"]

    return go


def _delisted(repo):
    return sorted(gaf_ids(repo, [e["company_id"] for e in repo.audit_log() if e["action"] == "delisted"]))


async def test_short_reads_are_partial_and_never_delist(repo, scrape):
    rep, c = await scrape(results(6))
    assert rep.status == "succeeded" and c["complete"] is True and c["hits_recorded"] is True
    assert rep.stats["delisted"] == 0 and len(repo.area_company_ids("10013", 25)) == 6

    # Coveo stops paginating early: 3 of the 6 it reports.
    rep, c = await scrape(results(3), total=6)
    assert rep.status == "partial" and (c["complete"], c["reason"]) == (False, "count_mismatch")
    assert rep.stats["delisted"] is None and _delisted(repo) == []
    assert c["hits_recorded"] is False and len(repo.area_company_ids("10013", 25)) == 6  # area view kept
    assert repo.list_runs(1)[0]["stats"]["completeness"]["complete"] is False

    # A self-consistent read that collapsed against the last complete one (6 -> 4).
    rep, c = await scrape(results(4))
    assert rep.status == "partial" and c["reason"] == "count_drop"
    assert c["previous"] == {"run_id": 1, "results": 6} and _delisted(repo) == []

    # Operator confirms the drop is real: now the two missing contractors are delisted.
    rep, c = await scrape(results(4), accept_count_drop=True)
    assert rep.status == "succeeded" and c["complete"] is True and rep.stats["delisted"] == 2
    assert _delisted(repo) == ["900004", "900005"] and len(repo.area_company_ids("10013", 25)) == 4


async def test_depth_limited_area_is_partial_and_says_to_tile(repo, scrape, monkeypatch):
    monkeypatch.setattr(gaf_client, "COVEO_MAX_DEPTH", 4)
    rep, c = await scrape(results(6))
    assert rep.status == "partial" and c["reason"] == "depth_limit" and "Tile" in c["message"]
    assert "stops at 4 results; read 4 of 6" in c["message"]  # reports the limit that applied
    # No complete baseline yet, so the 4 nearest still form the area's lead list.
    assert c["hits_recorded"] is True and len(repo.area_company_ids("10013", 25)) == 4
    assert rep.stats["delisted"] is None


async def test_zero_total_never_wipes_the_area(repo, scrape):
    await scrape(results(6))
    rep, c = await scrape([])
    assert rep.status == "partial" and c["reason"] == "zero_total"
    assert _delisted(repo) == [] and len(repo.area_company_ids("10013", 25)) == 6


async def test_unparseable_record_is_not_delisted(repo, scrape):
    await scrape(results(6))
    items = results(6)
    items[2]["raw"]["gaf_number_of_reviews"] = "not a number"  # parse_coveo_result raises
    rep, c = await scrape(items)
    assert c["complete"] is True and rep.stats["parse_errors"] == 1
    assert rep.status == "partial"  # parse errors still mark the run partial
    assert rep.stats["delisted"] == 0 and _delisted(repo) == []


async def test_failed_run_before_hits_is_not_a_complete_baseline(repo, scrape, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("db went away")

    monkeypatch.setattr(repo, "upsert_contractors", boom)
    with pytest.raises(RuntimeError):
        await scrape(results(6))
    run = repo.list_runs(1)[0]
    assert run["status"] == "failed" and run["stats"]["completeness"]["complete"] is False
    assert run["stats"]["completeness"]["reason"] == "run_failed"
    assert previous_complete_read(repo, AREA, 99) is None
