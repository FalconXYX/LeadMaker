"""The insights run: pick leads, skip the unchanged ones by input_hash, generate in batches, save as they land.

    run_insights(settings, repo, InsightsOptions(...)) -> {"run_id", "status", "considered", "skipped_unchanged",
        "skipped_dnc", "generated", "errors", "llm_calls", ...}

Lead set: --company ids, else an area (its latest search run), else with `stale` the candidates() prefilter,
else every company; allocated leads first, then priority. Each lead's facts and input_hash are built; a lead is
skipped when its newest row has that hash and is ok, or is an error row that already used its attempts
(LEADMAKER_INSIGHTS_MAX_ATTEMPTS) or is younger than an hour. --force regenerates anyway; --dry-run stops after the
hashes (no model calls, no writes). Batches of LEADMAKER_INSIGHTS_BATCH_SIZE leads go out with
LEADMAKER_INSIGHTS_CONCURRENCY in flight (the provider's limiter spaces them); a batch holds one rep's
leads or pool leads only, never a mix (owner_batches) and are saved as each one returns,
so a stopped run resumes where it left off. A spent daily quota stops the run ("partial", reason "quota"); an
auth failure aborts it (the job fails and dead-letters after 2 attempts).

A rep's "Refresh" on one profile (crm-write POST /api/leads/:id/insights/refresh) queues a job with
{company_ids: [id], force: true, requested_by}: a manual run. It skips the input_hash check like --force and draws
on its own small daily allowance (LEADMAKER_MANUAL_INSIGHTS_PER_DAY, default 40; 0 = share the batch budget), a
separate limiter on the same model, so it still runs once the batch budget is spent and never eats into it. A
manual run gives each lead up to MANUAL_ATTEMPTS (3) model calls instead of a batch run's 2.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
from dataclasses import asdict, dataclass, fields
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import exists, func, or_, select

from ..config import Settings
from ..db.repository import Repository, as_utc, utcnow
from ..db.schema import activity_logs, companies, company_insights, enrichments
from ..llm import LlmAuthError, LlmProvider, get_provider
from ..llm.ratelimit import get_limiter
from .facts import LeadFacts, build_facts, input_hash
from .generate import BATCH_ATTEMPTS, MANUAL_ATTEMPTS, InsightResult, generate
from .store import latest_rows, redact, save_result

log = logging.getLogger(__name__)

RUN_KIND = "insights"
ERROR_RETRY_AFTER = timedelta(hours=1)
STALE_ACTIVITY_TYPES = ("note", "call", "email", "visit")
STALE_ENRICHMENT_SOURCES = ("website_crawl", "llm_extract")
FACTS_CHUNK = 200
MANUAL_MAX_LEADS = 5  # a manual (rep-requested) run covers one profile; more ids is a batch job, on the batch budget


def _env_int(name: str, default: int, lo: int | None = None, hi: int | None = None) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        v = int(raw) if raw else default
    except ValueError:
        log.warning("ignoring %s=%r (not an integer)", name, raw)
        v = default
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def batch_size_default() -> int:
    return _env_int("LEADMAKER_INSIGHTS_BATCH_SIZE", 1, 1, 8)


def concurrency_default() -> int:
    return _env_int("LEADMAKER_INSIGHTS_CONCURRENCY", 2, 1, 16)


def max_attempts_default() -> int:
    return _env_int("LEADMAKER_INSIGHTS_MAX_ATTEMPTS", 3, 1)


def manual_per_day_default() -> int:
    """Model calls per quota day for manual refreshes (LEADMAKER_MANUAL_INSIGHTS_PER_DAY); 0 = no separate allowance."""
    return _env_int("LEADMAKER_MANUAL_INSIGHTS_PER_DAY", 40, 0)


@dataclass
class InsightsOptions:
    postal_code: str | None = None
    radius_miles: float | None = None
    company_ids: list[str] | None = None
    stale: bool = False
    limit: int | None = None  # max leads sent to the model this run
    force: bool = False  # regenerate even when the hash matches
    batch_size: int | None = None  # default LEADMAKER_INSIGHTS_BATCH_SIZE (1); 1..8
    dry_run: bool = False  # facts + hashes only; no LLM calls, no writes
    requested_by: str | None = None  # the rep who pressed Refresh on a profile (job params only, not jobs.requested_by)

    @property
    def manual(self) -> bool:
        """A rep's on-demand refresh of a profile: forced, a requester, and only a few company ids."""
        return bool(self.force and self.requested_by and self.company_ids
                    and len(self.company_ids) <= MANUAL_MAX_LEADS)

    @classmethod
    def from_params(cls, params: dict[str, Any] | None) -> "InsightsOptions":
        """Job params -> options; unknown keys are ignored (an area job also carries e.g. `sources`)."""
        p = dict(params or {})
        if "company_id" in p and "company_ids" not in p:
            p["company_ids"] = p["company_id"]
        if isinstance(p.get("company_ids"), str):
            p["company_ids"] = [p["company_ids"]]
        known = {f.name for f in fields(cls)}
        opts = cls(**{k: v for k, v in p.items() if k in known})
        opts.stale, opts.force, opts.dry_run = bool(opts.stale), bool(opts.force), bool(opts.dry_run)
        if opts.requested_by is not None:
            opts.requested_by = str(opts.requested_by) or None
        if opts.radius_miles is not None:
            opts.radius_miles = float(opts.radius_miles)
        if opts.postal_code is not None:
            opts.postal_code = str(opts.postal_code)
            if opts.radius_miles is None:
                opts.radius_miles = 25.0
        for k in ("limit", "batch_size"):
            if getattr(opts, k) is not None:
                setattr(opts, k, int(getattr(opts, k)))
        return opts

    def params(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v not in (None, False)}


