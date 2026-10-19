"""End-to-end harness: drive `leadmaker.cli.main` offline against saved real responses.

Every request any pipeline makes goes through `leadmaker.http.HttpClient.request`, which is
replaced by `Router`: a URL router that serves the saved fixtures in tests/fixtures and answers
404 for anything it does not know. Unknown URLs are recorded in `router.unrouted`, so a test can
prove a command contacted only the sources it should. Anything that bypasses the router (a raw
socket, DNS lookup or curl_cffi session) raises instead of reaching the network. The signals and news clocks are frozen at
NOW (timing badges, NWS retention and the 24-month storm window all depend on "now").

The area is the real Coveo fixture (6 contractors around 10013) plus one more contractor, ADH
Group (gaf_id 1136285), cloned from a fixture record and filled with its real listing values (as
in tests/test_enrich_nyc_dcwp.py). Its GAF profile (gaf_profile_master_elite.html) names the
legal entity "Makabad Corp", which the NYC DCWP and NY DOS fixtures hold, so the chain
scrape -> profile -> registry match runs on real data. Gemz Construction's profile is
gaf_profile_certified.html; the other five profile pages 404 (failures are per contractor).
"""

from __future__ import annotations

import contextlib
import copy
import csv
import gzip
import importlib.util
import io
import json
import shutil
import socket
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

import pytest

from leadmaker import cli
from leadmaker.http import HttpClient, HttpError, Response

FIX = Path(__file__).resolve().parent.parent / "fixtures"
NOW = datetime(2026, 10, 18, 16, 0, tzinfo=timezone.utc)
CONTACT = "LeadMaker e2e tests (ops@example.com)"

COVEO_HOST = "gafmaterialscorporationproduction3yalqk12.org.coveo.com"
LISTING_URL = "https://www.gaf.com/en-us/roofing-contractors/residential"

ADH = {
    "gaf_id": "1136285", "name": "ADH Group", "city": "College Point", "state": "NY", "postal_code": "11356",
    "phone": "(929) 215-3378", "latitude": 40.783825, "longitude": -73.846635, "distance": 9.31,
    "uri": "https://www.gaf.com/en-us/roofing-contractors/residential/usa/ny/college-point/adh-group-1136285",
}
GEMZ_ID, JERSEY_ID, GOLOVIN_ID, HAYDEN_ID, BLUEMASTER_ID, TOPLINE_ID = (
    "7158488", "1141159", "7158181", "61620", "7157466", "7158169")
# GAF's "Most Relevant" ranking for the area (the request without a distance sort).
RECOMMENDED = [JERSEY_ID, ADH["gaf_id"], HAYDEN_ID]

# The suite's FMCSA carrier row for Jersey Roofing (tests/test_enrich_fmcsa.py): matches on phone.
FMCSA_JERSEY = {"dot_number": "111", "legal_name": "JERSEY ROOFING LLC", "phone": "2019822718", "phy_zip": "07026",
                "phy_city": "GARFIELD", "phy_state": "NJ", "company_officer_1": "JOHN Q PUBLIC",
                "company_officer_2": "", "email_address": "Owner@Example.com", "power_units": "3",
                "total_drivers": "2"}

# Real county of each lead ZIP (Census 2020 ZCTA relationship), appended to the trimmed fixture.
ZIP_COUNTIES = {
    "11358": ("36081", "Queens County"), "11355": ("36081", "Queens County"), "11434": ("36081", "Queens County"),
    "11356": ("36081", "Queens County"), "10983": ("36087", "Rockland County"),
    "11518": ("36059", "Nassau County"), "07026": ("34003", "Bergen County"),
}
LEAD_COUNTIES = {"36081": 4, "36087": 1, "36059": 1, "34003": 1}

NCEI_2026 = "StormEvents_details-ftp_v1.0_d2026_c20260918.csv.gz"
ZONE_FILE = "bp16ap26.dbx"
NJCOM = "https://www.nj.com/arc/outboundfeeds/rss/category/{}/?outputType=xml"


