"""Contractor ZIP -> 5-digit county FIPS (+ county name, state).

Source: Census 2020 ZCTA-to-county relationship file (pipe-delimited, ~7 MB, keyless):
  https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
Downloaded once and cached under data/cache/ (the 2020 vintage never changes).

A ZCTA that straddles counties is assigned to the county holding the largest
land-area share. research/market_demand/01_zip_county.py measured this against
point-in-county lookups: 36/36 agree when the share is >= 0.9, but 4 of the 9
split ZCTAs (< 0.9) disagree. So for split ZCTAs and ZIPs with no ZCTA (PO boxes,
e.g. 10113) we optionally confirm with the contractor's lat/lng via the Census
geocoder (`refine_by_point`, ~10 requests for 424 leads, once).
"""

from __future__ import annotations

import csv
import io
import logging
import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import bindparam, select, update

from ..db import Repository
from ..db.schema import contractors
from ..http import HttpClient

log = logging.getLogger(__name__)

REL_URL = "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt"
REL_FILE = "tab20_zcta520_county20_natl.txt"
GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates"
GEOCODER_HOST = "geocoding.geo.census.gov"
SPLIT_SHARE = 0.9  # below this land share, a ZCTA's county is confirmed by point lookup

STATE_FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
    "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
    "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
    "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
    "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY", "72": "PR",
}
USPS_TO_FIPS = {v: k for k, v in STATE_FIPS.items()}


def cache_dir(path: str | Path | None = None) -> Path:
    """Where large public reference files are cached (LEADMAKER_CACHE_DIR, default data/cache)."""
    p = Path(path or os.environ.get("LEADMAKER_CACHE_DIR") or "data/cache")
    p.mkdir(parents=True, exist_ok=True)
    return p


def state_for_fips(county_fips: str | None) -> str | None:
    return STATE_FIPS.get((county_fips or "")[:2])


def zip5(postal_code: Any) -> str | None:
    digits = "".join(ch for ch in str(postal_code or "") if ch.isdigit())
    return digits[:5] if len(digits) >= 5 else None


@dataclass(frozen=True)
class CountyMatch:
    county_fips: str
    county_name: str  # "Bergen County"
    state: str  # USPS code
    share: float  # land-area share of the ZCTA inside this county
    n_counties: int  # counties the ZCTA touches


class CountyIndex:
    """In-memory ZCTA -> best county, plus county FIPS <-> name lookups."""

    def __init__(self, by_zcta: dict[str, CountyMatch], names: dict[str, str]):
        self.by_zcta = by_zcta
        self.names = names  # county_fips -> "Bergen County"
        self._by_name: dict[tuple[str, str], str] = {}
        for fips, name in names.items():
            st = state_for_fips(fips)
            if st:
                self._by_name[(st, _bare_name(name))] = fips

    @classmethod
    def from_text(cls, text: str) -> "CountyIndex":
        parts: dict[str, list[tuple[int, str]]] = defaultdict(list)
        names: dict[str, str] = {}
        for r in csv.DictReader(io.StringIO(text.lstrip("﻿")), delimiter="|"):
            county = r.get("GEOID_COUNTY_20") or ""
            if not county:
                continue
            names[county] = r.get("NAMELSAD_COUNTY_20") or county
            z = r.get("GEOID_ZCTA5_20")
            if z:  # rows without a ZCTA are county-only (water / unpopulated parts)
                parts[z].append((int(r.get("AREALAND_PART") or 0), county))
        by_zcta: dict[str, CountyMatch] = {}
        for z, ps in parts.items():
            total = sum(p[0] for p in ps) or 1
            land, fips = max(ps)
            by_zcta[z] = CountyMatch(fips, names[fips], state_for_fips(fips) or "", round(land / total, 3), len(ps))
        return cls(by_zcta, names)

    def lookup(self, postal_code: Any) -> CountyMatch | None:
        z = zip5(postal_code)
        return self.by_zcta.get(z) if z else None

    def county(self, fips: str) -> dict[str, Any]:
        """{county_fips, county_name, state} -- the shape the news hook expects."""
        return {"county_fips": fips, "county_name": self.names.get(fips), "state": state_for_fips(fips)}

    def fips_for_name(self, state: str | None, name: str | None) -> str | None:
        """('NJ', 'Bergen') -> '34003'. Used to map NWS storm reports, which carry county names."""
        if not state or not name:
            return None
        return self._by_name.get((state.upper(), _bare_name(name)))


def _bare_name(name: str) -> str:
    n = name.lower().strip()
    for suffix in (" county", " parish", " borough", " census area", " city and borough", " municipality"):
        if n.endswith(suffix):
            return n[: -len(suffix)].strip()
    return n


def load_cached_county_index(cache: str | Path | None = None) -> CountyIndex:
    path = cache_dir(cache) / REL_FILE
    if not path.exists():
        raise FileNotFoundError(f"{path} not cached yet; run load_county_index(http) first")
    return CountyIndex.from_text(path.read_text(encoding="utf-8-sig"))


