"""Data access over `regional_signals` (repository.py stays untouched: Core statements on repo.engine).

Row shape (dicts in, dicts out): county_fips, kind, source, external_id, payload,
valid_from, valid_to, fetched_at -- unique on (source, external_id, county_fips).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, true, update

from ..db import Repository
from ..db.repository import _chunks, _insert_for, as_utc, utcnow
from ..db.schema import regional_signals

KINDS = ("active_alert", "storm_history", "news")
REQUIRED = ("county_fips", "kind", "source", "external_id")
UPDATABLE = ("kind", "payload", "valid_from", "valid_to", "fetched_at")


def to_utc(dt: datetime | None) -> datetime | None:
    """Store every timestamp in UTC: SQLite keeps the wall time and drops the offset."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _normalise(row: dict[str, Any], now: datetime) -> dict[str, Any]:
    missing = [k for k in REQUIRED if not row.get(k)]
    if missing:
        raise ValueError(f"regional_signals row missing {missing}: {str(row)[:200]}")
    if row["kind"] not in KINDS:
        raise ValueError(f"unknown regional_signals kind {row['kind']!r}")
    return {
        "county_fips": str(row["county_fips"]).zfill(5),
        "kind": row["kind"],
        "source": str(row["source"])[:64],
        "external_id": str(row["external_id"])[:512],
        "payload": row.get("payload") or {},
        "valid_from": to_utc(row.get("valid_from")),
        "valid_to": to_utc(row.get("valid_to")),
        "fetched_at": to_utc(row.get("fetched_at")) or now,
    }


def upsert_signals(repo: Repository, rows: Iterable[dict[str, Any]]) -> int:
    """Insert or refresh rows on (source, external_id, county_fips). Returns rows written."""
    now = utcnow()
    clean = list({(r["source"], r["external_id"], r["county_fips"]): r
                  for r in (_normalise(x, now) for x in rows)}.values())
    if not clean:
        return 0
    with repo.engine.begin() as conn:
        insert = _insert_for(conn)
        for chunk in _chunks(clean):
            stmt = insert(regional_signals).values(list(chunk))
            conn.execute(stmt.on_conflict_do_update(
                index_elements=["source", "external_id", "county_fips"],
                set_={k: stmt.excluded[k] for k in UPDATABLE},
            ))
    return len(clean)


def _row(r: Any) -> dict[str, Any]:
    d = dict(r._mapping)
    for k in ("valid_from", "valid_to", "fetched_at"):
        d[k] = as_utc(d.get(k))
    return d


def signals_for_counties(
    repo: Repository,
    county_fips: Sequence[str],
    kinds: Sequence[str] | None = None,
    ended_after: datetime | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """{county_fips: [rows]} for the given counties. `ended_after` drops rows whose valid_to is earlier."""
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    ids = sorted({f for f in county_fips if f})
    if not ids:
        return {}
    with repo.engine.connect() as conn:
        for i in range(0, len(ids), 500):
            q = select(regional_signals).where(regional_signals.c.county_fips.in_(ids[i : i + 500]))
            if kinds:
                q = q.where(regional_signals.c.kind.in_(list(kinds)))
            if ended_after is not None:
                q = q.where(or_(regional_signals.c.valid_to.is_(None),
                                regional_signals.c.valid_to >= to_utc(ended_after)))
            for r in conn.execute(q.order_by(regional_signals.c.valid_from.desc())):
                out[r.county_fips].append(_row(r))
    return dict(out)


def last_fetched(repo: Repository, kind: str, source: str, county_fips: Sequence[str]) -> dict[str, datetime]:
    """{county_fips: newest fetched_at} for one kind/source."""
    with repo.engine.connect() as conn:
        rows = conn.execute(
            select(regional_signals.c.county_fips, func.max(regional_signals.c.fetched_at))
            .where(regional_signals.c.kind == kind, regional_signals.c.source == source,
                   regional_signals.c.county_fips.in_(list(county_fips)))
            .group_by(regional_signals.c.county_fips)
        ).all()
    return {f: as_utc(t) for f, t in rows if t is not None}


def end_missing(
    repo: Repository, kind: str, source: str, county_fips: Sequence[str], keep_ids: set[str], now: datetime
) -> int:
    """Rows still 'open' (valid_to unset or in the future) that a fresh fetch no longer returns -> valid_to = now.

    Used for alerts that were cancelled or expired early: they stay queryable as
    'ended recently' instead of disappearing.
    """
    now = to_utc(now) or utcnow()
    with repo.engine.begin() as conn:
        res = conn.execute(
            update(regional_signals)
            .where(
                regional_signals.c.kind == kind,
                regional_signals.c.source == source,
                regional_signals.c.county_fips.in_(list(county_fips)),
                regional_signals.c.external_id.not_in(sorted(keep_ids)) if keep_ids else true(),
                or_(regional_signals.c.valid_to.is_(None), regional_signals.c.valid_to > now),
            )
            .values(valid_to=now)
        )
        return res.rowcount or 0


def delete_signals(repo: Repository, source: str, external_ids: Iterable[str]) -> int:
    ids = sorted(set(external_ids))
    if not ids:
        return 0
    n = 0
    with repo.engine.begin() as conn:
        for i in range(0, len(ids), 500):
            res = conn.execute(delete(regional_signals).where(
                regional_signals.c.source == source, regional_signals.c.external_id.in_(ids[i : i + 500])))
            n += res.rowcount or 0
    return n


def purge_ended(repo: Repository, kind: str, before: datetime, source: str | None = None) -> int:
    """Delete rows of `kind` that ended before `before` (retention)."""
    cond = and_(regional_signals.c.kind == kind, regional_signals.c.valid_to.is_not(None),
                regional_signals.c.valid_to < to_utc(before))
    if source:
        cond = and_(cond, regional_signals.c.source == source)
    with repo.engine.begin() as conn:
        return conn.execute(delete(regional_signals).where(cond)).rowcount or 0
