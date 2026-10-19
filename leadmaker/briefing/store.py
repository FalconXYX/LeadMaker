"""territory_briefs / territory_brief_rewrites writes (spec §5.5). No outbox event: the query service caches a
brief for 60 s and the web refetches it on pipeline.run_completed (decision D13)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, select

from ..db import Repository
from ..db.repository import _insert_for, as_utc
from ..db.schema import territory_brief_rewrites as rewrites
from ..db.schema import territory_briefs as briefs

KEEP_REWRITES = 5
# ai_text of a rewrite that failed validation: a negative-cache row (the query service serves only non-empty text).
REJECTED = ""


def stored_briefs(repo: Repository) -> dict[str, dict[str, Any]]:
    """{scope: {digest_hash, quiet, computed_at}} of every stored brief."""
    with repo.engine.connect() as conn:
        return {r.scope: {"digest_hash": r.digest_hash, "quiet": bool(r.quiet), "computed_at": as_utc(r.computed_at)}
                for r in conn.execute(select(briefs.c.scope, briefs.c.digest_hash, briefs.c.quiet, briefs.c.computed_at))}


def get_brief(repo: Repository, scope: str) -> dict[str, Any] | None:
    with repo.engine.connect() as conn:
        r = conn.execute(select(briefs).where(briefs.c.scope == scope)).first()
    return dict(r._mapping) if r is not None else None


def upsert_brief(repo: Repository, *, scope: str, digest: dict[str, Any], digest_text: str, digest_hash: str,
                 quiet: bool, poll_run_id: int | None, now: datetime) -> None:
    """One row per scope; computed_at moves on every run (freshness), the hash marks change."""
    row = {"scope": scope, "digest": digest, "digest_text": digest_text, "digest_hash": digest_hash, "quiet": quiet,
           "poll_run_id": poll_run_id, "computed_at": now}
    with repo.engine.begin() as conn:
        stmt = _insert_for(conn)(briefs).values(**row)
        conn.execute(stmt.on_conflict_do_update(index_elements=["scope"],
                                                set_={k: stmt.excluded[k] for k in row if k != "scope"}))


def rewrite_exists(repo: Repository, scope: str, digest_hash: str, prompt_version: str, model: str) -> bool:
    with repo.engine.connect() as conn:
        return conn.execute(select(rewrites.c.scope).where(
            rewrites.c.scope == scope, rewrites.c.digest_hash == digest_hash,
            rewrites.c.prompt_version == prompt_version, rewrites.c.model == model).limit(1)).first() is not None


def newest_rewrite_at(repo: Repository, scope: str) -> datetime | None:
    with repo.engine.connect() as conn:
        return as_utc(conn.execute(select(func.max(rewrites.c.generated_at)).where(rewrites.c.scope == scope)).scalar())


def save_rewrite(repo: Repository, *, scope: str, digest_hash: str, prompt_version: str, model: str, text: str,
                 now: datetime) -> None:
    row = {"scope": scope, "digest_hash": digest_hash, "prompt_version": prompt_version, "model": model,
           "ai_text": text, "generated_at": now}
    with repo.engine.begin() as conn:
        stmt = _insert_for(conn)(rewrites).values(**row)
        conn.execute(stmt.on_conflict_do_update(
            index_elements=["scope", "digest_hash", "prompt_version", "model"],
            set_={"ai_text": stmt.excluded.ai_text, "generated_at": stmt.excluded.generated_at}))


def latest_rewrite(repo: Repository, scope: str, digest_hash: str) -> dict[str, Any] | None:
    """The rewrite the query service would serve for this digest (newest for the hash, any model)."""
    with repo.engine.connect() as conn:
        r = conn.execute(select(rewrites).where(rewrites.c.scope == scope, rewrites.c.digest_hash == digest_hash,
                                                rewrites.c.ai_text != REJECTED)
                         .order_by(rewrites.c.generated_at.desc()).limit(1)).first()
    return dict(r._mapping) if r is not None else None


def prune(repo: Repository, valid_scopes: set[str], keep: int = KEEP_REWRITES) -> dict[str, int]:
    """Keep the newest `keep` rewrites per scope; drop briefs and rewrites of scopes that no longer exist
    (a deleted user, or one who is no longer a rep)."""
    out = {"briefs": 0, "rewrites": 0}
    with repo.engine.begin() as conn:
        stale = sorted({s for s in conn.execute(select(briefs.c.scope)).scalars() if s not in valid_scopes}
                       | {s for s in conn.execute(select(rewrites.c.scope).distinct()).scalars()
                          if s not in valid_scopes})
        if stale:
            out["briefs"] += conn.execute(delete(briefs).where(briefs.c.scope.in_(stale))).rowcount or 0
            out["rewrites"] += conn.execute(delete(rewrites).where(rewrites.c.scope.in_(stale))).rowcount or 0
        seen: dict[str, int] = {}
        old: list[Any] = []
        for r in conn.execute(select(rewrites.c.scope, rewrites.c.digest_hash, rewrites.c.prompt_version,
                                     rewrites.c.model)
                              .order_by(rewrites.c.scope, rewrites.c.generated_at.desc(), rewrites.c.digest_hash)):
            seen[r.scope] = seen.get(r.scope, 0) + 1
            if seen[r.scope] > keep:
                old.append(r)
        for r in old:
            out["rewrites"] += conn.execute(delete(rewrites).where(
                rewrites.c.scope == r.scope, rewrites.c.digest_hash == r.digest_hash,
                rewrites.c.prompt_version == r.prompt_version, rewrites.c.model == r.model)).rowcount or 0
    return out