def provider_ready(settings: Settings, provider: LlmProvider | None = None) -> tuple[LlmProvider | None, str]:
    """(provider, "") when one is configured and usable, else (None or the unusable provider, why not)."""
    if provider is None:
        try:
            provider = get_provider(settings)
        except ValueError as e:  # an unknown LEADMAKER_LLM_PROVIDER
            return None, str(e)
    if provider is None:
        return None, "no LLM provider configured"
    ok, why = provider.is_configured()
    return (provider, "") if ok else (None, why)


def manual_provider(settings: Settings, provider: LlmProvider, per_day: int | None = None) -> LlmProvider:
    """The provider on the manual-refresh allowance: a shallow copy with its own limiter ("<provider>:<model>:manual",
    the same per-minute spacing, `per_day` requests per quota day, persisted next to the batch counter). The batch
    limiter is left as it is. per_day <= 0 returns the provider unchanged (manual runs share the batch budget)."""
    per_day = manual_per_day_default() if per_day is None else per_day
    if per_day <= 0:
        return provider
    manual = copy.copy(provider)
    manual.limiter = get_limiter(f"{provider.fingerprint}:manual", getattr(provider.limiter, "rpm", 0), per_day,
                                 settings.llm_usage_file)
    return manual


# --------------------------------------------------------------------------- lead selection


def candidates(repo: Repository, now: datetime | None = None, *, max_attempts: int | None = None) -> list[str]:
    """Cheap prefilter for `--stale` (the input_hash compare is the truth): companies with no insight row, or whose
    newest row is older than the company's last update (overrides, custom fields and tags, stage), its newest
    note/call/email/visit, or its newest website crawl / LLM extraction; plus companies whose newest row is an
    error with attempts left that is over an hour old. Weather and timing never make a lead a candidate."""
    now = now or utcnow()
    max_attempts = max_attempts or max_attempts_default()
    ci = company_insights.alias("ci")
    last = select(func.max(ci.c.generated_at)).where(ci.c.company_id == companies.c.id).scalar_subquery()
    last_activity = select(func.max(activity_logs.c.created_at)).where(
        activity_logs.c.company_id == companies.c.id, activity_logs.c.action_type.in_(STALE_ACTIVITY_TYPES)
    ).scalar_subquery()
    last_enrichment = select(func.max(enrichments.c.fetched_at)).where(
        enrichments.c.company_id == companies.c.id, enrichments.c.source.in_(STALE_ENRICHMENT_SOURCES)
    ).scalar_subquery()
    ce = company_insights.alias("ce")
    retry_error = exists().where(
        ce.c.company_id == companies.c.id, ce.c.generated_at == last, ce.c.status == "error",
        ce.c.attempts < max_attempts, ce.c.generated_at < now - ERROR_RETRY_AFTER,
    )
    q = select(companies.c.id).where(or_(
        last.is_(None), companies.c.updated_at > last, last_activity > last, last_enrichment > last, retry_error,
    ))
    with repo.engine.connect() as conn:
        return list(conn.execute(q).scalars())


