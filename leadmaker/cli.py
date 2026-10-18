"""Command-line entry point: `leadmaker <command>`."""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import logging
import sys
from pathlib import Path
from typing import Any

from .config import get_settings
from .db import Repository


def _area_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--zip", dest="postal_code", default="10013", help="search origin ZIP (default 10013)")
    p.add_argument("--radius", dest="radius_miles", type=float, default=25, help="miles (default 25)")


def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


def cmd_scrape(args: argparse.Namespace) -> int:
    """One run per ZIP; overlapping areas de-duplicate on GAF contractor id."""
    from .pipeline.scrape import ScrapeOptions, run_scrape

    s = get_settings()
    repo = Repository(args.db or s.database_url)
    zips = list(dict.fromkeys(args.extra_zips or [])) or [args.postal_code]
    if args.postal_code not in zips and args.extra_zips:
        zips.insert(0, args.postal_code)
    if len(zips) > 1 and (args.lat is not None or args.lng is not None):
        print("--lat/--lng only apply to a single --zip", file=sys.stderr)
        return 2
    rc = 0
    for z in zips:
        report = asyncio.run(
            run_scrape(
                s, repo,
                ScrapeOptions(
                    postal_code=z, country=args.country, radius_miles=args.radius_miles,
                    latitude=args.lat, longitude=args.lng, fetch_profiles=not args.no_profiles,
                    force_profiles=args.force_profiles, max_profiles=args.max_profiles,
                    accept_count_drop=args.accept_count_drop,
                ),
            )
        )
        _print({"run_id": report.run_id, "status": report.status, **report.stats})
        if report.status not in {"succeeded", "partial"}:
            rc = 1
    return rc


def cmd_enrich(args: argparse.Namespace) -> int:
    from .pipeline.enrich import EnrichOptions, run_enrich

    s = get_settings()
    repo = Repository(args.db or s.database_url)
    report = asyncio.run(
        run_enrich(
            s, repo,
            EnrichOptions(
                postal_code=args.postal_code, radius_miles=args.radius_miles,
                sources=args.sources.split(",") if args.sources else None,
                gaf_ids=args.gaf_id or None, force=args.force, limit=args.limit,
            ),
        )
    )
    _print({"run_id": report.run_id, "status": report.status, **report.stats})
    return 0 if report.status in {"succeeded", "partial"} else 1


def cmd_tag(args: argparse.Namespace) -> int:
    from .pipeline.tag import run_tagging

    s = get_settings()
    _print(run_tagging(Repository(args.db or s.database_url), args.postal_code, args.radius_miles,
                       rules_path=getattr(args, "rules", None)))
    return 0


def cmd_accounts(args: argparse.Namespace) -> int:
    from .accounts import import_accounts

    s = get_settings()
    repo = Repository(args.db or s.database_url)
    if args.accounts_cmd == "import":
        _print(import_accounts(repo, args.csv, replace=not args.append))
    else:
        from sqlalchemy import select

        from .db.schema import accounts

        with repo.engine.connect() as conn:
            _print([dict(r._mapping) for r in conn.execute(select(accounts).limit(args.limit))])
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    """scrape -> enrich -> tag in one go."""
    for fn in (cmd_scrape, cmd_enrich, cmd_tag):
        rc = fn(args)
        if rc:
            return rc
    return 0


EXPORT_COLUMNS = [
    "rank", "gaf_id", "name", "legal_name", "dba", "tier", "segment", "priority_score", "distance_miles",
    "gaf_recommended", "rating", "review_count", "phone", "website", "street", "city", "state", "postal_code",
    "in_business_since", "employees_range", "presidents_club_stars", "gaf_leads_enrolled", "specialties",
    "certifications", "profile_url", "decision_makers", "target_contact", "county_fips", "timing", "tag_labels",
]


def _flatten(lead: dict[str, Any]) -> dict[str, Any]:
    out = {k: lead.get(k) for k in EXPORT_COLUMNS}
    out["decision_makers"] = "; ".join(
        f"{c['name']} ({c['title'] or '?'}, {c['source']})" for c in lead.get("contacts", [])
    )
    tc = next((t for t in lead.get("tags") or [] if t.get("key") == "target_contact"), None)
    c = (tc or {}).get("contact") or {}
    out["target_contact"] = "" if not c else (
        f"{c['name']} ({c.get('title') or c.get('role_label')}, {c.get('source')})" if c.get("named")
        else f"Owner (name unknown), main line {c.get('phone') or 'n/a'}")
    out["timing"] = "; ".join(b["label"] for b in lead.get("timing") or [])
    out["tag_labels"] = "; ".join(t.get("label", t.get("key", "")) for t in lead.get("tags") or [])
    for k in ("specialties", "certifications"):
        out[k] = "; ".join(lead.get(k) or [])
    return out


