"""Section 1 acceptance -- Scheduled & On-Demand Runs.

Requirement (docs/OpeningRequirements.MD, Section 1):
  "The pipeline runs primarily on a recurring schedule, with support for on-demand triggers by reps
   or managers (e.g., refreshing a territory or searching a new area). Duplicate requests for the
   same area are merged, and requests are rate-limited per user."
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from leadmaker.db.repository import as_utc, utcnow
from leadmaker.jobs import JobQueue, JobRateLimitError, area_dedupe_key, work
from leadmaker.signals import counties

from dbutil import add_user, gaf_ids
from fakes import CountingSource, FakeGaf, area_results, coveo_result, gid


NYC = {"postal_code": "10013", "radius_miles": 25}


async def test_due_schedule_is_enqueued_executed_by_a_worker_and_every_stage_records_a_run(
    repo, settings, use_http, use_enrichers, zcta_cache
):
    """'The pipeline runs primarily on a recurring schedule': a due schedule becomes a job, a worker
    runs the real scrape -> enrich -> counties -> tag pipeline, and each stage leaves a recorded run."""
    use_http(FakeGaf({"10013": area_results(range(6))}))
    use_enrichers(CountingSource)
    q = JobQueue(repo)
    sid = q.add_schedule("nyc-daily", "pipeline", {**NYC, "fetch_profiles": False}, every_hours=24)

    # max_jobs bounds the loop: a schedule that kept re-firing would fail here instead of hanging the suite.
    assert await work(settings, repo, once=True, worker_id="w1", max_jobs=3) == 1

    (job,) = q.list()
    assert job["status"] == "succeeded" and job["schedule_id"] == sid and job["locked_by"] is None
    runs = {r["kind"]: r for r in repo.list_runs()}
    assert set(runs) == {"gaf_ingest", "enrich", "counties", "tag"}
    assert all(r["status"] == "succeeded" and r["finished_at"] for r in runs.values())
    res = job["result"]
    assert res["scrape"]["run_id"] == runs["gaf_ingest"]["id"]
    assert res["scrape"]["upsert"] == {"new": 6, "changed": 0, "unchanged": 0}
    assert res["enrich"]["run_id"] == runs["enrich"]["id"] and res["enrich"]["by_source"]["osm"]["ok"] == 6
    assert res["counties"]["run_id"] == runs["counties"]["id"] and res["counties"]["leads"] == 6
    assert res["tag"]["tagged"] == 6 and res["tag"]["run_id"] == runs["tag"]["id"]
    assert sorted(CountingSource.calls) == sorted(gid(i) for i in range(6))
    assert all(r["segment"] for r in repo.get_companies())

    # The schedule moved to its next slot: polling again within the day does nothing.
    sched = q.list_schedules()[0]
    assert sched["last_enqueued_at"] is not None
    assert as_utc(sched["next_run_at"]) > utcnow() + timedelta(hours=23)
    assert await work(settings, repo, once=True, max_jobs=3) == 0
    # A day later the same schedule fires again.
    assert len(q.enqueue_due_schedules(now=utcnow() + timedelta(hours=25))) == 1


ZIPS = {10: "07010", 11: "07407", 12: "10013", 13: "10113"}  # 10113: PO-box ZIP without a ZCTA


async def test_rep_can_search_a_new_area_on_demand(repo, settings, use_http, zcta_cache):
    """'on-demand triggers by reps or managers (e.g. ... searching a new area)': an enqueued rep request
    is executed by the worker, keeps who asked, and the new area's leads become queryable -- already
    tagged and placed in their county (from the cached Census file: no further requests)."""
    fake = use_http(FakeGaf({"07030": [coveo_result(i, 1.0 + i, gaf_postal_code=z) for i, z in ZIPS.items()]}))
    q = JobQueue(repo, user_jobs_per_hour=5)
    ana = add_user(repo, "Rep Ana")
    params = {"postal_code": "07030", "radius_miles": 10, "fetch_profiles": False}
    jid = q.enqueue("scrape", params, requested_by=ana)
    assert jid is not None
    assert repo.area_company_ids("07030", 10) == []

    assert await work(settings, repo, once=True) == 1

    job = q.list("succeeded")[0]
    assert job["id"] == jid and job["requested_by"] == ana
    assert job["result"]["scrape"]["status"] == "succeeded"
    assert gaf_ids(repo, repo.area_company_ids("07030", 10)) == [gid(i) for i in range(10, 14)]

    leads = {r["gaf_id"]: r for r in repo.get_companies()}
    assert {g: r["county_fips"] for g, r in leads.items()} == {
        gid(10): "34003", gid(11): "34003", gid(12): "36061", gid(13): None}
    assert all(r["tags"] and r["segment"] and r["priority_score"] is not None and r["tagged_at"]
               for r in leads.values())
    res = job["result"]
    assert (res["counties"]["assigned"], res["counties"]["unmapped"], res["tag"]["tagged"]) == (3, 1, 4)
    assert not [u for _, u in fake.calls if counties.REL_URL in u or counties.GEOCODER_URL in u]
    done = [e["payload"] for e in repo.outbox("pipeline.run_completed")]
    assert [(p["kind"], p["run_id"]) for p in done] == [
        ("gaf_ingest", res["scrape"]["run_id"]), ("counties", res["counties"]["run_id"]), ("tag", res["tag"]["run_id"])]
    assert done[1]["changed_companies"] == 3


async def test_refresh_places_and_tags_only_the_area_it_read(repo, settings, scrape, use_http, zcta_cache):
    """The county and tag steps cover the area as the scrape read it (the default radius when the job leaves it
    out), not every lead in the database."""
    await scrape(FakeGaf({"10013": [coveo_result(30, 1.0, gaf_postal_code="11550")]}), fetch_profiles=False)
    use_http(FakeGaf({"07030": [coveo_result(i, 1.0 + i, gaf_postal_code=z) for i, z in ZIPS.items() if i != 13]}))
    q = JobQueue(repo)
    q.enqueue("scrape", {"postal_code": "07030", "fetch_profiles": False})
    assert await work(settings, repo, once=True) == 1

    res = q.list("succeeded")[0]["result"]
    assert (res["counties"]["leads"], res["counties"]["assigned"], res["tag"]["tagged"]) == (3, 3, 3)
    leads = {r["gaf_id"]: r for r in repo.get_companies()}
    assert {g: (r["county_fips"], bool(r["tags"])) for g, r in leads.items()} == {
        gid(10): ("34003", True), gid(11): ("34003", True), gid(12): ("36061", True), gid(30): (None, False)}


async def test_refresh_without_the_county_file_still_tags_and_succeeds(repo, settings, use_http):
    """County assignment is follow-up work: when the Census file is not cached and cannot be fetched, the
    refresh still lands and tags; the county comes with the next refresh or signals run."""
    fake = use_http(FakeGaf({"07030": area_results(range(10, 12))}))
    q = JobQueue(repo)
    q.enqueue("scrape", {"postal_code": "07030", "radius_miles": 10, "fetch_profiles": False})
    assert await work(settings, repo, once=True) == 1

    (job,) = q.list("succeeded")
    assert "unexpected GET" in job["result"]["counties"]["error"]
    assert ("GET", counties.REL_URL) in fake.calls
    assert job["result"]["tag"]["tagged"] == 2 and all(r["segment"] for r in repo.get_companies())
    assert {r["kind"]: r["status"] for r in repo.list_runs()} == {"gaf_ingest": "succeeded", "counties": "failed",
                                                                  "tag": "succeeded"}


def test_duplicate_requests_for_the_same_area_merge_into_one_open_job(repo):
    """'Duplicate requests for the same area are merged.'"""
    q = JobQueue(repo, user_jobs_per_hour=2)
    rep_a, rep_b = add_user(repo, "Rep A"), add_user(repo, "Rep B")
    first = q.enqueue("scrape", NYC, requested_by=rep_a)
    assert first is not None
    assert q.enqueue("scrape", NYC, requested_by=rep_b) is None  # another rep, same area
    assert q.enqueue("scrape", dict(NYC)) is None  # manager / CLI, same area
    assert q.open_job_id(area_dedupe_key("scrape", NYC)) == first
    assert len(q.list()) == 1

    # Only the same area merges: a wider radius around the same ZIP is a different request.
    wider = q.enqueue("scrape", {"postal_code": "10013", "radius_miles": 50})
    assert wider is not None and wider != first

    # Merged requests are free: rep-b still has its whole hourly allowance ...
    assert q.enqueue("scrape", {"postal_code": "07030", "radius_miles": 25}, requested_by=rep_b)
    assert q.enqueue("scrape", {"postal_code": "11550", "radius_miles": 25}, requested_by=rep_b)
    # ... and even at its limit, asking for an area that is already queued merges instead of being refused.
    assert q.enqueue("scrape", NYC, requested_by=rep_b) is None
    with pytest.raises(JobRateLimitError):
        q.enqueue("scrape", {"postal_code": "10001", "radius_miles": 25}, requested_by=rep_b)

    # Once the open job finishes, the area can be refreshed again.
    claimed = q.claim("w")
    assert claimed["id"] == first
    q.complete(first, {})
    again = q.enqueue("scrape", NYC, requested_by=rep_a)
    assert again is not None and again != first


def test_rep_request_merges_with_a_queued_scheduled_run_of_the_same_area(repo):
    """'Duplicate requests for the same area are merged' -- jobs.py promises 'schedules and manual
    triggers don't pile up', so a rep refresh of an area whose scheduled refresh is already queued
    should merge into it rather than queue a second identical scrape."""
    q = JobQueue(repo)
    q.add_schedule("nyc-daily", "scrape", dict(NYC), every_hours=24)
    (scheduled,) = q.enqueue_due_schedules()
    rep_a = add_user(repo, "Rep A")
    assert q.enqueue("scrape", dict(NYC), requested_by=rep_a) is None
    assert [j["id"] for j in q.list("queued")] == [scheduled]


def test_rep_requests_are_rate_limited_per_user(repo):
    """'requests are rate-limited per user': each requester has an hourly cap; others are unaffected."""
    q = JobQueue(repo, user_jobs_per_hour=2)
    rep_a, rep_b = add_user(repo, "Rep A"), add_user(repo, "Rep B")
    assert q.enqueue("scrape", {"postal_code": "10001", "radius_miles": 5}, requested_by=rep_a)
    assert q.enqueue("scrape", {"postal_code": "10002", "radius_miles": 5}, requested_by=rep_a)
    with pytest.raises(JobRateLimitError) as exc:
        q.enqueue("scrape", {"postal_code": "10003", "radius_miles": 5}, requested_by=rep_a)
    assert exc.value.requested_by == rep_a and exc.value.limit == 2
    assert utcnow() < exc.value.retry_at <= utcnow() + timedelta(hours=1)
    assert len(q.list()) == 2  # the refused request created nothing

    # A different rep, and the schedule, still get through.
    assert q.enqueue("scrape", {"postal_code": "10003", "radius_miles": 5}, requested_by=rep_b)
    q.add_schedule("nightly", "tag", {"postal_code": "10013", "radius_miles": 25}, every_hours=24)
    assert len(q.enqueue_due_schedules()) == 1