def _fixture(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def coveo_results() -> list[dict[str, Any]]:
    """The real Coveo fixture's 6 results plus ADH Group (cloned from BlueMaster, a Master Elite)."""
    base = json.loads(_fixture("coveo_search_response.json"))["results"]
    adh = copy.deepcopy(next(r for r in base if r["raw"]["gaf_contractor_id"] == BLUEMASTER_ID))
    adh["title"] = adh["Title"] = ADH["name"]
    for k in ("uri", "clickUri", "printableUri", "Uri", "ClickUri", "PrintableUri"):
        adh[k] = ADH["uri"]
    raw = adh["raw"]
    raw.update({
        "gaf_contractor_id": ADH["gaf_id"], "title": ADH["name"], "systitle": ADH["name"],
        "gaf_navigation_title": ADH["name"], "gaf_featured_image_alt": ADH["name"],
        "gaf_address": f"{ADH['city']}, {ADH['state']} {ADH['postal_code']}", "gaf_f_city": ADH["city"],
        "gaf_f_state_code": ADH["state"], "gaf_postal_code": ADH["postal_code"], "gaf_phone": ADH["phone"],
        "gaf_latitude": ADH["latitude"], "gaf_longitude": ADH["longitude"], "distanceinmiles": ADH["distance"],
        "gaf_number_of_reviews": 3, "gaf_rating": 5.0, "uri": ADH["uri"], "clickableuri": ADH["uri"],
        "sysuri": ADH["uri"], "sysclickableuri": ADH["uri"], "identifiableuri": ADH["uri"],
    })
    raw.pop("gaf_google_place_id", None)
    raw.pop("gaf_featured_image_src", None)
    return base + [adh]


def zcta_relationship_text() -> str:
    """The trimmed Census ZCTA->county fixture plus one full-share row per lead ZIP."""
    text = _fixture("zcta_county_sample.txt").lstrip("﻿")
    reader = csv.DictReader(io.StringIO(text), delimiter="|")
    rows = list(reader)
    template = next(r for r in rows if r["GEOID_ZCTA5_20"])
    for z, (fips, name) in ZIP_COUNTIES.items():
        rows.append({**template, "GEOID_ZCTA5_20": z, "NAMELSAD_ZCTA5_20": f"ZCTA5 {z}",
                     "GEOID_COUNTY_20": fips, "NAMELSAD_COUNTY_20": name,
                     "AREALAND_PART": template["AREALAND_ZCTA5_20"]})
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=reader.fieldnames, delimiter="|", lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return "﻿" + out.getvalue()


# ----------------------------------------------------------------------------- router
@dataclass
class Call:
    method: str
    url: str
    params: dict[str, Any] | None = None
    json: Any = None
    data: Any = None
    headers: dict[str, str] | None = None

    @property
    def host(self) -> str:
        return urlsplit(self.url).netloc.lower()


Reply = tuple[int, "str | bytes"]


@dataclass
class Router:
    """Stands in for HttpClient.request: (method, url predicate) -> handler(call) -> (status, body)."""

    routes: list[tuple[str, Callable[[str], bool], Callable[[Call], Reply]]] = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)
    unrouted: list[Call] = field(default_factory=list)

    def add(self, method: str, match: str | Callable[[str], bool], handler: Callable[[Call], Reply] | Reply) -> None:
        pred = (lambda u, m=match: u == m) if isinstance(match, str) else match
        fn = handler if callable(handler) else (lambda call, h=handler: h)
        self.routes.insert(0, (method, pred, fn))  # later routes override earlier ones

    def hosts(self) -> set[str]:
        return {c.host for c in self.calls}

    def to(self, host: str) -> list[Call]:
        return [c for c in self.calls if c.host == host]

    async def request(self, client: HttpClient, method: str, url: str, *, headers=None, json=None, data=None,
                      params=None, retries=None, allow_statuses=(), timeout=None) -> Response:
        call = Call(method, url, dict(params) if params else None, json, data, dict(headers or {}))
        self.calls.append(call)
        client.stats["requests"] += 1
        for m, pred, fn in self.routes:
            if m == method and pred(url):
                status, body = fn(call)
                break
        else:
            self.unrouted.append(call)
            status, body = 404, "Not Found"
        text = body.decode("latin-1") if isinstance(body, bytes) else body
        content = body if isinstance(body, bytes) else body.encode()
        resp = Response(url=url, status=status, text=text, headers={}, content=content)
        if resp.ok or status in allow_statuses:
            return resp
        client.stats["failures"] += 1
        raise HttpError(f"HTTP {status} for {url}", status=status, url=url)


