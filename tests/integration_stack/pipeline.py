"""Drives the Python pipeline for the cross-service suite, through the pipeline's own code (no SQL of its own).

    python pipeline.py replay COMPANY_ID [--set RAW_FIELD=JSON ...]
        Re-ingests the company's stored GAF listing with Repository.upsert_contractors, as a GAF re-scrape
        reporting the changed fields would (e.g. --set 'gaf_phone="(555) 010-1234"' --set gaf_rating=3.9).
    python pipeline.py tag-job [--zip 10013] [--radius 25] [--requested-by UUID]
        Enqueues a 'tag' job on the jobs table and runs it with the worker loop (leadmaker.jobs.work).
    python pipeline.py insights COMPANY_ID [COMPANY_ID ...]
        Section 4 batch insights for those leads (leadmaker.insights.run_insights, --force), always on the
        deterministic fake provider: the rows, the outbox lead.updated {fields:['insights']} and no version bump.
    python pipeline.py briefing [--alert-county FIPS] [--clear-alert EXTERNAL_ID]
        Section 4 territory briefing for every scope (leadmaker.briefing.run_briefing) with the fake provider's
        rewrite. --alert-county first inserts a synthetic NWS Severe Thunderstorm Warning (now-1h .. now+3h) for that
        county, so the digest is not quiet; --clear-alert deletes it (and re-runs the briefing).

Runs in the worker image (docker compose run worker python /e2e/pipeline.py ...) or the host venv, against
$LEADMAKER_DATABASE_URL / $DATABASE_URL. Prints one JSON object; committed_at_ms is when the write committed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, insert, select

from leadmaker.config import get_settings
from leadmaker.db.repository import Repository
from leadmaker.db.schema import companies, jobs, regional_signals
from leadmaker.jobs import JobQueue, area_dedupe_key, work
from leadmaker.sources.gaf.parse import parse_coveo_result


def replay(repo: Repository, args: argparse.Namespace) -> dict:
    with repo.engine.connect() as conn:
        row = conn.execute(select(companies.c.raw).where(companies.c.id == args.company_id)).first()
    if row is None or not row.raw:
        raise SystemExit(f"no company with a stored GAF listing: {args.company_id}")
    raw = dict(row.raw)
    previous = {}
    for item in args.set:
        key, sep, value = item.partition("=")
        if not sep:
            raise SystemExit(f"--set takes RAW_FIELD=JSON, got {item!r}")
        previous[key] = raw.get(key)
        raw[key] = json.loads(value)
    listing = parse_coveo_result({"raw": raw})
    run_id = repo.start_run("gaf_ingest", {"source": "e2e listing replay", "company_id": args.company_id})
    counts = repo.upsert_contractors([listing], run_id=run_id)
    committed = time.time() * 1000
    repo.finish_run(run_id, "partial", {"upsert": counts, "e2e": True})
    with repo.engine.connect() as conn:
        version = conn.execute(select(companies.c.version).where(companies.c.id == args.company_id)).scalar()
    return {"run_id": run_id, "counts": counts, "previous": previous, "version": version, "committed_at_ms": committed}


def tag_job(repo: Repository, args: argparse.Namespace) -> dict:
    params = {"postal_code": args.zip, "radius_miles": args.radius}
    q = JobQueue(repo)
    job_id = q.enqueue("tag", params, priority=-1000, requested_by=args.requested_by)
    if job_id is None:
        raise SystemExit(f"a tag job for {area_dedupe_key('tag', params)} is already open")
    t0 = time.time() * 1000
    processed = asyncio.run(work(get_settings(), repo, worker_id="e2e-tag-job", once=True, max_jobs=1))
    with repo.engine.connect() as conn:
        job = conn.execute(select(jobs).where(jobs.c.id == job_id)).first()
    if job.status != "succeeded":
        raise SystemExit(f"tag job {job_id} is {job.status} after {processed} job(s): {job.error}")
    return {"job_id": job_id, "status": job.status, "result": job.result, "started_at_ms": t0,
            "committed_at_ms": job.finished_at.timestamp() * 1000}


def _fake_llm() -> None:
    """The suite never calls a real model: the fake provider, whatever the stack's .env says."""
    os.environ["LEADMAKER_LLM_PROVIDER"] = "fake"
    os.environ["LEADMAKER_ALLOW_FAKE_LLM"] = "1"
    os.environ.pop("LEADMAKER_LLM_MODEL", None)


def insights(repo: Repository, args: argparse.Namespace) -> dict:
    from leadmaker.insights import InsightsOptions, run_insights

    def versions() -> dict:
        with repo.engine.connect() as conn:
            return {r.id: int(r.version) for r in conn.execute(
                select(companies.c.id, companies.c.version).where(companies.c.id.in_(args.company_ids)))}

    before = versions()
    t0 = time.time() * 1000
    stats = asyncio.run(run_insights(get_settings(), repo, InsightsOptions(
        company_ids=args.company_ids, force=True, batch_size=len(args.company_ids))))
    return {"stats": stats, "versions_before": before, "versions_after": versions(), "started_at_ms": t0,
            "committed_at_ms": time.time() * 1000}


def briefing(repo: Repository, args: argparse.Namespace) -> dict:
    from leadmaker.briefing import run_briefing

    now = datetime.now(timezone.utc)
    alert = None
    with repo.engine.begin() as conn:
        if args.clear_alert:
            conn.execute(delete(regional_signals).where(regional_signals.c.source == "e2e",
                                                        regional_signals.c.external_id == args.clear_alert))
        if args.alert_county:
            alert = f"urn:e2e:alert:{uuid.uuid4()}"
            start, end = now - timedelta(hours=1), now + timedelta(hours=3)
            conn.execute(insert(regional_signals).values(
                id=str(uuid.uuid4()), county_fips=args.alert_county, kind="active_alert", source="e2e",
                external_id=alert, payload={"event": "Severe Thunderstorm Warning", "onset": start.isoformat(),
                                            "areaDesc": args.alert_county, "severity": "Severe"},
                valid_from=start, valid_to=end, fetched_at=now))
    result = asyncio.run(run_briefing(get_settings(), repo, rewrite=True, force=True))
    return {"alert": alert, "result": result}


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("replay")
    r.add_argument("company_id")
    r.add_argument("--set", action="append", default=[], metavar="RAW_FIELD=JSON")
    t = sub.add_parser("tag-job")
    t.add_argument("--zip", default="10013")
    t.add_argument("--radius", type=float, default=25)
    t.add_argument("--requested-by")
    i = sub.add_parser("insights")
    i.add_argument("company_ids", nargs="+")
    b = sub.add_parser("briefing")
    b.add_argument("--alert-county")
    b.add_argument("--clear-alert")
    args = ap.parse_args()
    if args.cmd in ("insights", "briefing"):
        _fake_llm()
    repo = Repository(get_settings().database_url)
    out = {"replay": replay, "tag-job": tag_job, "insights": insights, "briefing": briefing}[args.cmd](repo, args)
    print(json.dumps(out, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
