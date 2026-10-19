"""Enrichment orchestrator: runs every enabled enricher over a set of companies.

Per company, enrichers run in dependency order (so website_crawl sees the
website found by website_discovery); across companies, work runs concurrently.
Each (company, source) result is persisted immediately, so an interrupted
run resumes where it stopped. Fresh results (TTL) are reused as inputs, not
re-fetched.
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from ..config import Settings
from ..db import Repository
from ..db.repository import company_label, utcnow
from ..enrich import load_enrichers
from ..models import EnrichmentStatus
from ..enrich.base import WEBSITE_PRIORITY, Enricher, LeadContext
from ..http import HttpClient
from ..models import EnrichmentResult

log = logging.getLogger(__name__)

ENRICHER_TIMEOUT_S = 180


@dataclass
class EnrichOptions:
    postal_code: str | None = "10013"
    radius_miles: float = 25
    sources: list[str] | None = None
    company_ids: list[str] | None = None
    gaf_ids: list[str] | None = None  # resolved to company ids through company_source_ids
    force: bool = False
    limit: int | None = None


@dataclass
class EnrichReport:
    run_id: int
    status: str = "running"
    stats: dict[str, Any] = field(default_factory=dict)


def _row_to_result(row: dict[str, Any]) -> EnrichmentResult:
    return EnrichmentResult(
        source=row["source"],
        status=EnrichmentStatus(row["status"]),
        confidence=row.get("confidence") or 0.0,  # enrichments.match_confidence (repository read model)
        data=row.get("data") or {},
        website=row.get("website"),
        source_urls=row.get("source_urls") or [],
        error=row.get("error"),
        fetched_at=row.get("fetched_at"),
    )


def dependency_waves(enrichers: list[Enricher]) -> list[list[Enricher]]:
    """Group enrichers so each wave only depends on earlier waves (deps outside the set are ignored)."""
    names = {e.name for e in enrichers}
    level: dict[str, int] = {}
    for e in enrichers:  # already topologically ordered
        deps = [level[d] for d in e.depends_on if d in names and d in level]
        level[e.name] = 1 + max(deps) if deps else 0
    waves: list[list[Enricher]] = [[] for _ in range(max(level.values(), default=-1) + 1)]
    for e in enrichers:
        waves[level[e.name]].append(e)
    return waves


def resolve_website(ctx: LeadContext) -> tuple[str | None, str | None]:
    for src in WEBSITE_PRIORITY:
        r = ctx.ok_prior(src)
        if r is not None and r.website:
            return r.website, src
    return None, None


def target_company_ids(repo: Repository, opts: EnrichOptions) -> list[str]:
    if opts.company_ids or opts.gaf_ids:
        by_gaf = repo.company_ids(opts.gaf_ids or [])
        missing = [g for g in opts.gaf_ids or [] if g not in by_gaf]
        if missing:
            log.warning("no company for GAF ids %s", ", ".join(missing))
        ids = list(dict.fromkeys([*(opts.company_ids or []), *(by_gaf[g] for g in opts.gaf_ids or [] if g in by_gaf)]))
    elif opts.postal_code:
        ids = repo.area_company_ids(opts.postal_code, opts.radius_miles)
    else:
        ids = [r["company_id"] for r in repo.get_companies()]
    return ids[: opts.limit] if opts.limit is not None else ids


async def run_enrich(settings: Settings, repo: Repository, opts: EnrichOptions) -> EnrichReport:
    ids = target_company_ids(repo, opts)
    rows = repo.get_companies(ids)
    ids = [r["company_id"] for r in rows]

    enrichers = load_enrichers(settings, opts.sources)
    run_id = repo.start_run(
        "enrich", {"sources": [e.name for e in enrichers], "contractors": len(rows), "force": opts.force,
                   "postal_code": opts.postal_code, "radius_miles": opts.radius_miles},
    )
    report = EnrichReport(run_id=run_id)
    counts: dict[str, Counter] = {e.name: Counter() for e in enrichers}
    disabled: dict[str, str] = {}

    try:
        stored = repo.get_enrichments(ids)
        async with HttpClient(settings) as http:
            active: list[Enricher] = []
            for e in enrichers:
                ok, why = e.is_enabled()
                if not ok:
                    disabled[e.name] = why
                    log.warning("enricher %s disabled: %s", e.name, why)
                    continue
                try:
                    await e.prepare(http, rows)
                    active.append(e)
                except Exception as ex:
                    disabled[e.name] = f"prepare failed: {type(ex).__name__}: {ex}"
                    log.exception("enricher %s prepare failed", e.name)
            due = {
                e.name: set(repo.enrichments_due(ids, e.name, settings.enrichment_ttl_hours, force=opts.force))
                for e in active
            }
            waves = dependency_waves(active)
            log.info("enrichment waves: %s", [[e.name for e in w] for w in waves])
            sem = asyncio.Semaphore(max(1, settings.concurrency * 2))
            done = 0

            async def per_contractor(row: dict[str, Any]) -> None:
                nonlocal done
                cid = row["company_id"]
                ctx = LeadContext(
                    contractor=row,
                    prior={src: _row_to_result(r) for src, r in stored.get(cid, {}).items()},
                )
                async def run_one(e: Enricher) -> None:
                    ihash = e.input_hash(ctx)
                    stored_hash = (stored.get(cid, {}).get(e.name) or {}).get("input_hash")
                    if cid not in due[e.name]:
                        if stored_hash is None or stored_hash == ihash:
                            counts[e.name]["fresh"] += 1
                            return
                        counts[e.name]["input_changed"] += 1  # inside TTL, but inputs moved
                    if not e.applies_to(ctx):
                        result = e.skipped("not applicable")
                    else:
                        try:
                            result = await asyncio.wait_for(e.enrich(ctx, http), getattr(e, "timeout_s", ENRICHER_TIMEOUT_S))
                        except Exception as ex:
                            log.warning("%s failed for %s: %s", e.name, company_label(row), ex)
                            result = e.error(f"{type(ex).__name__}: {ex}")
                    prev = stored.get(cid, {}).get(e.name) or {}
                    if (result.status == EnrichmentStatus.SKIPPED and (result.data or {}).get("retry")
                            and prev.get("status") in ("ok", EnrichmentStatus.OK)):
                        # Quota skip (e.g. LLM free-tier budget): keep the old result; next run retries.
                        counts[e.name]["deferred"] += 1
                        return
                    result.fetched_at = utcnow()
                    repo.save_enrichment(cid, result, run_id, input_hash=ihash)
                    ctx.prior[e.name] = result
                    counts[e.name][result.status.value] += 1

                async with sem:
                    # Independent sources run concurrently; a wave starts once its dependencies finished.
                    for wave in waves:
                        await asyncio.gather(*(run_one(e) for e in wave))
                    site, src = resolve_website(ctx)
                    if site and (site != row.get("website") or src != row.get("website_source")):
                        repo.set_website(cid, site, src, run_id=run_id)
                done += 1
                if done % 25 == 0 or done == len(rows):
                    log.info("enriched %d/%d contractors", done, len(rows))

            await asyncio.gather(*(per_contractor(r) for r in rows))
            report.stats = {
                "contractors": len(rows),
                "by_source": {k: dict(v) for k, v in counts.items()},
                "disabled": disabled,
                "http": dict(http.stats),
            }
        errors = sum(c.get("error", 0) for c in counts.values())
        report.status = "partial" if errors else "succeeded"
        repo.finish_run(run_id, report.status, report.stats)
    except Exception as e:
        report.status = "failed"
        repo.finish_run(run_id, "failed", report.stats, error=f"{type(e).__name__}: {e}")
        raise
    return report