def default_routes(router: Router) -> Router:
    """Every source the Section 1 pipeline reads, served from saved responses."""
    from leadmaker.enrich import fmcsa, ny_dos, nyc_dcwp, osm
    from leadmaker.signals import counties, news, storms, weather

    results = coveo_results()

    # --- GAF: listing page (Coveo config), Coveo search, profile pages -------------
    router.add("GET", LISTING_URL, (200, _fixture("gaf_listing.html")))

    def coveo(call: Call) -> Reply:
        body = call.json or {}
        if "sortCriteria" in body:  # area read, paginated by distance
            page = results[body["firstResult"]: body["firstResult"] + body["numberOfResults"]]
        else:  # GAF "recommended" ranking
            by_id = {r["raw"]["gaf_contractor_id"]: r for r in results}
            page = [by_id[i] for i in RECOMMENDED]
        return 200, json.dumps({"totalCount": len(results), "results": page})

    router.add("POST", lambda u: urlsplit(u).netloc == COVEO_HOST, coveo)
    router.add("GET", ADH["uri"], (200, _fixture("gaf_profile_master_elite.html")))
    gemz = next(r["raw"]["uri"] for r in results if r["raw"]["gaf_contractor_id"] == GEMZ_ID)
    router.add("GET", gemz, (200, _fixture("gaf_profile_certified.html")))

    # --- enrichers -------------------------------------------------------------------
    dcwp_rows = json.loads(_fixture("nyc_dcwp_hic_sample.json"))

    def dcwp(call: Call) -> Reply:
        off, lim = int(call.params["$offset"]), int(call.params["$limit"])
        return 200, json.dumps(dcwp_rows[off: off + lim])

    router.add("GET", nyc_dcwp.DATASET_URL, dcwp)

    dos = json.loads(_fixture("ny_dos_queries.json"))

    def ny(call: Call) -> Reply:
        pattern = call.params["$where"].split("like '", 1)[1].rstrip("'")
        return 200, json.dumps(dos.get(pattern, []))

    router.add("GET", ny_dos.DATASET_URL, ny)

    census_rows = json.loads(_fixture("fmcsa_census_sample.json"))

    def carriers(call: Call) -> Reply:
        where = call.params["$where"]
        if where.startswith("phone in("):
            hits = [r for r in census_rows + [FMCSA_JERSEY] if f"'{r.get('phone')}'" in where]
            return 200, json.dumps(hits)
        return 200, json.dumps(census_rows)  # keyword query: real NY/NJ carrier rows (noise)

    router.add("GET", fmcsa.URL, carriers)
    router.add("POST", osm.OVERPASS_ENDPOINTS[0], (200, _fixture("osm_overpass_sample.json")))

    # --- signals: counties, NWS alerts, storm history, news ---------------------------
    router.add("GET", counties.REL_URL, (200, zcta_relationship_text()))
    router.add("GET", weather.HISTORY_URL, (200, _fixture("nws_alerts_history_sample.json")))
    router.add("GET", weather.ACTIVE_URL, (200, _fixture("nws_alerts_active_sample.json")))
    router.add("GET", storms.ZONE_PAGE, (200, f'<a href="/source/gis/Shapefiles/County/{ZONE_FILE}">{ZONE_FILE}</a>'))
    router.add("GET", storms.ZONE_BASE + ZONE_FILE, (200, _fixture("storm_zones_sample.dbx")))
    router.add("GET", storms.NCEI_BASE, (200, f'<a href="{NCEI_2026}">{NCEI_2026}</a> 2026-09-18 12M'))
    router.add("GET", storms.NCEI_BASE + NCEI_2026,
               (200, gzip.compress(_fixture("storm_ncei_details_sample.csv").encode("latin-1"), mtime=0)))
    lsr = json.loads(_fixture("storm_lsr_sample.json"))

    def storm_reports(call: Call) -> Reply:  # IEM answers only reports inside [sts, ets] (UTC)
        start = datetime.strptime(call.params["sts"], "%Y%m%d%H%M").strftime("%Y-%m-%dT%H:%M")
        end = datetime.strptime(call.params["ets"], "%Y%m%d%H%M").strftime("%Y-%m-%dT%H:%M")
        feats = [f for f in lsr["features"] if start <= f["properties"]["valid"][:16] <= end]
        return 200, json.dumps({**lsr, "features": feats})

    router.add("GET", storms.LSR_URL, storm_reports)

    gdelt_bergen = _fixture("news_gdelt_bergen.json")
    router.add("GET", news.GDELT_URL,
               lambda call: (200, gdelt_bergen if '"Bergen County"' in call.params["query"] else '{"articles": []}'))
    router.add("GET", NJCOM.format("bergen"), (200, _fixture("news_njcom_bergen.xml")))
    router.add("GET", NJCOM.format("weather"), (200, _fixture("news_njcom_weather.xml")))
    return router