def ordered(repo: Repository, ids: list[str] | None) -> list[str]:
    """These companies (all when None), allocated first, then priority_score DESC NULLS LAST, then id."""
    q = select(companies.c.id, companies.c.assigned_rep_id, companies.c.priority_score)
    rows: list[Any] = []
    with repo.engine.connect() as conn:
        if ids is None:
            rows = list(conn.execute(q))
        else:
            uniq = list(dict.fromkeys(ids))
            for i in range(0, len(uniq), 500):
                rows += list(conn.execute(q.where(companies.c.id.in_(uniq[i:i + 500]))))
    rows.sort(key=lambda r: (r.assigned_rep_id is None, r.priority_score is None, -(r.priority_score or 0), str(r.id)))
    return [str(r.id) for r in rows]


def owners(repo: Repository, ids: list[str]) -> dict[str, str | None]:
    """company id -> assigned_rep_id (None = the unallocated pool)."""
    out: dict[str, str | None] = {}
    uniq = list(dict.fromkeys(ids))
    with repo.engine.connect() as conn:
        for i in range(0, len(uniq), 500):
            for r in conn.execute(select(companies.c.id, companies.c.assigned_rep_id)
                                  .where(companies.c.id.in_(uniq[i:i + 500]))):
                out[str(r.id)] = str(r.assigned_rep_id) if r.assigned_rep_id is not None else None
    return out


def owner_batches(todo: list[LeadFacts], owner_of: dict[str, str | None], size: int) -> list[list[LeadFacts]]:
    """Batches that never mix audiences: one rep's leads, or pool leads, per call (in todo's order). One prompt
    then never carries two reps' private notes, so a model that mixes items up stays inside one book."""
    groups: dict[str | None, list[LeadFacts]] = {}
    for f in todo:
        groups.setdefault(owner_of.get(f.company_id), []).append(f)
    return [g[i:i + size] for g in groups.values() for i in range(0, len(g), size)]


def lead_set(repo: Repository, opts: InsightsOptions, now: datetime) -> list[str]:
    if opts.company_ids:
        return ordered(repo, [str(c) for c in opts.company_ids])
    if opts.postal_code and opts.radius_miles:
        return ordered(repo, repo.area_company_ids(opts.postal_code, float(opts.radius_miles)))
    if opts.stale:
        return ordered(repo, candidates(repo, now))
    return ordered(repo, None)


def _skip_reason(row: dict[str, Any] | None, now: datetime, max_attempts: int) -> str | None:
    if row is None:
        return None
    if row["status"] == "ok":
        return "unchanged"
    generated = as_utc(row["generated_at"])
    if int(row["attempts"] or 0) >= max_attempts:
        return "failed"  # this exact input already failed max_attempts runs: wait for the facts to change
    if generated is not None and generated > now - ERROR_RETRY_AFTER:
        return "backoff"
    return None


# --------------------------------------------------------------------------- the run


