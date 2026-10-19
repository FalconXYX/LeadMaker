"""ZIP -> county FIPS, offline.

Fixtures (real, trimmed):
  zcta_county_sample.txt -- rows of the Census 2020 ZCTA-to-county relationship file
    (tab20_zcta520_county20_natl.txt, fetched 2026-10-18) for 8 ZIPs, incl. split ZCTA 07060.
  zcta_geocoder_point_somerset.json -- Census geocoder answer for a point in 07060
    (Somerset County), as used to confirm split ZCTAs.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import insert, select

from leadmaker.db import Repository

from dbutil import gaf_ids
from leadmaker.db.schema import companies, company_source_ids
from leadmaker.http import Response
from leadmaker.signals import counties as cm

FIX = Path(__file__).parent / "fixtures"
REL_TEXT = (FIX / "zcta_county_sample.txt").read_text(encoding="utf-8")
POINT = (FIX / "zcta_geocoder_point_somerset.json").read_text()


class FakeHttp:
    def __init__(self, routes: dict[str, str]):
        self.routes = routes
        self.calls: list[dict[str, Any]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    async def get(self, url: str, params: dict[str, Any] | None = None, **kw: Any) -> Response:
        self.calls.append({"url": url, "params": params})
        return Response(url=url, status=200, text=self.routes[url], headers={})


def seed(repo: Repository, rows: list[tuple[str, str | None, float, float]]) -> None:
    now = datetime(2026, 10, 18, tzinfo=timezone.utc)
    with repo.engine.begin() as conn:
        conn.execute(insert(companies), [
            {"id": f"00000000-0000-4000-8000-{i:012d}", "business_name": f"Roofer {g}", "postal_code": z,
             "latitude": lat, "longitude": lng, "profile_url": f"https://www.gaf.com/{g}", "tier": "certified",
             "content_hash": g, "first_seen_at": now, "last_seen_at": now, "listing_updated_at": now}
            for i, (g, z, lat, lng) in enumerate(rows)
        ])
        conn.execute(insert(company_source_ids), [
            {"source": "gaf", "external_id": g, "company_id": f"00000000-0000-4000-8000-{i:012d}"}
            for i, (g, *_rest) in enumerate(rows)
        ])


def fips_of(repo: Repository) -> dict[str, str | None]:
    """{gaf_id: county_fips}"""
    with repo.engine.connect() as conn:
        return dict(conn.execute(
            select(company_source_ids.c.external_id, companies.c.county_fips)
            .join(companies, companies.c.id == company_source_ids.c.company_id)).all())


def test_index_picks_largest_land_share():
    idx = cm.CountyIndex.from_text(REL_TEXT)
    bergen = idx.lookup("07407-1234")
    assert (bergen.county_fips, bergen.county_name, bergen.state, bergen.share) == ("34003", "Bergen County", "NJ", 1.0)
    assert idx.lookup("10013").county_fips == "36061"
    split = idx.lookup("07060")
    assert split.n_counties > 1 and split.share < cm.SPLIT_SHARE
    assert idx.lookup("10113") is None  # PO-box ZIP: no ZCTA
    assert idx.lookup(None) is None and idx.lookup("123") is None
    assert idx.fips_for_name("NJ", "Somerset") == "34035"
    assert idx.fips_for_name("ny", "Queens County") == "36081"
    assert idx.county("36119") == {"county_fips": "36119", "county_name": "Westchester County", "state": "NY"}
    assert cm.state_for_fips("34003") == "NJ"


async def test_load_county_index_downloads_once(tmp_path):
    http = FakeHttp({cm.REL_URL: REL_TEXT})
    idx = await cm.load_county_index(http, tmp_path)
    assert idx.lookup("11550").county_fips == "36059"
    assert (tmp_path / cm.REL_FILE).exists()
    await cm.load_county_index(http, tmp_path)
    assert len(http.calls) == 1  # second load comes from the cache


async def test_load_county_index_rejects_error_page(tmp_path):
    http = FakeHttp({cm.REL_URL: "<html>Request Rejected</html>"})
    with pytest.raises(ValueError):
        await cm.load_county_index(http, tmp_path)
    assert not (tmp_path / cm.REL_FILE).exists()


async def test_assign_and_refine(repo, tmp_path):
    seed(repo, [("a", "07407", 40.9, -74.1), ("b", "07060", 40.6301, -74.4174), ("c", "10113", 40.7417, -73.9989),
                ("d", "11550", 40.7, -73.6)])
    idx = cm.CountyIndex.from_text(REL_TEXT)
    stats = cm.assign_county_fips(repo, idx, run_id=5)
    assert stats["assigned"] == 3 and gaf_ids(repo, stats["unmapped"]) == ["c"] and gaf_ids(repo, stats["split"]) == ["b"]
    # County changes are company changes: audited under the run and published to the outbox.
    assert {e["changes"]["county_fips"][1] for e in repo.audit_log(run_id=5)} == {"34003", "34039", "36059"}
    assert len(repo.outbox("lead.updated")) == 3
    got = fips_of(repo)
    assert got["a"] == "34003" and got["d"] == "36059" and got["c"] is None
    # Point check: the geocoder puts lead b in Somerset; c (PO box) resolves to the same fixture county.
    http = FakeHttp({cm.GEOCODER_URL: POINT})
    out = await cm.refine_by_point(http, repo, stats["unmapped"] + stats["split"])
    assert out["checked"] == 2 and http.intervals[cm.GEOCODER_HOST] >= 1
    assert http.calls[0]["params"]["layers"] == "Counties"
    assert fips_of(repo)["b"] == "34035"
    # Idempotent: nothing missing -> nothing assigned; force recomputes from ZIPs.
    again = cm.assign_county_fips(repo, idx)
    assert again["assigned"] == 0 and again["already_set"] == 4
    counties = cm.lead_counties(repo, idx)
    assert {c["county_fips"] for c in counties} == {"34003", "34035", "36059"}
    assert all(c["county_name"] and c["state"] for c in counties)


async def test_point_lookup_outside_us_returns_none():
    empty = json.dumps({"result": {"geographies": {"Counties": []}}})
    assert await cm.county_from_point(FakeHttp({cm.GEOCODER_URL: empty}), 0.0, 0.0) is None