# ------------------------------------------------------------------------ environment
def freeze_clock(mp: pytest.MonkeyPatch, now: datetime) -> None:
    """Freeze "now" for the signals pipeline, timing badges (read time), the news fetcher and
    `leadmaker validate`, so storm/alert ages are judged on the same clock that stamped them."""

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            return now if tz is None else now.astimezone(tz)

    mp.setattr("leadmaker.pipeline.signals.datetime", Frozen)
    mp.setattr("leadmaker.signals.news.datetime", Frozen)
    if importlib.util.find_spec("leadmaker.validate") is not None:
        mp.setattr("leadmaker.validate.datetime", Frozen)


SECRET_ENV = (
    "DATABASE_URL", "GOOGLE_MAPS_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "LEADMAKER_LLM_PROVIDER", "LEADMAKER_LLM_BASE_URL", "LEADMAKER_LLM_API_KEY", "LEADMAKER_LLM_MODEL",
    "SOCRATA_APP_TOKEN", "LEADMAKER_TAG_RULES", "LEADMAKER_EXTRACTION_SLOTS", "BRAVE_API_KEY", "SERPAPI_KEY",
    "SERPAPI_API_KEY", "LEADMAKER_USER_JOBS_PER_HOUR", "BRAVE_SEARCH_API_KEY", "LEADMAKER_LLM_RPM",
    "LEADMAKER_LLM_RPD", "LEADMAKER_PROFILE_TTL_HOURS", "LEADMAKER_ENRICHMENT_TTL_HOURS", "LEADMAKER_HTTP_TIMEOUT",
)


def block_real_network(mp: pytest.MonkeyPatch) -> None:
    """Fail loudly if anything reaches the network without going through HttpClient.request."""

    def refuse(*_a: Any, **_k: Any):
        raise RuntimeError("e2e tests are offline: a request bypassed the fixture router")

    mp.setattr("leadmaker.http.AsyncSession", refuse)  # curl_cffi does not use Python sockets
    mp.setattr(socket.socket, "connect", refuse)
    mp.setattr(socket.socket, "connect_ex", refuse)
    mp.setattr(socket, "create_connection", refuse)
    mp.setattr(socket, "getaddrinfo", refuse)