def cmd_export(args: argparse.Namespace) -> int:
    s = get_settings()
    leads = Repository(args.db or s.database_url).lead_records(args.postal_code, args.radius_miles)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.format == "json":
        out.write_text(json.dumps(leads, indent=2, default=str))
    else:
        with out.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=EXPORT_COLUMNS)
            w.writeheader()
            for lead in leads:
                w.writerow(_flatten(lead))
    print(f"wrote {len(leads)} leads to {out}")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    s = get_settings()
    _print(Repository(args.db or s.database_url).summary())
    return 0


def cmd_runs(args: argparse.Namespace) -> int:
    s = get_settings()
    _print(Repository(args.db or s.database_url).list_runs(args.limit))
    return 0


def cmd_sources(args: argparse.Namespace) -> int:
    from .enrich import REGISTRY, load_enricher_class

    s = get_settings()
    rows = []
    for name in REGISTRY:
        try:
            cls = load_enricher_class(name)
            ok, why = cls(s).is_enabled()
            rows.append({"source": name, "enabled": ok, "reason": why, "depends_on": list(cls.depends_on)})
        except Exception as e:
            rows.append({"source": name, "enabled": False, "reason": f"load error: {e}"})
    _print(rows)
    return 0


def _area_params(args: argparse.Namespace) -> dict[str, Any]:
    params: dict[str, Any] = {"postal_code": args.postal_code, "radius_miles": args.radius_miles}
    if getattr(args, "sources", None):
        params["sources"] = args.sources.split(",")
    return params


def cmd_jobs(args: argparse.Namespace) -> int:
    from .jobs import JobQueue, JobRateLimitError

    s = get_settings()
    q = JobQueue(Repository(args.db or s.database_url))
    if args.jobs_cmd == "enqueue":
        ids = []
        try:
            for z in [args.postal_code, *(args.extra_zips or [])]:
                params = _area_params(args) | {"postal_code": z}
                ids.append(q.enqueue(args.kind, params, priority=args.priority, requested_by=args.requested_by))
        except JobRateLimitError as e:
            print(str(e), file=sys.stderr)
            _print({"enqueued": [i for i in ids if i], "deduplicated": sum(1 for i in ids if not i), "rate_limited": True})
            return 2
        _print({"enqueued": [i for i in ids if i], "deduplicated": sum(1 for i in ids if not i)})
    elif args.jobs_cmd == "list":
        _print(q.list(args.status, args.limit))
    elif args.jobs_cmd == "retry-dead":
        _print({"requeued": q.retry_dead(args.job_id)})
    return 0


def cmd_schedule(args: argparse.Namespace) -> int:
    from .jobs import JobQueue

    s = get_settings()
    q = JobQueue(Repository(args.db or s.database_url))
    if args.schedule_cmd == "add":
        sid = q.add_schedule(args.name, args.kind, _area_params(args), args.every_hours)
        _print({"schedule_id": sid})
    elif args.schedule_cmd == "list":
        _print(q.list_schedules())
    elif args.schedule_cmd in ("enable", "disable"):
        _print({"updated": q.set_schedule_enabled(args.name, args.schedule_cmd == "enable")})
    return 0


def cmd_worker(args: argparse.Namespace) -> int:
    from .jobs import work

    s = get_settings()
    n = asyncio.run(
        work(s, Repository(args.db or s.database_url), worker_id=args.worker_id, once=args.once,
             poll_seconds=args.poll, max_jobs=args.max_jobs)
    )
    print(f"processed {n} job(s)", file=sys.stderr)
    return 0


def cmd_signals(args: argparse.Namespace) -> int:
    from .pipeline.signals import run_signals

    s = get_settings()
    stats = asyncio.run(run_signals(s, Repository(args.db or s.database_url), force_storms=args.force_storms,
                                    news=not args.no_news, refine_points=not args.no_point_check))
    _print(stats)
    return 0 if stats.get("status") in {"succeeded", "partial"} else 1


