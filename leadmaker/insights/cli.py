"""`leadmaker insights ...` (registered by leadmaker.cli).

    leadmaker insights [--stale] [--zip Z --radius R] [--company ID ...] [--limit N] [--batch-size K] [--force] [--dry-run]
    leadmaker insights show --company ID          # latest row as JSON (ok or error)
    leadmaker insights schedule --every-hours H   # upsert schedule 'insights-stale' {"stale": true}

Never runs against the Section 1 seed file: the CLI's default database URL is sqlite:///data/leadmaker.db, so
without LEADMAKER_DATABASE_URL (or --db) it exits 2 instead of creating tables in it. Prints JSON, never settings
or keys.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from sqlalchemy.engine import make_url

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_FILE_MESSAGE = ("refusing to write the Section 1 seed file; set LEADMAKER_DATABASE_URL (or --db) to the "
                     "Postgres stack")
STALE_SCHEDULE = "insights-stale"


def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


def is_seed_file(url: str) -> bool:
    """True when `url` is the CLI's default URL or a SQLite file that resolves to <repo>/data/leadmaker.db (or
    ./data/leadmaker.db)."""
    if url.strip() == "sqlite:///data/leadmaker.db":
        return True
    try:
        u = make_url(url)
    except Exception:
        return False
    if not u.drivername.startswith("sqlite") or not u.database or u.database == ":memory:":
        return False
    path = Path(u.database).expanduser()
    resolved = (path if path.is_absolute() else Path.cwd() / path).resolve()
    seeds = {(REPO_ROOT / "data" / "leadmaker.db").resolve(), (Path.cwd() / "data" / "leadmaker.db").resolve()}
    return resolved in seeds


def seed_file_guard(url: str) -> int | None:
    """2 (after printing why) when `url` is the seed file, else None. Call before opening a Repository: opening a
    SQLite URL creates the schema in it. leadmaker.briefing's CLI uses the same guard."""
    if is_seed_file(url):
        print(f"leadmaker: {SEED_FILE_MESSAGE}", file=sys.stderr)
        return 2
    return None


def cmd_insights(args: argparse.Namespace) -> int:
    from ..config import get_settings
    from ..db import Repository

    s = get_settings()
    url = getattr(args, "db", None) or s.database_url
    if (rc := seed_file_guard(url)) is not None:
        return rc
    repo = Repository(url)
    sub = getattr(args, "insights_cmd", None)
    if sub == "show":
        from .store import latest_insight

        row = latest_insight(repo, args.show_company)
        _print(row)
        return 0 if row else 1
    if sub == "schedule":
        from ..jobs import JobQueue

        sid = JobQueue(repo).add_schedule(STALE_SCHEDULE, "insights", {"stale": True}, args.every_hours)
        _print({"schedule_id": sid, "name": STALE_SCHEDULE, "every_hours": args.every_hours})
        return 0

    from .run import InsightsOptions, run_insights

    opts = InsightsOptions(
        postal_code=args.postal_code, radius_miles=args.radius_miles if args.postal_code else None,
        company_ids=args.company_id or None, stale=args.stale, limit=args.limit, force=args.force,
        batch_size=args.batch_size, dry_run=args.dry_run,
    )
    if opts.postal_code and opts.radius_miles is None:
        opts.radius_miles = 25.0
    out = asyncio.run(run_insights(s, repo, opts))
    _print(out)
    if out.get("status") == "skipped":
        print(f"insights skipped: {out.get('detail') or out.get('reason')}", file=sys.stderr)
        return 1
    return 0 if out.get("status") in ("succeeded", "partial", "dry_run") else 1


def register(sub: argparse._SubParsersAction) -> None:
    sp = sub.add_parser("insights", help="AI summary, pitch and talking points per lead (regenerated when inputs change)")
    sp.add_argument("--stale", action="store_true", help="only leads whose notes, fields or website changed since "
                                                         "their insight (plus failed ones due a retry)")
    sp.add_argument("--zip", dest="postal_code", help="only the leads of this area's latest search")
    sp.add_argument("--radius", dest="radius_miles", type=float, default=None, help="area radius in miles (default 25)")
    sp.add_argument("--company", dest="company_id", action="append", help="company id (repeatable)")
    sp.add_argument("--limit", type=int, help="send at most N leads to the model this run")
    sp.add_argument("--batch-size", type=int, help="leads per model request, 1-8 (default $LEADMAKER_INSIGHTS_BATCH_SIZE or 1)")
    sp.add_argument("--force", action="store_true", help="regenerate even when the inputs are unchanged")
    sp.add_argument("--dry-run", action="store_true", help="build facts and hashes only: no model calls, no writes")
    isub = sp.add_subparsers(dest="insights_cmd")
    show = isub.add_parser("show", help="the latest insight row of one company, as JSON")
    show.add_argument("--company", dest="show_company", required=True)
    sched = isub.add_parser("schedule", help=f"upsert the '{STALE_SCHEDULE}' schedule ({{\"stale\": true}})")
    sched.add_argument("--every-hours", type=float, required=True)
    sp.set_defaults(fn=cmd_insights)


__all__ = ["SEED_FILE_MESSAGE", "cmd_insights", "is_seed_file", "register", "seed_file_guard"]
