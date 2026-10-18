"""Regional signals pipeline: county assignment -> NWS alerts -> storm history -> local news.

All work is per county (17 counties for the 424 leads around 10013), never per lead,
and nothing here calls an LLM. Each step is isolated: a failing source marks the run
`partial` and the others still land. Badges are computed at read time from the stored
rows (`lead_timing_badges`), so a weather refresh never re-runs per-lead work.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from ..config import Settings
from ..db import Repository
from ..http import HttpClient
from ..signals import counties as county_mod
from ..signals import store, storms, weather
from ..signals.timing import timing_badges

log = logging.getLogger(__name__)


async def _news(http: HttpClient, settings: Settings, repo: Repository, counties: list[dict[str, Any]]) -> dict[str, Any]:
    """Optional hook: leadmaker.signals.news.fetch_county_news, skipped when not installed."""
    try:
        from ..signals.news import fetch_county_news  # type: ignore[attr-defined]
    except ImportError as e:
        return {"skipped": f"news module not available ({e})"}
    rows = await fetch_county_news(http, settings, [
        {"county_fips": c["county_fips"], "county_name": c["county_name"], "state": c["state"]} for c in counties
    ])
    rows = [{**r, "kind": r.get("kind") or "news"} for r in rows or []]
    return {"rows": len(rows), "rows_written": store.upsert_signals(repo, rows)}


async def run_signals(
    settings: Settings, repo: Repository, *, force_storms: bool = False, news: bool = True,
    refine_points: bool = True, now: datetime | None = None,
) -> dict[str, Any]:
    """Refresh every county signal for the leads in the DB. Returns stats (also stored on the run)."""
    now = now or datetime.now(timezone.utc)
    run_id = repo.start_run("signals", {"force_storms": force_storms, "news": news})
    stats: dict[str, Any] = {"run_id": run_id}
    errors: dict[str, str] = {}

    async def step(name: str, coro: Any) -> Any:
        try:
            out = await coro
        except Exception as e:  # one source failing must not block the others
            log.exception("signals: %s failed", name)
            errors[name] = f"{type(e).__name__}: {e}"[:500]
            return None
        stats[name] = out
        return out

    try:
        async with HttpClient(settings) as http:
            index = await county_mod.load_county_index(http)
            assigned = county_mod.assign_county_fips(repo, index)
            if refine_points:
                assigned["point_check"] = await county_mod.refine_by_point(
                    http, repo, assigned["unmapped"] + assigned["split"])
            assigned["unmapped"] = len(assigned["unmapped"])
            assigned["split"] = len(assigned["split"])
            stats["counties"] = assigned
            counties = county_mod.lead_counties(repo, index)
            fips = [c["county_fips"] for c in counties]
            stats["county_list"] = [f"{c['county_fips']} {c['county_name']} ({c['leads']})" for c in counties]
            await step("alerts", weather.refresh_alerts(http, settings, repo, fips, now=now))
            storm = await step("storm_history", storms.refresh_storm_history(
                http, settings, repo, index, fips, now=now, force=force_storms))
            if storm and storm.get("lsr_error"):  # NCEI rows landed, but the post-NCEI gap is missing
                errors["storm_history"] = f"storm reports (IEM): {storm['lsr_error']}"[:500]
            if news:
                await step("news", _news(http, settings, repo, counties))
            stats["http"] = dict(http.stats)
    except Exception as e:
        errors["run"] = f"{type(e).__name__}: {e}"[:500]
        log.exception("signals run failed")
    stats["errors"] = errors
    status = "failed" if "run" in errors else ("partial" if errors else "succeeded")
    repo.finish_run(run_id, status, stats, error="; ".join(f"{k}: {v}" for k, v in errors.items()) or None)
    stats["status"] = status
    return stats


def lead_timing_badges(
    repo: Repository, leads: list[dict[str, Any]], now: datetime | None = None
) -> dict[str, list[dict[str, Any]]]:
    """{gaf_id: badges} for lead records, with one signals query for all their counties."""
    now = now or datetime.now(timezone.utc)
    fips = sorted({l["county_fips"] for l in leads if l.get("county_fips")})
    # No date filter: ended alerts are purged after weather.RETENTION_DAYS and timing applies its own windows.
    by_county = store.signals_for_counties(repo, fips, kinds=[weather.KIND, storms.KIND])
    return {l["gaf_id"]: timing_badges(l, by_county.get(l.get("county_fips") or "", []), now) for l in leads}