def cmd_audit(args: argparse.Namespace) -> int:
    s = get_settings()
    _print(Repository(args.db or s.database_url).audit_log(gaf_id=args.gaf_id, run_id=args.run_id, limit=args.limit))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="leadmaker", description="GAF lead ingestion & enrichment")
    p.add_argument("--db", help="database URL (default $DATABASE_URL or sqlite:///data/leadmaker.db)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="command", required=True)

    def add_scrape_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--country", default="US")
        sp.add_argument("--lat", type=float, help="override search origin latitude")
        sp.add_argument("--lng", type=float, help="override search origin longitude")
        sp.add_argument("--no-profiles", action="store_true", help="skip profile page fetches")
        sp.add_argument("--force-profiles", action="store_true", help="re-fetch profiles even if fresh")
        sp.add_argument("--max-profiles", type=int)
        sp.add_argument("--also-zip", dest="extra_zips", action="append",
                        help="scrape additional ZIPs in the same invocation (repeatable)")
        sp.add_argument("--accept-count-drop", action="store_true",
                        help="accept an area read that shrank more than 20%% vs the last complete read")

    def add_enrich_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--sources", help="comma-separated enrichers (default: all)")
        sp.add_argument("--gaf-id", action="append", help="limit to these contractor ids (repeatable)")
        sp.add_argument("--force", action="store_true", help="ignore enrichment TTL")
        sp.add_argument("--limit", type=int, help="only the first N contractors (by distance)")

    sp = sub.add_parser("scrape", help="ingest GAF contractors for an area")
    _area_args(sp); add_scrape_args(sp); sp.set_defaults(fn=cmd_scrape)

    sp = sub.add_parser("enrich", help="run secondary-source enrichers")
    _area_args(sp); add_enrich_args(sp); sp.set_defaults(fn=cmd_enrich)

    sp = sub.add_parser("tag", help="recompute tags/segments/priority")
    _area_args(sp)
    sp.add_argument("--rules", help="JSON file of custom tag rules (default $LEADMAKER_TAG_RULES)")
    sp.set_defaults(fn=cmd_tag)

    sp = sub.add_parser("accounts", help="import the distributor's customer list (CRM export CSV)")
    asub = sp.add_subparsers(dest="accounts_cmd", required=True)
    ai = asub.add_parser("import")
    ai.add_argument("csv")
    ai.add_argument("--append", action="store_true", help="keep previously imported accounts")
    al = asub.add_parser("list")
    al.add_argument("--limit", type=int, default=50)
    sp.set_defaults(fn=cmd_accounts)

    sp = sub.add_parser("run", help="scrape + enrich + tag")
    _area_args(sp); add_scrape_args(sp); add_enrich_args(sp)
    sp.add_argument("--rules", help="JSON file of custom tag rules")
    sp.set_defaults(fn=cmd_run)

    sp = sub.add_parser("export", help="export lead records")
    _area_args(sp)
    sp.add_argument("--format", choices=["json", "csv"], default="json")
    sp.add_argument("--out", default="data/leads.json")
    sp.set_defaults(fn=cmd_export)

    sp = sub.add_parser("stats", help="database summary"); sp.set_defaults(fn=cmd_stats)
    sp = sub.add_parser("runs", help="recent pipeline runs")
    sp.add_argument("--limit", type=int, default=10); sp.set_defaults(fn=cmd_runs)
    sp = sub.add_parser("sources", help="list enrichers and whether they're enabled")
    sp.set_defaults(fn=cmd_sources)

    from .jobs import JOB_KINDS

    sp = sub.add_parser("jobs", help="job queue: enqueue on-demand work, inspect, retry")
    jsub = sp.add_subparsers(dest="jobs_cmd", required=True)
    e = jsub.add_parser("enqueue", help="queue scrape|enrich|tag|pipeline for one or more ZIPs")
    e.add_argument("kind", choices=JOB_KINDS)
    _area_args(e)
    e.add_argument("--also-zip", dest="extra_zips", action="append")
    e.add_argument("--sources")
    e.add_argument("--priority", type=int, default=100, help="lower runs first")
    e.add_argument("--requested-by", help="user id of the rep asking; applies the per-user hourly limit "
                                          "(LEADMAKER_USER_JOBS_PER_HOUR, default 20)")
    l = jsub.add_parser("list")
    l.add_argument("--status", choices=["queued", "running", "succeeded", "failed", "dead"])
    l.add_argument("--limit", type=int, default=20)
    r = jsub.add_parser("retry-dead")
    r.add_argument("--job-id", type=int)
    sp.set_defaults(fn=cmd_jobs)

    sp = sub.add_parser("schedule", help="recurring runs (picked up by `leadmaker worker`)")
    ssub = sp.add_subparsers(dest="schedule_cmd", required=True)
    a = ssub.add_parser("add", help="create/update a named schedule")
    a.add_argument("--name", required=True)
    a.add_argument("--kind", choices=JOB_KINDS, default="pipeline")
    a.add_argument("--every-hours", type=float, required=True)
    a.add_argument("--sources")
    _area_args(a)
    ssub.add_parser("list")
    for verb in ("enable", "disable"):
        v = ssub.add_parser(verb)
        v.add_argument("--name", required=True)
    sp.set_defaults(fn=cmd_schedule)

    sp = sub.add_parser("worker", help="process queued and scheduled jobs")
    sp.add_argument("--once", action="store_true", help="exit when the queue is empty")
    sp.add_argument("--poll", type=float, default=15.0, help="seconds between polls when idle")
    sp.add_argument("--max-jobs", type=int)
    sp.add_argument("--worker-id")
    sp.set_defaults(fn=cmd_worker)

    sp = sub.add_parser("signals", help="refresh county weather alerts, storm history and local news")
    sp.add_argument("--force-storms", action="store_true", help="recompute storm history even if < 30 days old")
    sp.add_argument("--no-news", action="store_true", help="skip local news (slow: GDELT rate limits)")
    sp.add_argument("--no-point-check", action="store_true", help="skip Census geocoder checks for split/PO-box ZIPs")
    sp.set_defaults(fn=cmd_signals)

    sp = sub.add_parser("audit", help="change log: what was added/updated, when, by which run")
    sp.add_argument("--gaf-id")
    sp.add_argument("--run-id", type=int)
    sp.add_argument("--limit", type=int, default=50)
    sp.set_defaults(fn=cmd_audit)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