async def run_insights(settings: Settings, repo: Repository, opts: InsightsOptions | None = None, *,
                       provider: LlmProvider | None = None, now: datetime | None = None,
                       http: Any = None) -> dict[str, Any]:
    opts = opts or InsightsOptions()
    now = now or utcnow()
    max_attempts = max_attempts_default()
    batch_size = max(1, min(8, opts.batch_size or batch_size_default()))
    ready, why = provider_ready(settings, provider)
    if ready is None and not opts.dry_run:
        return {"run_id": None, "status": "skipped", "reason": "no_provider", "detail": why}
    if ready is not None and opts.manual and not opts.dry_run:
        ready = manual_provider(settings, ready)
    if ready is not None:
        fingerprint = ready.fingerprint
    else:  # dry run without a usable provider: hash against the configured (or no) model
        try:
            fingerprint = f"{settings.llm_provider or 'none'}:{settings.llm_model if settings.llm_provider else ''}"
        except ValueError:
            fingerprint = "none:"

    ids = lead_set(repo, opts, now)
    stats: dict[str, Any] = {"considered": len(ids), "skipped_unchanged": 0, "skipped_dnc": 0, "skipped_failed": 0,
                             "skipped_backoff": 0, "generated": 0, "errors": 0, "deferred": 0, "llm_calls": 0,
                             "batch_size": batch_size, "model": fingerprint}
    if opts.manual:
        stats["manual"] = True
    todo: list[LeadFacts] = []
    hashes: dict[str, str] = {}
    for i in range(0, len(ids), FACTS_CHUNK):
        if opts.limit is not None and len(todo) >= opts.limit:
            break
        chunk = build_facts(repo, ids[i:i + FACTS_CHUNK])
        live = [f for f in chunk if not f.skip_reason]
        stats["skipped_dnc"] += len(chunk) - len(live)
        chunk_hashes = {f.company_id: input_hash(f, fingerprint) for f in live}
        hashes.update(chunk_hashes)
        # Compared with each company's newest row (any status): an older row with the same hash is not enough,
        # because readers show the newest ok row; the upsert then refreshes that older row in place.
        latest = {} if opts.force else latest_rows(repo, list(chunk_hashes))
        for f in live:
            row = latest.get(f.company_id)
            why_skip = _skip_reason(row if row and row["input_hash"] == chunk_hashes[f.company_id] else None, now,
                                    max_attempts)
            if why_skip:
                stats[f"skipped_{why_skip}"] += 1
            elif opts.limit is None or len(todo) < opts.limit:
                todo.append(f)
    stats["to_generate"] = len(todo)

    if opts.dry_run:
        return {"run_id": None, "status": "dry_run", **stats, "provider_ready": ready is not None,
                "leads": [{"company_id": f.company_id, "business_name": f.business_name, "facts": len(f.facts),
                           "website_chars": len(f.website_excerpt), "input_hash": hashes[f.company_id]}
                          for f in todo[:50]],
                "estimated_llm_calls": -(-len(todo) // batch_size) if todo else 0}

    assert ready is not None
    run_id = repo.start_run(RUN_KIND, opts.params())
    stop: dict[str, Any] = {}
    fatal: list[BaseException] = []
    counter = {"llm_calls": 0}
    sem = asyncio.Semaphore(concurrency_default())
    batches = owner_batches(todo, owners(repo, [f.company_id for f in todo]), batch_size)
    stats["batches"] = len(batches)

    async def one(batch: list[LeadFacts], client: Any) -> None:
        async with sem:
            if stop:
                for _ in batch:
                    stats["deferred"] += 1
                return
            results: list[InsightResult] = await generate(
                ready, client, batch, stats=counter, model_attempts=MANUAL_ATTEMPTS if opts.manual else BATCH_ATTEMPTS)
            for r in results:
                status = save_result(repo, r, run_id)
                if status == "ok":
                    stats["generated"] += 1
                elif status == "error":
                    stats["errors"] += 1
                    log.info("insights %s: error row (%s)", r.company_id, "; ".join(r.violations)[:300])
                else:
                    stats["deferred"] += 1
                    if r.deferred == "quota" and "quota" not in stop:
                        stop["quota"] = r.error or "daily quota exhausted"
                        stop["resets_at"] = r.resets_at
                    elif r.deferred == "auth" and "auth" not in stop:
                        stop["auth"] = r.error or "authentication failed"
                    elif r.deferred:
                        stats.setdefault("deferred_reasons", {}).setdefault(r.deferred, 0)
                        stats["deferred_reasons"][r.deferred] += 1

    try:
        if http is not None:
            await asyncio.gather(*(one(b, http) for b in batches))
        elif batches:
            from ..http import HttpClient

            async with HttpClient(settings) as client:
                await asyncio.gather(*(one(b, client) for b in batches))
    except BaseException as e:  # a bug or cancellation: record the run as failed, then re-raise
        fatal.append(e)
    stats["llm_calls"] = counter["llm_calls"]
    if fatal:
        repo.finish_run(run_id, "failed", stats, redact(f"{type(fatal[0]).__name__}: {fatal[0]}")[:2000], emit=False)
        raise fatal[0]
    if "auth" in stop:
        stats["reason"] = "auth"
        why = redact(str(stop["auth"]))[:2000]
        repo.finish_run(run_id, "failed", stats, why, emit=False)
        raise LlmAuthError(f"insights run {run_id} aborted: {why}", provider=ready.name)
    if "quota" in stop:
        status = "partial"
        stats["reason"] = "quota"
        resets = getattr(ready.limiter, "resets_at", None)
        stats["resets_at"] = stop.get("resets_at") or (resets().isoformat() if callable(resets) else None)
    elif stats["deferred"]:
        status = "partial" if (stats["generated"] or stats["errors"]) else "failed"
        stats["reason"] = "provider_errors"
    else:
        status = "succeeded"
    repo.finish_run(run_id, status, stats, None, emit=False)
    return {"run_id": run_id, "status": status, **stats}


__all__ = ["InsightsOptions", "MANUAL_MAX_LEADS", "batch_size_default", "candidates", "concurrency_default",
           "lead_set", "manual_per_day_default", "manual_provider", "max_attempts_default", "ordered", "owner_batches",
           "owners", "provider_ready", "run_insights"]
