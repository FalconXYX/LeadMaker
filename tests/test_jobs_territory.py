"""Territories page (the manager's /api/admin/territories): a refresh job records its headline numbers (found /
new / updated) in its result for the run history, reads a territory's extra ZIPs, and manual-only schedules
(every_hours NULL) are never fired by the worker."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select

from leadmaker.db.repository import utcnow
from leadmaker.db.schema import jobs, schedules
from leadmaker.jobs import JobQueue, execute, refresh_stats
from leadmaker.pipeline.scrape import ScrapeReport
from leadmaker.models import SearchArea

from fakes import offline_settings


def report(postal_code: str, radius: float, parsed: int, new: int, changed: int, unchanged: int = 0) -> ScrapeReport:
    return ScrapeReport(
        run_id=1, status="succeeded",
        area=SearchArea(postal_code=postal_code, country="US", radius_miles=radius, latitude=40.7, longitude=-74.0,
                        geocoder="manual"),
        stats={"parsed": parsed, "results": parsed, "upsert": {"new": new, "changed": changed, "unchanged": unchanged}},
    )


@pytest.fixture
def chain(monkeypatch) -> dict[str, list[Any]]:
    """Fakes the network steps of a refresh (scrape, counties); tagging and follow-ups run for real."""
    import leadmaker.pipeline.scrape as scrape
    import leadmaker.pipeline.signals as signals

    calls: dict[str, list[Any]] = {"scrape": [], "counties": []}
    counts = {"10013": (40, 3, 5, 32), "10014": (10, 2, 1, 7)}

    async def fake_scrape(settings, repo, opts):
        calls["scrape"].append(opts)
        return report(opts.postal_code, opts.radius_miles, *counts.get(opts.postal_code, (0, 0, 0, 0)))

    async def fake_counties(settings, repo, ids):
        calls["counties"].append(ids)
        return {"assigned": 0}

    monkeypatch.setattr(scrape, "run_scrape", fake_scrape)
    monkeypatch.setattr(signals, "run_counties", fake_counties)
    monkeypatch.setenv("LEADMAKER_INSIGHTS_ON_REFRESH", "0")
    monkeypatch.setenv("LEADMAKER_BRIEFING_ON_REFRESH", "0")
    return calls


def test_refresh_stats_sums_found_new_and_updated():
    assert refresh_stats([report("10013", 25, 40, 3, 5, 32), report("10014", 25, 10, 2, 1)]) == {
        "found": 50, "new": 5, "updated": 6}
    # A read that stored nothing (or recorded no counts) adds zeros rather than failing.
    empty = ScrapeReport(run_id=2, status="partial", stats={})
    assert refresh_stats([empty]) == {"found": 0, "new": 0, "updated": 0}


async def test_a_scrape_job_records_found_new_and_updated(repo, chain):
    out = await execute(offline_settings(), repo, "scrape", {"postal_code": "10013", "radius_miles": 25})
    assert out["stats"] == {"found": 40, "new": 3, "updated": 5}
    assert out["scrape"]["upsert"] == {"new": 3, "changed": 5, "unchanged": 32}  # unchanged shape
    assert "also_zips" not in out
    assert [o.postal_code for o in chain["scrape"]] == ["10013"]


async def test_a_territory_job_reads_its_extra_zips_with_the_same_radius(repo, chain):
    params = {"postal_code": "10013", "radius_miles": 12.5, "also_zips": ["10014", "10013", "10014"],
              "latitude": 40.72, "longitude": -74.0}
    out = await execute(offline_settings(), repo, "scrape", params)
    opts = chain["scrape"]
    assert [(o.postal_code, o.radius_miles) for o in opts] == [("10013", 12.5), ("10014", 12.5)]
    # The main ZIP's coordinates are not reused for another ZIP.
    assert (opts[0].latitude, opts[1].latitude) == (40.72, None)
    assert out["stats"] == {"found": 50, "new": 5, "updated": 6}
    assert [a["postal_code"] for a in out["also_zips"]] == ["10014"]
    assert out["also_zips"][0]["scrape"]["upsert"]["new"] == 2
    assert "tag" in out["also_zips"][0] and out["also_zips"][0]["follow_up"] == {"insights": "skipped", "briefing": "skipped"}
    assert len(chain["counties"]) == 1  # one county pass over both areas' leads


async def test_tag_and_signals_jobs_record_no_refresh_stats(repo, chain):
    out = await execute(offline_settings(), repo, "tag", {"postal_code": "10013", "radius_miles": 25})
    assert "stats" not in out


def test_a_manual_only_schedule_is_never_fired(repo):
    q = JobQueue(repo)
    sid = q.add_schedule("Hoboken", "pipeline", {"postal_code": "07030", "radius_miles": 10}, 1)
    with repo.engine.begin() as conn:
        conn.execute(schedules.insert().values(
            name="Default area", kind="pipeline", params={"postal_code": "10013", "radius_miles": 25},
            every_hours=None, enabled=True, next_run_at=None, created_at=utcnow()))
        # Even a stray next_run_at on a manual-only row does not make it due.
        conn.execute(schedules.insert().values(
            name="Odd", kind="pipeline", params={"postal_code": "11201", "radius_miles": 5},
            every_hours=None, enabled=True, next_run_at=utcnow() - timedelta(hours=1), created_at=utcnow()))
    fired = q.enqueue_due_schedules()
    assert len(fired) == 1
    with repo.engine.connect() as conn:
        row = conn.execute(select(jobs.c.schedule_id, jobs.c.dedupe_key).where(jobs.c.id == fired[0])).one()
    assert (row.schedule_id, row.dedupe_key) == (sid, "pipeline:07030:10:*")
    assert {s["name"]: s["every_hours"] for s in q.list_schedules()} == {"Hoboken": 1, "Default area": None, "Odd": None}
