"""County news signals (leadmaker.signals.news) -- offline, against saved live responses.

Fixtures (captured 2026-10-18, trimmed):
  news_gdelt_bergen.json    GDELT DOC ArtList, "Bergen County" + storm/roof/construction terms, 30 days
  news_njcom_bergen.xml     nj.com Bergen County section RSS (first 10 items)
  news_njcom_weather.xml    nj.com weather RSS (state-wide; first 8 items)
  news_brooklynpaper.xml    Brooklyn Paper RSS (first 4 items)
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from leadmaker.config import Settings
from leadmaker.http import HttpError, Response
from leadmaker.signals import news as N

FIX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 18, 18, 0, tzinfo=timezone.utc)

BERGEN = {"county_fips": "34003", "county_name": "Bergen County", "state": "NJ", "towns": ["Hackensack", "Paramus"]}
ESSEX = {"county_fips": "34013", "county_name": "Essex", "state": "NJ", "towns": ["Newark", "West Orange"]}
KINGS = {"county_fips": "36047", "county_name": "Kings County", "state": "NY"}


def rss(*items: tuple[str, str, str, str]) -> str:
    """Minimal RSS document from (title, link, pubDate, description) tuples."""
    body = "".join(
        f"<item><title>{t}</title><link>{u}</link><pubDate>{d}</pubDate><description>{s}</description></item>"
        for t, u, d, s in items
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>{body}</channel></rss>'


class FakeHttp:
    """Stands in for HttpClient: routes by URL (GDELT by the geo phrase in the query)."""

    def __init__(self, routes: dict[str, list[Response] | Response]):
        self.routes = routes
        self.calls: list[tuple[str, dict | None]] = []
        self.intervals: dict[str, float] = {}

    def set_host_interval(self, host: str, seconds: float) -> None:
        self.intervals[host] = seconds

    async def get(self, url, *, params=None, headers=None, allow_statuses=(), **kw):
        self.calls.append((url, params))
        key = url
        if url == N.GDELT_URL:
            key = next((k for k in self.routes if k.startswith("gdelt:") and k[6:] in params["query"]), "gdelt:")
        route = self.routes.get(key)
        if route is None:
            raise HttpError(f"HTTP 404 for {url}", status=404, url=url)
        resp = route.pop(0) if isinstance(route, list) else route
        if not (resp.ok or resp.status in allow_statuses):
            raise HttpError(f"HTTP {resp.status} for {url}", status=resp.status, url=url)
        return resp


def ok(text: str, url: str = "https://example.test/") -> Response:
    return Response(url=url, status=200, text=text, headers={})


def fixture(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def run(coro):
    return asyncio.run(coro)


# ----------------------------------------------------------------- relevance
@pytest.mark.parametrize(
    "text,implied,expected",
    [
        ("Roof torn off Hackensack home in storm", False, ["roof", "storm", "Hackensack"]),
        ("Hail pounds North Jersey", True, ["hail"]),
        ("Hail pounds North Jersey", False, None),  # no place, not implied
        ("Flooding and outages as storm hits US northeast", True, ["flooding", "power outage", "storm"]),
        ("Hit-and-run driver kills N.J. Turnpike worker in construction zone", True, None),  # market term, no place
        ("Paramus approves 300 apartments in redevelopment plan", False, ["redevelopment", "Paramus"]),
        ("Super Football Conference Players of the Week", True, None),
        ("Registered Architect / Project Manager - Fair Lawn, NJ, US | Jobs", True, None),
        ("Freeze warnings grip state as developing nor’easter threatens coast", True, ["nor'easter"]),
        ("Woman arrested for poisoning friend at Fort Lee restaurant", True, None),
    ],
)
def test_relevance(text, implied, expected):
    place_rx = N._place_re(N.place_names(BERGEN))
    got = N.relevance(text, place_rx, place_implied=implied)
    assert (sorted(got) if got else got) == (sorted(expected) if expected else expected)


def test_place_names_and_aliases():
    assert N.place_names(ESSEX) == ["Essex County", "Newark", "West Orange"]
    assert N.place_names(KINGS) == ["Kings County", "Brooklyn"]
    rx = N._place_re(N.place_names({"county_fips": "36085", "county_name": "Richmond County", "state": "NY"}))
    assert rx.search("Staten-Island homeowners clean up") and not rx.search("Richmond, Virginia")


def test_canonical_url_strips_tracking_and_dedupe_key():
    u = N.canonical_url("https://WWW.NJ.com/news/2026/10/roof.html?utm_source=rss&id=7#comments")
    assert u == "https://www.nj.com/news/2026/10/roof.html?id=7"
    assert N._url_key("http://nj.com/news/a/") == N._url_key("https://www.nj.com/news/a")


def test_gdelt_query_shape():
    q = N.gdelt_query(BERGEN)
    assert q.startswith('"Bergen County" "New Jersey" (roof OR ')
    assert '"nor easter"' in q and q.endswith(" housing) sourcelang:english")
    assert len(q) <= N.GDELT_MAX_QUERY_CHARS
    assert "Hackensack" not in q  # towns are too ambiguous for a nationwide full-text search
    # Boroughs: borough name plus the state phrase (Kings County CA, Richmond County GA).
    assert N.gdelt_query(KINGS).startswith('("Kings County" OR Brooklyn) "New York" (roof OR ')
    rich = N.gdelt_query({"county_fips": "36085", "county_name": "Richmond County", "state": "NY"})
    assert rich.startswith('("Richmond County" OR "Staten Island") "New York" (')
    assert len(rich) <= N.GDELT_MAX_QUERY_CHARS
    # Long county names drop the lowest-priority terms instead of tripping GDELT's length limit.
    long_q = N.gdelt_query({"county_fips": "99999", "county_name": "Saint Bartholomew-Of-The-Long-Name County",
                            "state": "NY"})
    assert len(long_q) <= N.GDELT_MAX_QUERY_CHARS and "roof OR roofing" in long_q and "housing" not in long_q


# --------------------------------------------------------------------- GDELT
def test_gdelt_live_fixture_keeps_only_the_noreaster_stories():
    arts = N.parse_gdelt(fixture("news_gdelt_bergen.json"))
    assert len(arts) == 12
    cands = N.gdelt_candidates(BERGEN, arts, "q")
    titles = {c.title for c in cands}
    # 12 hits -> the Sept 26-27 nor'easter story. Cemetery PR, job ad, Venezuela/UN etc. are
    # dropped, and so are the 5 AAP copies of "Flooding and outages as storm hits US northeast":
    # weather words only, and Bergen is merely mentioned in the body.
    assert titles == {"400 flights cancelled, 100, 000 without power as Nor-easter hits US East Coast"}
    assert len(cands) == 1
    c = next(c for c in cands if "Nor-easter" in c.title)
    assert c.published_at == datetime(2026, 9, 27, 2, 30, tzinfo=timezone.utc)
    assert c.outlet == "timesofindia.indiatimes.com" and c.matched_terms == ["nor'easter"]


def test_parse_gdelt_rejects_plain_text_errors():
    with pytest.raises(ValueError):
        N.parse_gdelt("The specified phrase is too short.")
    assert N.parse_gdelt("{}") == []


def test_gdelt_429_cooldown_then_success(monkeypatch):
    monkeypatch.setattr(N, "GDELT_COOLDOWN_S", (0.0, 0.0))
    limited = Response(url=N.GDELT_URL, status=429, text="Please limit requests to one every 5 seconds", headers={})
    http = FakeHttp({"gdelt:": [limited, limited, ok(fixture("news_gdelt_bergen.json"))]})
    rows = run(N.fetch_county_news(http, Settings(), [BERGEN], sources=(N.GDELT_SOURCE,), now=NOW))
    assert len(http.calls) == 3
    assert http.intervals[N.GDELT_HOST] >= 5.0
    assert {r["payload"]["title"] for r in rows} == {
        "400 flights cancelled, 100, 000 without power as Nor-easter hits US East Coast",
    }


def test_gdelt_persistent_429_skips_county_but_keeps_others(monkeypatch):
    monkeypatch.setattr(N, "GDELT_COOLDOWN_S", (0.0,))
    limited = Response(url=N.GDELT_URL, status=429, text="slow down", headers={})
    http = FakeHttp({
        'gdelt:"Essex County"': [limited, limited],
        'gdelt:"Bergen County"': ok(fixture("news_gdelt_bergen.json")),
    })
    rows = run(N.fetch_county_news(http, Settings(), [ESSEX, BERGEN], sources=(N.GDELT_SOURCE,), now=NOW))
    assert {r["county_fips"] for r in rows} == {"34003"}


# ----------------------------------------------------------------------- RSS
def test_real_county_feeds_have_no_false_positives():
    for name, county in (("news_njcom_bergen.xml", BERGEN), ("news_brooklynpaper.xml", KINGS)):
        items = N.parse_rss(fixture(name))
        assert items and all(i["url"] and i["published"] for i in items)
        assert N.rss_candidates(county, items, name, county_feed=True) == []


def test_state_feed_needs_county_or_town_named():
    items = N.parse_rss(fixture("news_njcom_weather.xml"))
    assert len(items) == 8
    # The live nor'easter forecast names no county: dropped from the state-wide feed...
    assert N.rss_candidates(BERGEN, items, "w", county_feed=False) == []
    # ...but the same headline in a county-section feed counts.
    kept = N.rss_candidates(BERGEN, items, "w", county_feed=True)
    # nor'easter x2, severe-storm x3; fall colors dropped, and so is the freeze warning whose
    # only nor'easter mention is in its summary (summaries place a story, never supply its topic).
    assert len(kept) == 5
    assert not any(c.title.startswith("Freeze warning issued for 5") for c in kept)
    assert [c.matched_terms for c in kept if "nor’easter" in c.title] == [["nor'easter"], ["nor'easter"]]
    assert ["damaging winds", "severe storm"] in [c.matched_terms for c in kept]


def test_summary_places_but_never_supplies_the_topic():
    # Real county-section items from 2026-10-18 that matched only through their summaries.
    items = [
        {"title": "Hit-and-run driver kills N.J. Turnpike worker, cops say",
         "url": "https://www.nj.com/middlesex/2026/10/"
                "hit-and-run-driver-strikes-kills-construction-worker-on-nj-turnpike-cops-say.html",
         "published": NOW,
         "summary": "A 47-year-old worker was hit in a marked construction zone south of exit 10 in Middlesex County."},
        {"title": "FDNY takes on two-alarm blaze at vacant West Farms commercial building",
         "url": "https://www.bxtimes.com/fdny-west-farms-blaze/", "published": NOW,
         "summary": "Fire personnel arrived to find heavy smoke and fire showing from the second floor and "
                    "through the roof."},
    ]
    middlesex = {"county_fips": "34023", "county_name": "Middlesex County", "state": "NJ"}
    assert N.rss_candidates(middlesex, items[:1], "f", county_feed=True) == []
    assert N.rss_candidates({"county_fips": "36005", "county_name": "Bronx County", "state": "NY"},
                            items[1:], "f", county_feed=True) == []
    # A state-wide item still counts when only its summary names the county.
    state_item = {"title": "Severe storms topple trees, cut power", "published": NOW,
                  "url": "https://www.nj.com/weather/2026/10/trees.html",
                  "summary": "Most of the damage was in Bergen County."}
    kept = N.rss_candidates(BERGEN, [state_item], "w", county_feed=False)
    assert [c.matched_terms for c in kept] == [["severe storm", "Bergen County"]]
    assert kept[0].place_in_title is False


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Baseball-sized hail smashes roofs in Paramus", ["hail", "roof", "Paramus"]),
        ("Softball size hail reported in Hackensack", ["hail", "Hackensack"]),
        ("Ramsey storms back to beat Mahwah in girls volleyball", None),
        ("St. John's Red Storm rout Seton Hall", None),
        ("Paramus Home of the Week: $3.2M residence features pool, motorized roof", None),
    ],
)
def test_noise_filter_spares_hail_sizes(text, expected):
    got = N.relevance(text, N._place_re(N.place_names(BERGEN)), place_implied=True)
    assert (sorted(got) if got else got) == (sorted(expected) if expected else expected)


def _routes_for_full_run() -> dict:
    bergen_feed = N.COUNTY_FEEDS["34003"][0]
    essex_feed = N.COUNTY_FEEDS["34013"][0]
    weather_feed = N.STATE_FEEDS["NJ"][0]
    day = "Thu, 15 Oct 2026 14:00:00 +0000"
    return {
        'gdelt:"Bergen County"': ok(fixture("news_gdelt_bergen.json")),
        'gdelt:"Essex County"': ok("{}"),
        bergen_feed: ok(rss(
            ("Hail damage reported across Paramus, Hackensack after Friday storms",
             "https://www.nj.com/bergen/2026/10/hail-damage-paramus.html?utm_source=rss", day, "Roofs dented."),
            ("Old roof collapse story", "https://www.nj.com/bergen/2026/08/old.html",
             "Mon, 10 Aug 2026 14:00:00 +0000", "Too old."),
            ("Woman arrested for poisoning friend at Fort Lee restaurant",
             "https://www.nj.com/bergen/2026/10/poison.html", day, ""),
        ), bergen_feed),
        essex_feed: ok(fixture("news_njcom_bergen.xml"), essex_feed),  # no relevant items
        weather_feed: ok(rss(
            ("Damaging winds topple trees in Newark and Hackensack",
             "https://www.nj.com/weather/2026/10/winds-newark-hackensack.html", day, ""),
            ("Severe storms possible statewide Friday",
             "https://www.nj.com/weather/2026/10/statewide.html", day, ""),
            # Same story the Bergen section carries (http, no www, trailing slash): one article.
            ("Hail damage reported across Paramus, Hackensack after Friday storms",
             "http://nj.com/bergen/2026/10/hail-damage-paramus.html/", day, ""),
        ), weather_feed),
    }


def test_full_run_rows_dedupe_and_attribution():
    http = FakeHttp(_routes_for_full_run())
    rows = run(N.fetch_county_news(http, Settings(), [BERGEN, ESSEX], now=NOW))

    by = {(r["county_fips"], r["payload"]["title"]): r for r in rows}
    assert len(by) == len(rows)  # no duplicate (county, article) rows
    titles_34003 = {t for f, t in by if f == "34003"}
    titles_34013 = {t for f, t in by if f == "34013"}

    # County-section RSS item, with the tracking param stripped and the 2nd copy merged.
    hail = by[("34003", "Hail damage reported across Paramus, Hackensack after Friday storms")]
    assert hail["source"] == N.RSS_SOURCE
    assert hail["external_id"] == "https://www.nj.com/bergen/2026/10/hail-damage-paramus.html"
    assert hail["payload"]["summary"] == "Roofs dented."
    assert hail["payload"]["outlet"] == "nj.com"
    assert {"hail", "Paramus"} <= set(hail["payload"]["matched_terms"])
    assert hail["valid_from"] == datetime(2026, 10, 15, 14, 0, tzinfo=timezone.utc)
    assert hail["valid_to"] - hail["valid_from"] == timedelta(days=14)
    assert hail["fetched_at"] == NOW and hail["kind"] == "news"
    assert "Hail damage reported across Paramus, Hackensack after Friday storms" not in titles_34013

    # Headline names a town in each county -> one row per county, sharing one external_id.
    winds = [r for r in rows if r["payload"]["title"].startswith("Damaging winds")]
    assert sorted(r["county_fips"] for r in winds) == ["34003", "34013"]
    assert len({r["external_id"] for r in winds}) == 1
    assert winds[0]["payload"]["counties"] == ["34003", "34013"]

    # State-wide story naming no county, 80-day-old item, and crime story are all dropped.
    assert "Severe storms possible statewide Friday" not in titles_34003 | titles_34013
    assert "Old roof collapse story" not in titles_34003
    assert not any("poisoning" in t for t in titles_34003)

    # GDELT row: attribution and the query that found it are kept.
    toi = [r for r in rows if r["payload"]["outlet"] == "timesofindia.indiatimes.com"]
    assert len(toi) == 1 and toi[0]["source"] == N.GDELT_SOURCE and toi[0]["county_fips"] == "34003"
    assert "gdeltproject.org" in toi[0]["payload"]["attribution"]
    assert toi[0]["payload"]["query"].startswith('"Bergen County"')

    # Each feed fetched once even though two counties use the state feed.
    feed_calls = [u for u, _ in http.calls if u != N.GDELT_URL]
    assert len(feed_calls) == len(set(feed_calls)) == 3
    assert {urlsplit(u).netloc for u in feed_calls} <= set(http.intervals)


def test_feed_failure_is_skipped():
    routes = _routes_for_full_run()
    del routes[N.COUNTY_FEEDS["34003"][0]]  # -> 404
    http = FakeHttp(routes)
    rows = run(N.fetch_county_news(http, Settings(), [BERGEN, ESSEX], now=NOW))
    assert any(r["payload"]["title"].startswith("Damaging winds") for r in rows)
    # The hail story still arrives via the state feed (it names Paramus/Hackensack).
    assert any(r["payload"]["title"].startswith("Hail damage") and r["county_fips"] == "34003" for r in rows)


def test_county_without_name_skips_gdelt_but_keeps_county_feed():
    feed = N.COUNTY_FEEDS["34003"][0]
    http = FakeHttp({feed: ok(rss(("Roofers busy after hail", "https://www.nj.com/bergen/2026/10/hail.html",
                                   "Thu, 15 Oct 2026 14:00:00 +0000", "")), feed)})
    rows = run(N.fetch_county_news(http, Settings(), [{"county_fips": "34003", "county_name": None, "state": "NJ"}],
                                   now=NOW))
    assert all(u != N.GDELT_URL for u, _ in http.calls)
    assert [r["payload"]["matched_terms"] for r in rows] == [["hail", "roofer"]]


def _gdelt_article(title: str, url: str, seen: str = "20261001T120000Z", domain: str | None = None) -> dict:
    return {"url": url, "title": title, "seendate": seen, "domain": domain or urlsplit(url).netloc,
            "language": "English", "sourcecountry": "United States"}


def test_syndicated_copies_collapse_and_county_cap():
    # Real pattern from the live Kings County run: one iHeart story on many station sites.
    copies = [
        _gdelt_article(f"Cleanup Continues From Powerful Noreaster | NewsRadio {i} AM",
                       f"https://station{i}.iheart.com/content/2026-09-29-cleanup-continues/")
        for i in range(5)
    ]
    others = [
        _gdelt_article(f"Brooklyn roof collapse #{i} after storm", f"https://bkreader.com/roof-{i}/",
                       seen=f"202610{10 + i:02d}T120000Z")
        for i in range(4)
    ]
    cands = N.gdelt_candidates(KINGS, copies + others, "q")
    assert len(cands) == 9
    rows = N.to_rows(N.merge(cands, since=NOW - timedelta(days=30)), fetched_at=NOW, per_county=3)
    titles = [r["payload"]["title"] for r in rows]
    assert len(rows) == 3
    # Headlines naming Brooklyn outrank the regional story; newest first among equals.
    assert sorted(titles) == ["Brooklyn roof collapse #1 after storm", "Brooklyn roof collapse #2 after storm",
                              "Brooklyn roof collapse #3 after storm"]
    rows = N.to_rows(N.merge(cands, since=NOW - timedelta(days=30)), fetched_at=NOW)
    assert sum("Cleanup Continues" in r["payload"]["title"] for r in rows) == 1


def test_press_release_wires_are_dropped():
    arts = [
        _gdelt_article("PSEG: Ahead of Peak Hurricane Season, PSE & G Highlights Strong Reliability Results",
                       "https://www.finanznachrichten.de/nachrichten-2026-09/pseg.htm", domain="finanznachrichten.de"),
        _gdelt_article("Licensed Roofing Services Expand Across Bergen County, NJ",
                       "https://www.prnewswire.com/news-releases/roofing-bergen-301.html"),
        _gdelt_article("Hail dents roofs across Bergen County", "https://www.northjersey.com/story/news/hail/"),
        # Live 2026-10-18: a newspaper mirroring a wire release under a /...newswire/ path.
        _gdelt_article("Republic Claims Associates, Public Adjuster in Ocean County NJ, Opens Noreaster Claim Help",
                       "https://www.manilatimes.net/2026/10/01/tmt-newswire/globenewswire/republic-claims/2436651"),
    ]
    assert [c.title for c in N.gdelt_candidates(BERGEN, arts, "q")] == ["Hail dents roofs across Bergen County"]
