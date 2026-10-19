"""`leadmaker briefing`: recompute territory briefs (registered by leadmaker/cli.py through register()).

    leadmaker briefing [--scope team|rep:<uuid>|all] [--no-ai] [--force] [--print]
    leadmaker briefing schedule --every-hours H      # upsert the 'briefing' schedule (picked up by the worker)

Refuses the Section 1 seed file (data/leadmaker.db): set LEADMAKER_DATABASE_URL (or --db) to the Postgres stack.
Output is JSON; --print adds each scope's text. Settings and keys are never printed.
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
SEED_FILE = REPO_ROOT / "data" / "leadmaker.db"
DEFAULT_SEED_URL = "sqlite:///data/leadmaker.db"
SEED_MESSAGE = ("refusing to write the Section 1 seed file; set LEADMAKER_DATABASE_URL (or --db) to the Postgres "
                "stack")


def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


def is_seed_file(url: str) -> bool:
    """True for the default SQLite URL or any SQLite URL whose file resolves to <repo>/data/leadmaker.db."""
    if url.strip() == DEFAULT_SEED_URL:
        return True
    try:
        u = make_url(url)
    except Exception:
        return False
    if not u.drivername.startswith("sqlite") or not u.database or u.database == ":memory:":
        return False
    try:
        return Path(u.database).expanduser().resolve() == SEED_FILE.resolve()
    except OSError:
        return False


def _database_url(args: argparse.Namespace) -> str:
    from ..config import get_settings

    return getattr(args, "db", None) or get_settings().database_url


def cmd_briefing(args: argparse.Namespace) -> int:
    url = _database_url(args)
    if is_seed_file(url):
        print(SEED_MESSAGE, file=sys.stderr)
        return 2
    from ..config import get_settings
    from ..db import Repository

    repo = Repository(url)
    if getattr(args, "briefing_cmd", None) == "schedule":
        from ..jobs import JobQueue

        if args.every_hours <= 0:
            print("--every-hours must be positive", file=sys.stderr)
            return 2
        sid = JobQueue(repo).add_schedule("briefing", "briefing", {}, args.every_hours)
        _print({"schedule_id": sid, "name": "briefing", "every_hours": args.every_hours})
        return 0

    from . import store
    from .digest import parse_scope
    from .run import run_briefing

    scope = (args.scope or "all").strip().lower()
    if scope != "all":
        try:
            parse_scope(scope)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            return 2
    stats = asyncio.run(run_briefing(get_settings(), repo, scopes=None if scope == "all" else [scope],
                                     rewrite=False if args.no_ai else None, force=args.force))
    if stats.get("unknown_scopes"):
        print(f"unknown scope (not a rep): {', '.join(stats['unknown_scopes'])}", file=sys.stderr)
    if args.print:
        from .run import resolve_scopes

        texts = []
        for s in resolve_scopes(repo, None if scope == "all" else [scope])[0]:
            row = store.get_brief(repo, s)
            if row is None:
                continue
            ai = store.latest_rewrite(repo, s, row["digest_hash"])
            texts.append({"scope": s, "quiet": bool(row["quiet"]), "digest_text": row["digest_text"],
                          "ai_text": ai["ai_text"] if ai else None, "model": ai["model"] if ai else None})
        stats["texts"] = texts
    _print(stats)
    return 1 if stats.get("unknown_scopes") and not stats.get("scopes") else 0


def register(sub: Any) -> argparse.ArgumentParser:
    """Add the `briefing` sub-command to leadmaker's top-level subparsers."""
    sp = sub.add_parser("briefing", help="territory briefs: deterministic digest per rep and team, plus a cached "
                                         "AI rewrite")
    sp.add_argument("--scope", default="all", help="team | rep:<user id> | all (default: team and every rep)")
    sp.add_argument("--no-ai", action="store_true", help="digest only; no LLM rewrite")
    sp.add_argument("--force", action="store_true", help="ignore the per-scope minimum interval between rewrites")
    sp.add_argument("--print", action="store_true", help="also print each scope's digest and AI text")
    bsub = sp.add_subparsers(dest="briefing_cmd")
    sc = bsub.add_parser("schedule", help="create/update the recurring 'briefing' job")
    sc.add_argument("--every-hours", type=float, required=True)
    sp.set_defaults(fn=cmd_briefing)
    return sp
