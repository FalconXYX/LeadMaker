"""GAF ingestion pipeline: area search -> upsert contractors -> fetch profile pages.

Idempotent and resumable: every step upserts by GAF contractor id, profile pages
are skipped while fresh (TTL), and failures are recorded per contractor without
aborting the run. One run row per (area) invocation records params and stats.

Completeness guard: an area read only counts as complete when Coveo returned
every result it reported (len(results) == totalCount > 0) and the count has not
collapsed against the previous complete read of the same area. Incomplete reads
still refresh contractor rows, but the run is 'partial', delisting is skipped,
and (once a complete baseline exists) the area's search hits are left alone, so
one bad read can neither mass-delist contractors nor shrink the area's lead list.
stats['completeness'] records the verdict for later "changed since last complete
poll" logic.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select

from ..config import Settings
from ..db import Repository
from ..db.schema import scrape_runs, search_hits
from ..http import HttpClient, HttpError
from ..models import SearchArea, SearchHit
from ..sources.gaf import GafClient, parse_coveo_result
from ..sources.gaf import client as gaf_client
from ..sources.gaf.client import AreaSearch
from ..sources.geocode import geocode_postal_code

log = logging.getLogger(__name__)

# A complete read may shrink by at most this much against the previous complete
# read of the same area before it is treated as a bad read (not mass delisting).
MIN_COUNT_RATIO = 0.8


@dataclass
class ScrapeOptions:
    postal_code: str = "10013"
    country: str = "US"
    radius_miles: float = 25
    latitude: float | None = None
    longitude: float | None = None
    fetch_profiles: bool = True
    force_profiles: bool = False
    max_profiles: int | None = None
    # Accept a read that dropped below MIN_COUNT_RATIO of the last complete one
    # (an operator has confirmed the drop is real).
    accept_count_drop: bool = False


@dataclass
class ScrapeReport:
    run_id: int
    area: SearchArea | None = None
    status: str = "running"
    stats: dict[str, Any] = field(default_factory=dict)


async def run_scrape(settings: Settings, repo: Repository, opts: ScrapeOptions) -> ScrapeReport:
    repo.create_schema()
    run_id = repo.start_run("gaf_ingest", {k: v for k, v in opts.__dict__.items()})
    report = ScrapeReport(run_id=run_id)
    stats: dict[str, Any] = {}
    try:
        async with HttpClient(settings) as http:
            gaf = GafClient(http)
            if opts.latitude is not None and opts.longitude is not None:
                area = SearchArea(
                    postal_code=opts.postal_code, country=opts.country, radius_miles=opts.radius_miles,
                    latitude=opts.latitude, longitude=opts.longitude, geocoder="manual",
                )
            else:
                area = await geocode_postal_code(
                    http, opts.postal_code, opts.country, opts.radius_miles, settings.google_maps_api_key
                )
            report.area = area
            stats["area"] = area.model_dump()
            log.info("search area %s r=%smi at (%.4f, %.4f) via %s",
                     area.postal_code, area.radius_miles, area.latitude, area.longitude, area.geocoder)

            cfg = await gaf.discover_config(area.postal_code, area.radius_miles)
            stats["coveo_config_discovered"] = cfg.discovered

            found = await gaf.search_area_detailed(area)
            total, results = found.total, found.results
            previous = previous_complete_read(repo, area, run_id)
            completeness = assess_completeness(found, previous, accept_count_drop=opts.accept_count_drop)
            stats["completeness"] = completeness
            if not completeness["complete"]:
                log.warning("incomplete area read (%s): %s", completeness["reason"], completeness["message"])
            contractors = []
            parse_errors = 0
            for r in results:
                try:
                    contractors.append(parse_coveo_result(r))
                except Exception as e:  # one malformed record must not sink the run
                    parse_errors += 1
                    log.warning("could not parse result %s: %s", r.get("uniqueId"), e)
            stats.update(coveo_total=total, results=len(results), parsed=len(contractors), parse_errors=parse_errors)
            log.info("coveo returned %d/%d contractors", len(results), total)

            try:
                rec_ids = await gaf.recommended_ids(area)
            except HttpError as e:
                log.warning("recommended ranking unavailable: %s", e)
                rec_ids = []
            rec_rank = {gid: i + 1 for i, gid in enumerate(rec_ids)}
            stats["gaf_recommended"] = len(rec_rank)

            upserted = repo.upsert_contractors(contractors, run_id=run_id)
            stats["upsert"] = upserted
            hits = [
                SearchHit(
                    gaf_id=c.gaf_id,
                    distance_miles=c.raw.get(cfg.fields.get("distanceInMiles", "distanceinmiles")),
                    rank=i + 1,
                    gaf_recommended=c.gaf_id in rec_rank,
                    gaf_recommended_rank=rec_rank.get(c.gaf_id),
                )
                for i, c in enumerate(contractors)
            ]
            # Without a complete baseline, a partial list is still better than no area view.
            record_hits = completeness["complete"] or previous is None
            if record_hits:
                repo.record_search_hits(run_id, area, hits)
            completeness["hits_recorded"] = record_hits
            if completeness["complete"]:
                # Ids come from the raw results, so a record that failed to parse is not "delisted".
                seen_ids = [str(r.get("raw", {}).get("gaf_contractor_id")) for r in results]
                stats["delisted"] = len(repo.record_delisted(run_id, area, seen_ids))
            else:
                stats["delisted"] = None  # unknown: skipped on an incomplete read

            if opts.fetch_profiles:
                stats["profiles"] = await _fetch_profiles(settings, repo, gaf, contractors, opts, run_id)
            stats["http"] = dict(http.stats)

        prof = stats.get("profiles", {})
        incomplete = not stats["completeness"]["complete"]
        report.status = "partial" if prof.get("failed") or parse_errors or incomplete else "succeeded"
        report.stats = stats
        repo.finish_run(run_id, report.status, stats)
    except Exception as e:
        log.exception("scrape run %d failed", run_id)
        verdict = stats.get("completeness")
        if verdict and verdict["complete"] and not verdict.get("hits_recorded"):
            # The read was whole but never stored, so this run is no baseline.
            verdict.update(complete=False, reason="run_failed", message="run failed before search hits were stored")
        report.status = "failed"
        report.stats = stats
        repo.finish_run(run_id, "failed", stats, error=f"{type(e).__name__}: {e}")
        raise
    return report


def assess_completeness(
    found: AreaSearch, previous: dict[str, Any] | None, *, accept_count_drop: bool = False
) -> dict[str, Any]:
    """Decide whether an area read saw the whole area. Pure; the result goes into run stats.

    previous is {"run_id", "results"} of the last complete read of the same area, or None.
    """
    n, total = len(found.results), found.total
    out: dict[str, Any] = {
        "complete": False, "reason": None, "message": None, "results": n, "total": total,
        "previous": previous, "stop_reason": found.stop_reason,
    }
    if found.duplicates or found.missing_ids:
        out.update(duplicates=found.duplicates, missing_ids=found.missing_ids)
    if found.stop_reason == "depth_limit":
        out["reason"] = "depth_limit"
        out["message"] = (
            f"Coveo stops at {gaf_client.COVEO_MAX_DEPTH} results; read {n} of {total}. "
            "Tile the area into smaller radii/ZIPs so each tile stays under the limit."
        )
    elif total <= 0:
        out["reason"] = "zero_total"
        out["message"] = "Coveo reported 0 results; treated as a failed read, not an empty area."
    elif n != total:
        out["reason"] = "count_mismatch"
        out["message"] = f"read {n} of {total} reported results (pagination stopped: {found.stop_reason})."
    elif previous and n < MIN_COUNT_RATIO * previous["results"] and not accept_count_drop:
        out["reason"] = "count_drop"
        out["message"] = (
            f"{n} results is under {MIN_COUNT_RATIO:.0%} of the {previous['results']} in complete run "
            f"#{previous['run_id']}. Re-run to confirm; if the drop is real, re-run with accept_count_drop."
        )
    else:
        out["complete"] = True
    return out


def _complete_count(stats: dict[str, Any] | None) -> int | None:
    """Result count of a complete read, or None if the run's read was not complete."""
    stats = stats or {}
    verdict = stats.get("completeness")
    if isinstance(verdict, dict):
        return int(verdict["results"]) if verdict.get("complete") else None
    # Runs from before the guard: apply the same count rule to their stats.
    total, n = stats.get("coveo_total"), stats.get("results")
    if isinstance(total, int) and total > 0 and n == total:
        return n
    return None


