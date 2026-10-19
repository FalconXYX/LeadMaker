"""Writing insight results: one transaction per lead.

  * upsert on (company_id, input_hash): a re-run of the same inputs (--force, or a retried error row) updates the
    row in place and counts attempts (runs) up;
  * ok rows: business_summary = summary, sales_recommendation = pitch, talking points, the contact (without its
    fact ids), product focus, the cited facts {id, text} and token usage;
  * error rows: empty texts, status='error' and the violations (readers skip them; candidates() retries them while
    attempts < LEADMAKER_INSIGHTS_MAX_ATTEMPTS, at most hourly);
  * prune to the newest 3 rows per company, always keeping the newest ok row (so a string of failures never hides
    the last good insight);
  * ok rows only: one outbox 'lead.updated' {fields: ['insights'], material: false} carrying the company's current
    version, in the same transaction. companies is never written: insights are derived data, and a version bump
    would hand reps editing the lead a false "changed while you were editing" conflict (D4).
Deferred results (provider errors) write nothing.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from sqlalchemy import and_, delete, null, select

from ..db.repository import Repository, _insert_for, utcnow
from ..db.schema import company_insights
from .generate import InsightResult
from .prompt import PROMPT_VERSION

KEEP_ROWS = 3
MAX_ERROR_CHARS = 2000
_SECRETS = re.compile(r"AIza[0-9A-Za-z_\-]{20,}|sk-ant-[0-9A-Za-z_\-]{10,}|sk-[0-9A-Za-z]{20,}|"
                      r"((?:api[_-]?key|key|token)\s*[=:]\s*)\S+", re.I)


def redact(text: str) -> str:
    """Belt and braces: nothing that looks like an API key reaches a stored error."""
    return _SECRETS.sub(lambda m: (m.group(1) or "") + "[redacted]", text)


def row_values(r: InsightResult, now) -> dict[str, Any]:
    base = {"company_id": r.company_id, "model": r.model[:100], "prompt_version": PROMPT_VERSION,
            "input_hash": r.input_hash, "generated_at": now, "token_usage": dict(r.usage or {})}
    if r.ok and r.insight:
        i = r.insight
        return {**base, "status": "ok", "error": None, "business_summary": i["summary"],
                "sales_recommendation": i["pitch"], "talking_points": list(i.get("talking_points") or []),
                "target_contact": i.get("target_contact") or null(), "product_focus": list(i.get("product_focus") or []),
                "cited_facts": list(i.get("cited_facts") or [])}
    return {**base, "status": "error", "error": redact("; ".join(r.violations) or "generation failed")[:MAX_ERROR_CHARS],
            "business_summary": "", "sales_recommendation": "", "talking_points": [], "target_contact": null(),
            "product_focus": [], "cited_facts": []}


def prune(conn, company_id: str, keep: int = KEEP_ROWS) -> int:
    newest = select(company_insights.c.id).where(company_insights.c.company_id == company_id).order_by(
        company_insights.c.generated_at.desc(), company_insights.c.id.desc()).limit(keep)
    newest_ok = select(company_insights.c.id).where(
        company_insights.c.company_id == company_id, company_insights.c.status == "ok").order_by(
        company_insights.c.generated_at.desc(), company_insights.c.id.desc()).limit(1)
    keep_ids = set(conn.execute(newest).scalars()) | set(conn.execute(newest_ok).scalars())
    return conn.execute(delete(company_insights).where(
        and_(company_insights.c.company_id == company_id, company_insights.c.id.not_in(keep_ids)))).rowcount or 0


def save_result(repo: Repository, r: InsightResult, run_id: int | None) -> str | None:
    """Write one result in its own transaction; returns 'ok' | 'error' | None (deferred: nothing written)."""
    if r.deferred or not r.input_hash:
        return None
    now = utcnow()
    values = row_values(r, now)
    with repo.engine.begin() as conn:
        ins = _insert_for(conn)(company_insights).values(**values)
        update = {k: ins.excluded[k] for k in values if k not in ("company_id", "input_hash")}
        update["attempts"] = company_insights.c.attempts + 1
        conn.execute(ins.on_conflict_do_update(index_elements=["company_id", "input_hash"], set_=update))
        prune(conn, r.company_id)
        if values["status"] == "ok":
            Repository._lead_updated(conn, {r.company_id: {"fields": {"insights"}, "material": False}}, run_id)
    return values["status"]


def save_results(repo: Repository, results: Sequence[InsightResult], run_id: int | None) -> dict[str, int]:
    counts = {"ok": 0, "error": 0, "deferred": 0}
    for r in results:
        status = save_result(repo, r, run_id)
        counts[status or "deferred"] += 1
    return counts


def latest_rows(repo: Repository, company_ids: Sequence[str]) -> dict[str, dict[str, Any]]:
    """The newest row per company (any status)."""
    out: dict[str, dict[str, Any]] = {}
    ids = list(dict.fromkeys(company_ids))
    with repo.engine.connect() as conn:
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            rows = conn.execute(
                select(company_insights).where(company_insights.c.company_id.in_(part))
                .order_by(company_insights.c.company_id, company_insights.c.generated_at.desc(),
                          company_insights.c.id.desc())
            )
            for row in rows:
                out.setdefault(row.company_id, dict(row._mapping))
    return out


def latest_insight(repo: Repository, company_id: str) -> dict[str, Any] | None:
    return latest_rows(repo, [company_id]).get(company_id)


__all__ = ["KEEP_ROWS", "latest_insight", "latest_rows", "prune", "redact", "save_result",
           "save_results"]