async def load_county_index(http: HttpClient, cache: str | Path | None = None) -> CountyIndex:
    """Download the relationship file once (cached), then index it."""
    path = cache_dir(cache) / REL_FILE
    if not path.exists():
        resp = await http.get(REL_URL, timeout=300)
        if "GEOID_ZCTA5_20" not in resp.text[:500]:
            raise ValueError(f"unexpected ZCTA relationship file: {resp.text[:200]!r}")
        tmp = path.with_suffix(".part")
        tmp.write_text(resp.text, encoding="utf-8")
        tmp.replace(path)
        log.info("counties: cached %s (%d bytes)", path, path.stat().st_size)
    return load_cached_county_index(cache)


# ------------------------------------------------------------------ assignment
def assign_county_fips(repo: Repository, index: CountyIndex | None = None, *, force: bool = False) -> dict[str, Any]:
    """Fill contractors.county_fips from the ZIP for leads missing it (all leads with force=True).

    Returns counts plus the gaf_ids worth a point check: `unmapped` (no ZCTA for the
    ZIP) and `split` (assigned from a ZCTA whose best county holds < SPLIT_SHARE).
    """
    index = index or load_cached_county_index()
    with repo.engine.connect() as conn:
        rows = conn.execute(
            select(contractors.c.gaf_id, contractors.c.postal_code, contractors.c.county_fips)
        ).all()
    updates: list[dict[str, Any]] = []
    unmapped: list[str] = []
    split: list[str] = []
    already = 0
    for r in rows:
        if r.county_fips and not force:
            already += 1
            continue
        m = index.lookup(r.postal_code)
        if m is None:
            unmapped.append(r.gaf_id)
            continue
        if m.share < SPLIT_SHARE:
            split.append(r.gaf_id)
        if m.county_fips != r.county_fips:
            updates.append({"gid": r.gaf_id, "fips": m.county_fips})
    _set_fips(repo, updates)
    with repo.engine.connect() as conn:
        n_counties = len({
            f for (f,) in conn.execute(select(contractors.c.county_fips).where(contractors.c.county_fips.is_not(None)))
        })
    return {"leads": len(rows), "assigned": len(updates), "already_set": already,
            "unmapped": unmapped, "split": split, "counties": n_counties}


def _set_fips(repo: Repository, updates: list[dict[str, Any]]) -> None:
    if not updates:
        return
    stmt = (
        update(contractors)
        .where(contractors.c.gaf_id == bindparam("gid"))
        .values(county_fips=bindparam("fips"))
    )
    with repo.engine.begin() as conn:
        conn.execute(stmt, updates)


async def county_from_point(http: HttpClient, lat: float, lng: float) -> tuple[str, str] | None:
    """(county_fips, county_name) containing the point, via the Census geocoder; None if outside the US."""
    resp = await http.get(GEOCODER_URL, params={
        "x": lng, "y": lat, "benchmark": "Public_AR_Current", "vintage": "Current_Current",
        "layers": "Counties", "format": "json",
    })
    counties = ((resp.json().get("result") or {}).get("geographies") or {}).get("Counties") or []
    if not counties:
        return None
    return counties[0]["GEOID"], counties[0].get("NAME") or ""


async def refine_by_point(http: HttpClient, repo: Repository, gaf_ids: list[str]) -> dict[str, Any]:
    """Confirm/override the county of split-ZCTA and unmapped leads from their geocoded lat/lng."""
    if not gaf_ids:
        return {"checked": 0, "changed": 0}
    http.set_host_interval(GEOCODER_HOST, 1.5)
    updates: list[dict[str, Any]] = []
    checked = failed = 0
    for c in repo.get_contractors(gaf_ids):
        if c.get("latitude") is None or c.get("longitude") is None:
            continue
        try:
            hit = await county_from_point(http, float(c["latitude"]), float(c["longitude"]))
        except Exception as e:  # the ZCTA answer (if any) stays in place
            failed += 1
            log.warning("counties: point lookup failed for %s: %s", c["gaf_id"], e)
            continue
        checked += 1
        if hit and hit[0] != c.get("county_fips"):
            updates.append({"gid": c["gaf_id"], "fips": hit[0]})
    _set_fips(repo, updates)
    return {"checked": checked, "changed": len(updates), "failed": failed}


def lead_counties(repo: Repository, index: CountyIndex | None = None) -> list[dict[str, Any]]:
    """Distinct lead counties as [{county_fips, county_name, state, leads}], most leads first."""
    with repo.engine.connect() as conn:
        rows = conn.execute(select(contractors.c.county_fips).where(contractors.c.county_fips.is_not(None))).all()
    counts: dict[str, int] = defaultdict(int)
    for (f,) in rows:
        counts[f] += 1
    out = []
    for f, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        info = index.county(f) if index else {"county_fips": f, "county_name": None, "state": state_for_fips(f)}
        out.append({**info, "leads": n})
    return out