def previous_complete_read(repo: Repository, area: SearchArea, before_run_id: int) -> dict[str, Any] | None:
    """{"run_id", "results"} of the newest complete read of this area before before_run_id.

    Candidates come from search_hits (indexed by area); the verdict comes from the run's stats.
    """
    with repo.engine.connect() as conn:
        run_ids = conn.execute(
            select(search_hits.c.run_id)
            .where(
                search_hits.c.postal_code == area.postal_code,
                search_hits.c.radius_miles == area.radius_miles,
                search_hits.c.run_id < before_run_id,
            )
            .group_by(search_hits.c.run_id)
            .order_by(search_hits.c.run_id.desc())
            .limit(50)
        ).scalars().all()
        if not run_ids:
            return None
        rows = conn.execute(
            select(scrape_runs.c.id, scrape_runs.c.stats)
            .where(scrape_runs.c.id.in_(run_ids))
            .order_by(scrape_runs.c.id.desc())
        )
        for row in rows:
            count = _complete_count(row.stats)
            if count is not None:
                return {"run_id": int(row.id), "results": count}
    return None


async def _fetch_profiles(
    settings, repo, gaf: GafClient, contractors, opts: ScrapeOptions, run_id: int | None = None
) -> dict[str, int]:
    by_id = {c.gaf_id: c for c in contractors}
    due = repo.profiles_due(list(by_id), settings.profile_ttl_hours, force=opts.force_profiles)
    if opts.max_profiles is not None:
        due = due[: opts.max_profiles]
    counts = {"due": len(due), "fetched": 0, "failed": 0, "skipped_fresh": len(by_id) - len(due)}
    log.info("fetching %d profile pages (%d fresh, skipped)", len(due), counts["skipped_fresh"])

    async def one(gid: str) -> None:
        c = by_id[gid]
        try:
            profile = await gaf.fetch_profile(gid, c.profile_url)
            repo.save_profile(profile, run_id=run_id)
            counts["fetched"] += 1
        except Exception as e:
            counts["failed"] += 1
            repo.save_profile_error(gid, f"{type(e).__name__}: {e}")
            log.warning("profile %s failed: %s", gid, e)
        done = counts["fetched"] + counts["failed"]
        if done % 25 == 0 or done == len(due):
            log.info("profiles %d/%d (failed %d)", done, len(due), counts["failed"])

    await asyncio.gather(*(one(g) for g in due))
    return counts