def install_offline(mp: pytest.MonkeyPatch, workdir: Path) -> Router:
    """Point every setting at workdir, drop real keys, freeze the signals clock, route all HTTP."""
    for k in SECRET_ENV:
        mp.delenv(k, raising=False)
    mp.setenv("LEADMAKER_CACHE_DIR", str(workdir / "cache"))
    mp.setenv("LEADMAKER_LLM_USAGE_FILE", str(workdir / "llm_usage.json"))
    mp.setenv("LEADMAKER_CONTACT", CONTACT)
    mp.setenv("LEADMAKER_HOST_INTERVAL", "0")
    mp.setenv("LEADMAKER_MAX_RETRIES", "0")
    mp.setenv("LEADMAKER_CONCURRENCY", "4")
    mp.chdir(workdir)  # a stray relative path (data/...) lands in the temp dir, never the repo

    router = default_routes(Router())

    async def aenter(self):
        return self

    async def aexit(self, *exc):
        return None

    async def request(self, method, url, **kw):
        return await router.request(self, method, url, **kw)

    mp.setattr(HttpClient, "__aenter__", aenter)
    mp.setattr(HttpClient, "__aexit__", aexit)
    mp.setattr(HttpClient, "request", request)
    block_real_network(mp)
    freeze_clock(mp, NOW)
    return router


@dataclass
class Result:
    rc: int
    out: str
    err: str

    @property
    def json(self) -> Any:
        return json.loads(self.out)


@dataclass
class Cli:
    """Runs `leadmaker --db <db> ...` in-process and captures stdout/stderr."""

    db_path: Path
    workdir: Path
    router: Router

    @property
    def db_url(self) -> str:
        return f"sqlite:///{self.db_path}"

    def __call__(self, *argv: str) -> Result:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(["--db", self.db_url, *argv])
        return Result(rc, out.getvalue(), err.getvalue())

    def repo(self):
        from leadmaker.db import Repository

        return Repository(self.db_url)


# ----------------------------------------------------------------------- the pipeline
@dataclass
class Pipeline:
    """One full offline run: scrape -> enrich -> tag -> signals -> export (csv + json)."""

    cli: Cli
    steps: dict[str, Result]
    csv_path: Path
    json_path: Path
    calls_by_step: dict[str, list[Call]]


ENRICH_SOURCES = "nyc_dcwp,ny_dos,fmcsa,osm,website_crawl,llm_extract"


@pytest.fixture(scope="module")
def pipeline(tmp_path_factory) -> Pipeline:
    work = tmp_path_factory.mktemp("e2e_pipeline")
    mp = pytest.MonkeyPatch()
    try:
        router = install_offline(mp, work)
        run = Cli(work / "e2e.db", work, router)
        steps: dict[str, Result] = {}
        calls: dict[str, list[Call]] = {}
        csv_path, json_path = work / "out" / "leads.csv", work / "out" / "leads.json"
        plan = {
            "scrape": ("scrape", "--zip", "10013", "--radius", "25"),
            "enrich": ("enrich", "--sources", ENRICH_SOURCES),
            "tag": ("tag",),
            "signals": ("signals",),
            "export_csv": ("export", "--format", "csv", "--out", str(csv_path)),
            "export_json": ("export", "--format", "json", "--out", str(json_path)),
        }
        for name, argv in plan.items():
            before = len(router.calls)
            steps[name] = run(*argv)
            calls[name] = router.calls[before:]
        yield Pipeline(run, steps, csv_path, json_path, calls)
    finally:
        mp.undo()


@pytest.fixture
def offline(tmp_path, monkeypatch) -> Cli:
    """A fresh, empty database with all HTTP routed to fixtures."""
    router = install_offline(monkeypatch, tmp_path)
    return Cli(tmp_path / "e2e.db", tmp_path, router)


@pytest.fixture
def built(pipeline: Pipeline, tmp_path, monkeypatch) -> Cli:
    """A private copy of the fully built pipeline database (safe to mutate)."""
    router = install_offline(monkeypatch, tmp_path)
    src, dst = sqlite3.connect(pipeline.cli.db_path), sqlite3.connect(tmp_path / "e2e.db")
    try:
        src.backup(dst)  # the DB runs in WAL mode: copying the file alone would miss committed rows
    finally:
        src.close()
        dst.close()
    shutil.copytree(pipeline.cli.workdir / "cache", tmp_path / "cache", dirs_exist_ok=True)
    return Cli(tmp_path / "e2e.db", tmp_path, router)
