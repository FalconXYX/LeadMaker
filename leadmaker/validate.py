"""Data validation: check a database against Section 1's guarantees.

Every check is a function over the stored tables (SQLAlchemy Core on `repo.engine`, nothing is
written) and returns rows shaped

    {id, group, status: pass|warn|fail|info, value, threshold, detail, examples[]}

`validate()` runs every group for one search area (default: the area of the newest search run)
and returns a report; `leadmaker validate` prints it and exits 1 when a check fails (or warns,
with --strict).

Thresholds (all module constants below, so a test or deployment can tighten them):
  integrity    duplicate GAF id (case/space variants, or two GAF ids on one company): fail on any.
               Search-hit distance <= radius + 0.5 mi, else fail.
               lat/lng present: pass >= 99%, warn >= 95%. name/tier 100% (else fail);
               address/phone pass >= 98%, warn >= 90%. Orphan rows (incl. companies without a
               source id): fail on any. Same phone + near-identical name under two GAF ids: warn.
  run health   Latest finished scrape of the area must be a complete read, by the same rule the
               scrape guard uses for its baseline (fail). Runs/jobs 'running'
               for > 2 h: warn. Dead jobs: warn. Signals run age: pass <= 24 h, warn <= 7 d.
  freshness    Profiles / each source's rows inside their TTL: pass >= 95%, warn >= 50%.
               Per-source error rate (errors / non-skipped rows): warn > 10%, fail > 30%.
  provenance   ok enrichments need source_urls and confidence >= that source's accept threshold
               (read from the enricher modules); contacts need source + confidence in [0, 1];
               LLM contacts need evidence in the llm_extract result. Any miss: fail.
  tagging      Every lead tagged, tag rows complete, segment allowed, priority 0-100, exactly one
               target_contact tag: fail on any miss. Tags older than the lead's newest fact:
               warn up to 10% (or while an enrich/scrape run is in flight), fail above.
  audit        Every enrichment / contact / tag set has an audit event with a run id of the
               right kind: fail. Run ids no longer in scrape_runs (pruned): warn.
  signals      county_fips on >= 99% of leads (warn >= 95%); a storm-history summary for every
               lead county (fail), <= 60 d old (warn); newest NWS fetch <= 24 h (warn); news (info).
  coverage     info, warn below floors: website >= 40%, identified decision-maker >= 25%.
  consistency  warn: sources disagreeing on website domain; phone conflicts on > 20% of leads with
               a source phone; template / placeholder contact names; one registry record matched
               to several leads.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import func, select
from sqlalchemy.engine import Engine

from .config import Settings, get_settings
from .db.repository import GAF, REP_SOURCE, as_utc, company_label, enrichment_row, gaf_id_column, lead_row
from .db.schema import (
    accounts,
    audit_events,
    companies,
    company_source_ids,
    contacts,
    enrichments,
    jobs,
    regional_signals,
    reviews,
    scrape_runs,
    search_hits,
)
from .enrich.matching import name_similarity, phone_digits

PASS, WARN, FAIL, INFO = "pass", "warn", "fail", "info"
SEVERITY = {INFO: 0, PASS: 0, WARN: 1, FAIL: 2}
GROUPS = ("integrity", "runs", "freshness", "provenance", "tagging", "audit", "signals", "coverage", "consistency")

# ------------------------------------------------------------------------------------ thresholds
MAX_EXAMPLES = 5
RADIUS_TOLERANCE_MI = 0.5
COORDS_PASS, COORDS_WARN = 0.99, 0.95
# field -> (pass at, warn at); below warn -> fail
REQUIRED_FIELDS = {"name": (1.0, 1.0), "tier": (1.0, 1.0), "address": (0.98, 0.90), "phone": (0.98, 0.90)}
DUPLICATE_NAME_SIM = 0.9
STUCK_HOURS = 2.0
SIGNALS_PASS_HOURS, SIGNALS_WARN_HOURS = 24.0, 24.0 * 7
FRESH_PASS, FRESH_WARN = 0.95, 0.50
ERROR_WARN, ERROR_FAIL = 0.10, 0.30
STALE_TAG_WARN = 0.10
COUNTY_PASS, COUNTY_WARN = 0.99, 0.95
STORM_MAX_AGE_DAYS = 60
NWS_MAX_AGE_HOURS = 24.0
# Calibrated on the 424 leads around 10013 (Oct 2026: 48% website, 30% identified decision-maker).
COVERAGE_FLOORS = {"website": 0.40, "decision_maker_identified": 0.25}
PHONE_CONFLICT_WARN = 0.20
RELATED_COMPANY_NAME_SIM = 0.85
ALLOWED_SEGMENTS = ("strategic", "growth", "emerging", "long_tail")
# Theme / demo-content names that website templates and UI kits ship with.
from .enrich.website_crawl import PLACEHOLDER_NAMES  # noqa: E402
SCRAPED_CONTACT_SOURCES = {"website", "llm_extract"}  # registry filings are real people by construction
# Independent sources that can name a company website / phone (derived ones copy website_discovery).
WEBSITE_SOURCES = ("google_places", "osm", "bbb", "website_discovery")
PHONE_FIELDS = {"google_places": ("phone",), "osm": ("phone",), "bbb": ("phone",),
                "nyc_dcwp": ("contact_phone",), "fmcsa": ("phone", "cell_phone")}
# Registry record ids: the same record matched to two leads means one match is wrong.
RECORD_KEYS = {"fmcsa": "dot_number", "ny_dos": "dos_id", "nyc_dcwp": "license_number", "bbb": "bbb_id",
               "google_places": "place_id", "osm": "osm_id"}
AUDIT_RUN_KINDS = {"enrichment": {"enrich"}, "contact": {"enrich"}, "tags": {"tag"}}
IN_FLIGHT_KINDS = {"enrich", "gaf_ingest"}
CHUNK = 500


def accept_thresholds() -> dict[str, float]:
    """Each source's minimum confidence for an `ok` result, read from the enricher modules."""
    out: dict[str, float] = {}
    try:
        from .enrich import website_discovery

        site = float(website_discovery.ACCEPT_SCORE)
        out["website_discovery"] = site
        # Derived sources take the discovery match's confidence or a fixed default (crawl/LLM 0.6, signals 0.8).
        out["website_crawl"] = min(site, 0.6)
        out["llm_extract"] = min(site, 0.6)
        out["web_signals"] = min(site, 0.8)
    except Exception:  # pragma: no cover - optional dependency missing
        pass
    table: dict[str, Callable[[], float]] = {}

    def _gp() -> float:
        from .enrich import google_places
        return google_places.MIN_CONFIDENCE

    def _osm() -> float:
        # No single constant: a name-only match needs NAME_THRESHOLD similarity and loses 0.1 when the
        # strict name disagrees; a phone match is never below 0.7.
        from .enrich import osm
        from .enrich.matching import match_confidence
        return round(match_confidence(name_sim=osm.NAME_THRESHOLD) - 0.1, 3)

    def _dos() -> float:
        from .enrich import ny_dos
        return ny_dos.ACCEPT

    def _dcwp() -> float:
        from .enrich import nyc_dcwp
        return nyc_dcwp.ACCEPT

    def _fmcsa() -> float:
        from .enrich import fmcsa
        return fmcsa.MIN_CONFIDENCE

    def _bbb() -> float:
        from .enrich import bbb
        return bbb.ACCEPT

    table.update(google_places=_gp, osm=_osm, ny_dos=_dos, nyc_dcwp=_dcwp, fmcsa=_fmcsa, bbb=_bbb)
    for name, get in table.items():
        try:
            out[name] = float(get())
        except Exception:  # pragma: no cover - a broken optional enricher must not break validation
            continue
    return out


# -------------------------------------------------------------------------------------- helpers
def _check(cid: str, status: str, value: Any = None, threshold: Any = None, detail: str = "",
           examples: Iterable[Any] = ()) -> dict[str, Any]:
    return {"id": cid, "group": cid.split(".", 1)[0], "status": status, "value": value, "threshold": threshold,
            "detail": detail, "examples": list(examples)[:MAX_EXAMPLES]}


def _rate_status(rate: float, pass_at: float, warn_at: float) -> str:
    if rate >= pass_at - 1e-12:
        return PASS
    return WARN if rate >= warn_at - 1e-12 else FAIL


def _worst(statuses: Iterable[str]) -> str:
    out = PASS
    for s in statuses:
        if SEVERITY[s] > SEVERITY[out]:
            out = s
    return out


def _pct(n: int, d: int) -> float:
    return round(n / d, 4) if d else 0.0


def _fmt_pct(r: float) -> str:
    return f"{100 * r:.1f}%"


def _hours(delta: timedelta) -> float:
    return round(delta.total_seconds() / 3600, 2)


def _host(url: str | None) -> str | None:
    """Bare host of a company website; None for directories / social pages / junk."""
    if not url or not isinstance(url, str):
        return None
    from .enrich.website_discovery import DIRECTORY_DOMAINS, bare_host, host_matches

    u = url if "//" in url else f"http://{url}"
    try:
        h = bare_host(urlsplit(u).hostname or "")
    except ValueError:
        return None
    if not h or "." not in h or host_matches(h, DIRECTORY_DOMAINS):
        return None
    return h


def _same_site(a: str, b: str) -> bool:
    return a == b or a.endswith("." + b) or b.endswith("." + a)


def _person_key(name: str | None) -> str:
    s = re.sub(r"[^\w\s]", " ", (name or "").lower())
    return " ".join(s.split())


def _lead_label(lead: dict[str, Any]) -> str:
    return company_label(lead)


# -------------------------------------------------------------------------------------- context
@dataclass
class Ctx:
    """Everything the checks read, loaded once (area-scoped where the guarantee is per lead)."""

    engine: Engine
    settings: Settings
    now: datetime
    postal_code: str | None
    radius_miles: float | None
    run_id: int | None  # newest search run of the area
    leads: dict[str, dict[str, Any]] = field(default_factory=dict)  # by company_id
    hits: dict[str, dict[str, Any]] = field(default_factory=dict)
    enr: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    contacts: list[dict[str, Any]] = field(default_factory=list)
    runs: dict[int, dict[str, Any]] = field(default_factory=dict)
    audit: list[dict[str, Any]] = field(default_factory=list)

    def label(self, company_id: str) -> str:
        lead = self.leads.get(company_id)
        return _lead_label(lead) if lead else str(company_id)

    def runs_of(self, kind: str) -> list[dict[str, Any]]:
        return sorted((r for r in self.runs.values() if r["kind"] == kind), key=lambda r: r["id"])

    def in_flight(self) -> list[dict[str, Any]]:
        cutoff = self.now - timedelta(hours=STUCK_HOURS)
        return [r for r in self.runs.values() if r["status"] == "running" and r["kind"] in IN_FLIGHT_KINDS
                and as_utc(r["started_at"]) >= cutoff]


def _chunked(conn, build: Callable[[Sequence[str]], Any], ids: Sequence[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i in range(0, len(ids), CHUNK):
        out += [dict(r._mapping) for r in conn.execute(build(ids[i : i + CHUNK]))]
    return out


def resolve_area(engine: Engine, postal_code: str | None, radius_miles: float | None) -> tuple[str | None, float | None, int | None]:
    """(postal_code, radius, newest search run id). Missing parts come from the newest matching search run."""
    q = select(search_hits.c.postal_code, search_hits.c.radius_miles, func.max(search_hits.c.run_id).label("run_id"))
    if postal_code:
        q = q.where(search_hits.c.postal_code == postal_code)
    if radius_miles is not None:
        q = q.where(search_hits.c.radius_miles == float(radius_miles))
    q = q.group_by(search_hits.c.postal_code, search_hits.c.radius_miles).order_by(func.max(search_hits.c.run_id).desc())
    with engine.connect() as conn:
        row = conn.execute(q.limit(1)).first()
    if row is None:
        return postal_code, (float(radius_miles) if radius_miles is not None else None), None
    return row.postal_code, float(row.radius_miles), int(row.run_id)


LEAD_COLUMNS = ("id", "business_name", "legal_name", "dba", "address", "street", "city", "state", "postal_code",
                "phone", "tier", "latitude", "longitude", "website_url", "website_source", "system_tags", "segment",
                "priority_score", "tagged_at", "county_fips", "profile_scraped_at", "profile_error",
                "listing_updated_at")


def load_context(engine: Engine, postal_code: str | None = None, radius_miles: float | None = None, *,
                 settings: Settings | None = None, now: datetime | None = None) -> Ctx:
    pc, radius, run_id = resolve_area(engine, postal_code, radius_miles)
    ctx = Ctx(engine=engine, settings=settings or get_settings(), now=as_utc(now) or datetime.now(timezone.utc),
              postal_code=pc, radius_miles=radius, run_id=run_id)
    with engine.connect() as conn:
        ctx.runs = {int(r.id): dict(r._mapping) for r in conn.execute(select(scrape_runs))}
        if run_id is None:
            return ctx
        ctx.hits = {r.company_id: dict(r._mapping) for r in conn.execute(
            select(search_hits.c.company_id, search_hits.c.distance_miles, search_hits.c.radius_miles, search_hits.c.rank)
            .where(search_hits.c.run_id == run_id))}
        ids = sorted(ctx.hits)
        cols = [companies.c[c] for c in LEAD_COLUMNS] + [gaf_id_column()]
        for i in range(0, len(ids), CHUNK):
            for r in conn.execute(select(*cols).where(companies.c.id.in_(ids[i : i + CHUNK]))):
                lead = lead_row(r)
                ctx.leads[lead["company_id"]] = lead
        for i in range(0, len(ids), CHUNK):
            for r in conn.execute(select(enrichments).where(enrichments.c.company_id.in_(ids[i : i + CHUNK]))):
                ctx.enr.setdefault(r.company_id, {})[r.source] = enrichment_row(r)
        # scraped contacts only: the people reps add (source 'rep') carry no source_url or audit trail
        ctx.contacts = _chunked(conn, lambda p: select(contacts).where(
            contacts.c.company_id.in_(p), contacts.c.source != REP_SOURCE), ids)
        ctx.audit = _chunked(conn, lambda p: select(
            audit_events.c.entity_type, audit_events.c.entity_id, audit_events.c.company_id, audit_events.c.run_id,
            audit_events.c.action).where(audit_events.c.company_id.in_(p),
                                         audit_events.c.entity_type.in_(["enrichment", "contact", "tags", "company"])),
            ids)
    return ctx


def _no_leads(group: str, ctx: Ctx) -> list[dict[str, Any]]:
    return [_check(f"{group}.skipped", INFO, 0, None, f"no leads for area {ctx.postal_code}@{ctx.radius_miles}mi")]


# ------------------------------------------------------------------------------------ integrity
def check_integrity(ctx: Ctx) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    sid = company_source_ids.c
    with ctx.engine.connect() as conn:
        norm = func.lower(func.trim(sid.external_id))
        dup_ids = [f"gaf_id {r[0]}" for r in conn.execute(
            select(norm).where(sid.source == GAF).group_by(norm).having(func.count() > 1))]
        dup_ids += [f"company {r[0]} has {r[1]} GAF ids" for r in conn.execute(
            select(sid.company_id, func.count()).where(sid.source == GAF).group_by(sid.company_id)
            .having(func.count() > 1))]
        dup_hits = [f"run {r[0]}: {r[1]}" for r in conn.execute(
            select(search_hits.c.run_id, search_hits.c.company_id).group_by(search_hits.c.run_id, search_hits.c.company_id)
            .having(func.count() > 1))]
        n_companies = conn.execute(select(func.count()).select_from(companies)).scalar() or 0
        orphans: dict[str, int] = {}
        orphan_examples: list[str] = []
        known = select(companies.c.id)
        for name, table in (("enrichments", enrichments), ("contacts", contacts), ("reviews", reviews),
                            ("search_hits", search_hits), ("company_source_ids", company_source_ids)):
            rows = conn.execute(select(table.c.company_id).where(table.c.company_id.not_in(known))).scalars().all()
            orphans[name] = len(rows)
            orphan_examples += [f"{name}: {g}" for g in rows[:2]]
        rows = conn.execute(select(companies.c.id, companies.c.business_name).where(
            companies.c.id.not_in(select(sid.company_id)))).all()
        orphans["companies_without_source_id"] = len(rows)
        orphan_examples += [f"company {r.id} {r.business_name}: no source id" for r in rows[:2]]
        rows = conn.execute(select(accounts.c.account_id, accounts.c.company_id).where(
            accounts.c.company_id.is_not(None), accounts.c.company_id.not_in(known))).all()
        orphans["accounts"] = len(rows)
        orphan_examples += [f"accounts: {r.account_id}->{r.company_id}" for r in rows[:2]]
        rows = conn.execute(select(search_hits.c.run_id).where(
            search_hits.c.run_id.not_in(select(scrape_runs.c.id))).distinct()).scalars().all()
        orphans["search_hits_run"] = len(rows)
        orphan_examples += [f"search_hits run {r} missing" for r in rows[:2]]

    out.append(_check("integrity.unique_gaf_id", FAIL if dup_ids or dup_hits else PASS,
                      len(dup_ids) + len(dup_hits), "0 duplicates",
                      f"{n_companies} companies; {len(dup_ids)} duplicate GAF ids, {len(dup_hits)} duplicate hits in a run",
                      dup_ids + dup_hits))
    n_orphans = sum(orphans.values())
    out.append(_check("integrity.orphans", FAIL if n_orphans else PASS, orphans, "0 per table",
                      f"{n_orphans} rows point at a missing company or run, or lack a source id" if n_orphans
                      else "no orphan rows", orphan_examples))
    if ctx.run_id is None:
        out.append(_check("integrity.area_run", FAIL, None, "a search run with >= 1 hit",
                          f"no search run for area {ctx.postal_code}@{ctx.radius_miles}mi"))
        return out
    n = len(ctx.hits)
    out.append(_check("integrity.area_run", PASS if n else FAIL, {"run_id": ctx.run_id, "leads": n},
                      "a search run with >= 1 hit", f"run {ctx.run_id}: {n} leads in {ctx.postal_code}@{ctx.radius_miles}mi"))

    limit = (ctx.radius_miles or 0) + RADIUS_TOLERANCE_MI
    far = [(g, h["distance_miles"]) for g, h in ctx.hits.items() if h["distance_miles"] is not None and h["distance_miles"] > limit]
    nodist = [g for g, h in ctx.hits.items() if h["distance_miles"] is None]
    missing = [g for g in ctx.hits if g not in ctx.leads]
    status = FAIL if far or missing else WARN if nodist else PASS
    maxd = max((h["distance_miles"] for h in ctx.hits.values() if h["distance_miles"] is not None), default=None)
    out.append(_check("integrity.hit_distance", status, {"max_miles": maxd, "beyond": len(far), "no_distance": len(nodist)},
                      f"<= {limit:g} mi (radius + {RADIUS_TOLERANCE_MI} tolerance)",
                      f"{len(far)} beyond radius, {len(nodist)} without a distance, {len(missing)} hits without a company",
                      [f"{ctx.label(g)} at {d:.2f} mi" for g, d in far] + [f"{ctx.label(g)} no distance" for g in nodist]
                      + missing))

    leads = list(ctx.leads.values())
    bad = [l for l in leads if l.get("latitude") is None or l.get("longitude") is None
           or not (-90 <= l["latitude"] <= 90) or not (-180 <= l["longitude"] <= 180)]
    rate = _pct(len(leads) - len(bad), len(leads))
    out.append(_check("integrity.coordinates", _rate_status(rate, COORDS_PASS, COORDS_WARN), rate,
                      f"pass >= {_fmt_pct(COORDS_PASS)}, warn >= {_fmt_pct(COORDS_WARN)}",
                      f"{len(leads) - len(bad)}/{len(leads)} leads have valid lat/lng", [_lead_label(l) for l in bad]))

    rates: dict[str, float] = {}
    statuses: list[str] = []
    examples: list[str] = []
    for f, (pass_at, warn_at) in REQUIRED_FIELDS.items():
        empty = [l for l in leads if not str(l.get(f) or "").strip()]
        rates[f] = _pct(len(leads) - len(empty), len(leads))
        statuses.append(_rate_status(rates[f], pass_at, warn_at))
        examples += [f"{_lead_label(l)}: no {f}" for l in empty[:2]]
    out.append(_check("integrity.required_fields", _worst(statuses), rates,
                      {f: f"pass >= {_fmt_pct(p)}, warn >= {_fmt_pct(w)}" for f, (p, w) in REQUIRED_FIELDS.items()},
                      ", ".join(f"{f} {_fmt_pct(r)}" for f, r in rates.items()), examples))

    by_phone: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for l in leads:
        if (p := phone_digits(l.get("phone"))):
            by_phone[p].append(l)
    dups = []
    for p, group in by_phone.items():
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                if name_similarity(a.get("name"), b.get("name")) >= DUPLICATE_NAME_SIM:
                    dups.append(f"{_lead_label(a)} / {_lead_label(b)} share {p}")
    out.append(_check("integrity.duplicate_listings", WARN if dups else PASS, len(dups),
                      f"0 pairs with same phone and name similarity >= {DUPLICATE_NAME_SIM}",
                      f"{len(dups)} possible duplicate listings under different GAF ids", dups))
    return out


# ----------------------------------------------------------------------------------- run health
def _area_params_match(params: dict[str, Any] | None, ctx: Ctx) -> bool:
    p = params or {}
    try:
        return str(p.get("postal_code")) == str(ctx.postal_code) and float(p.get("radius_miles")) == float(ctx.radius_miles)
    except (TypeError, ValueError):
        return False


def check_runs(ctx: Ctx) -> list[dict[str, Any]]:
    from .pipeline.scrape import _complete_count

    out: list[dict[str, Any]] = []
    scrapes = [r for r in ctx.runs_of("gaf_ingest") if _area_params_match(r["params"], ctx)]
    if not scrapes and ctx.run_id in ctx.runs:
        scrapes = [ctx.runs[ctx.run_id]]
    finished = [r for r in scrapes if r["status"] != "running"]
    running = [r for r in scrapes if r["status"] == "running"]
    if not finished:
        out.append(_check("runs.latest_scrape_complete", FAIL, None, "complete read (results == reported total)",
                          f"no finished scrape run for {ctx.postal_code}@{ctx.radius_miles}mi"))
    else:
        last = finished[-1]
        stats = last.get("stats") or {}
        count = _complete_count(stats)
        verdict = stats.get("completeness") if isinstance(stats.get("completeness"), dict) else {}
        n, total = verdict.get("results", stats.get("results")), verdict.get("total", stats.get("coveo_total"))
        # Same rule as the scrape guard's baseline (previous_complete_read): the read verdict decides.
        # run_scrape already downgrades a failed run's verdict to run_failed when its hits were not
        # stored; a failure after a complete, stored read is reported by runs.latest_by_kind.
        ok = count is not None
        detail = (f"run {last['id']} ({last['status']}): read {n} of {total}"
                  + ("" if ok else f"; {verdict.get('reason') or 'incomplete'}: {verdict.get('message') or ''}".rstrip(": "))
                  + ("; the run failed after a complete read" if ok and last["status"] == "failed" else "")
                  + (f"; run {running[-1]['id']} still running" if running else ""))
        out.append(_check("runs.latest_scrape_complete", PASS if ok else FAIL, {"run_id": last["id"], "results": n, "total": total},
                          "complete read (results == reported total)", detail))

    cutoff = ctx.now - timedelta(hours=STUCK_HOURS)
    stuck = [f"run {r['id']} {r['kind']} since {as_utc(r['started_at']):%Y-%m-%d %H:%M}Z"
             for r in ctx.runs.values() if r["status"] == "running" and as_utc(r["started_at"]) < cutoff]
    with ctx.engine.connect() as conn:
        stuck_jobs = conn.execute(select(jobs.c.id, jobs.c.kind, jobs.c.locked_at).where(
            jobs.c.status == "running", jobs.c.locked_at < cutoff)).all()
        dead = conn.execute(select(jobs.c.id, jobs.c.kind, jobs.c.error).where(jobs.c.status == "dead")
                            .order_by(jobs.c.id.desc())).all()
    stuck += [f"job {j.id} {j.kind} locked since {as_utc(j.locked_at):%Y-%m-%d %H:%M}Z" for j in stuck_jobs]
    live = [r for r in ctx.runs.values() if r["status"] == "running" and as_utc(r["started_at"]) >= cutoff]
    out.append(_check("runs.stuck", WARN if stuck else PASS, len(stuck), f"0 running > {STUCK_HOURS:g} h",
                      f"{len(stuck)} stuck; {len(live)} running for under {STUCK_HOURS:g} h"
                      + (f" ({', '.join(str(r['id']) + ' ' + r['kind'] for r in live)})" if live else ""), stuck))
    out.append(_check("runs.dead_jobs", WARN if dead else PASS, len(dead), "0 dead jobs",
                      f"{len(dead)} jobs exhausted their retries" if dead else "no dead jobs",
                      [f"job {j.id} {j.kind}: {(j.error or '')[:80]}" for j in dead]))

    latest: dict[str, dict[str, Any]] = {}
    for r in sorted(ctx.runs.values(), key=lambda r: r["id"]):
        if r["status"] != "running":
            latest[r["kind"]] = r
    failed = [f"{k}: run {r['id']} failed ({(r.get('error') or '')[:80]})" for k, r in latest.items() if r["status"] == "failed"]
    out.append(_check("runs.latest_by_kind", WARN if failed else INFO,
                      {k: f"{r['id']} {r['status']}" for k, r in sorted(latest.items())}, "latest finished run of each kind not failed",
                      "; ".join(failed) if failed else "no failed latest runs", failed))

    sig = [r for r in ctx.runs_of("signals") if r["status"] in ("succeeded", "partial") and r.get("finished_at")]
    if not sig:
        out.append(_check("runs.signals_age", FAIL, None, f"pass <= {SIGNALS_PASS_HOURS:g} h, warn <= {SIGNALS_WARN_HOURS:g} h",
                          "no finished signals run (`leadmaker signals`)"))
    else:
        last = sig[-1]
        age = _hours(ctx.now - as_utc(last["finished_at"]))
        status = PASS if age <= SIGNALS_PASS_HOURS else WARN if age <= SIGNALS_WARN_HOURS else FAIL
        errs = (last.get("stats") or {}).get("errors") or {}
        if last["status"] == "partial":
            status = _worst([status, WARN])
        out.append(_check("runs.signals_age", status, age, f"pass <= {SIGNALS_PASS_HOURS:g} h, warn <= {SIGNALS_WARN_HOURS:g} h",
                          f"run {last['id']} {last['status']} {age:g} h ago" + (f"; errors: {', '.join(errs)}" if errs else ""),
                          [f"{k}: {str(v)[:100]}" for k, v in errs.items()]))
    return out


# ------------------------------------------------------------------------------------ freshness
def _source_rows(ctx: Ctx) -> dict[str, list[dict[str, Any]]]:
    by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for g in ctx.leads:
        for src, row in ctx.enr.get(g, {}).items():
            by_source[src].append(row)
    return dict(sorted(by_source.items()))


def check_freshness(ctx: Ctx) -> list[dict[str, Any]]:
    if not ctx.leads:
        return _no_leads("freshness", ctx)
    out: list[dict[str, Any]] = []
    leads = list(ctx.leads.values())
    pcut = ctx.now - timedelta(hours=ctx.settings.profile_ttl_hours)
    stale = [l for l in leads if l.get("profile_scraped_at") is None or as_utc(l["profile_scraped_at"]) < pcut]
    errored = [l for l in leads if l.get("profile_error")]
    rate = _pct(len(leads) - len(stale), len(leads))
    status = _rate_status(rate, FRESH_PASS, FRESH_WARN)
    if errored:
        status = _worst([status, WARN])
    out.append(_check("freshness.profiles", status, rate,
                      f"within {ctx.settings.profile_ttl_hours:g} h TTL: pass >= {_fmt_pct(FRESH_PASS)}, warn >= {_fmt_pct(FRESH_WARN)}",
                      f"{len(leads) - len(stale)}/{len(leads)} profiles fresh; {len(errored)} with a profile_error",
                      [f"{_lead_label(l)}: stale" for l in stale[:3]] + [f"{_lead_label(l)}: {l['profile_error'][:80]}" for l in errored]))

    rows = _source_rows(ctx)
    ecut = ctx.now - timedelta(hours=ctx.settings.enrichment_ttl_hours)
    ttl_rates: dict[str, float] = {}
    statuses: list[str] = []
    examples: list[str] = []
    for src, rs in rows.items():
        old = [r for r in rs if as_utc(r["fetched_at"]) < ecut]
        ttl_rates[src] = _pct(len(rs) - len(old), len(rs))
        st = _rate_status(ttl_rates[src], FRESH_PASS, FRESH_WARN)
        statuses.append(st)
        if st != PASS:
            examples.append(f"{src}: {len(old)}/{len(rs)} older than TTL")
    out.append(_check("freshness.enrichment_ttl", _worst(statuses) if statuses else INFO, ttl_rates,
                      f"within {ctx.settings.enrichment_ttl_hours:g} h TTL: pass >= {_fmt_pct(FRESH_PASS)}, warn >= {_fmt_pct(FRESH_WARN)}",
                      "; ".join(examples) or (f"{len(rows)} sources all fresh" if rows else "no enrichment rows"), examples))

    missing = {src: len(ctx.leads) - len(rs) for src, rs in rows.items() if len(rs) < len(ctx.leads)}
    out.append(_check("freshness.enrichment_missing", WARN if missing else PASS, missing, "every lead has a row for each source run",
                      ("; ".join(f"{s}: {n} leads without a row" for s, n in missing.items())
                       + (" (enrich run in progress)" if ctx.in_flight() else "")) if missing else "every source covers every lead",
                      [f"{s}: {n}" for s, n in missing.items()]))

    err_rates: dict[str, float] = {}
    statuses = []
    examples = []
    detail = []
    for src, rs in rows.items():
        live = [r for r in rs if r["status"] != "skipped"]
        errs = [r for r in live if r["status"] == "error"]
        if not live:
            continue
        err_rates[src] = _pct(len(errs), len(live))
        st = FAIL if err_rates[src] > ERROR_FAIL else WARN if err_rates[src] > ERROR_WARN else PASS
        statuses.append(st)
        if st != PASS:
            detail.append(f"{src} {_fmt_pct(err_rates[src])} ({len(errs)}/{len(live)})")
            examples += [f"{src} {ctx.label(r['company_id'])}: {(r.get('error') or '')[:80]}" for r in errs[:2]]
    out.append(_check("freshness.error_rate", _worst(statuses) if statuses else INFO, err_rates,
                      f"errors / non-skipped rows: warn > {_fmt_pct(ERROR_WARN)}, fail > {_fmt_pct(ERROR_FAIL)}",
                      "; ".join(detail) or "all sources under the warn rate", examples))
    return out


# ----------------------------------------------------------------------------------- provenance
def check_provenance(ctx: Ctx) -> list[dict[str, Any]]:
    if not ctx.leads:
        return _no_leads("provenance", ctx)
    out: list[dict[str, Any]] = []
    rows = _source_rows(ctx)
    ok_rows = [r for rs in rows.values() for r in rs if r["status"] == "ok"]
    no_urls = [r for r in ok_rows if not r.get("source_urls")]
    out.append(_check("provenance.source_urls", FAIL if no_urls else PASS, len(no_urls), "0 ok enrichments without source_urls",
                      f"{len(ok_rows) - len(no_urls)}/{len(ok_rows)} ok enrichments cite their source URLs",
                      [f"{ctx.label(r['company_id'])}:{r['source']}" for r in no_urls]))

    floors = accept_thresholds()
    below: list[dict[str, Any]] = []
    mins: dict[str, float] = {}
    for r in ok_rows:
        conf = r.get("confidence")
        src = r["source"]
        if conf is not None:
            mins[src] = min(mins.get(src, 1.0), float(conf))
        floor = floors.get(src, 0.0)
        if conf is None or not (0.0 < float(conf) <= 1.0) or float(conf) < floor - 1e-9:
            below.append(r)
    out.append(_check("provenance.match_confidence", FAIL if below else PASS, {s: round(v, 3) for s, v in sorted(mins.items())},
                      {s: floors.get(s, "(0, 1]") for s in sorted(mins)},
                      f"{len(below)} ok enrichments below their source's accept threshold" if below
                      else "every ok enrichment is at or above its source's accept threshold",
                      [f"{ctx.label(r['company_id'])}:{r['source']} {r.get('confidence')} < {floors.get(r['source'], 0)}"
                       for r in below]))

    bad = [c for c in ctx.contacts if not str(c.get("source") or "").strip() or c.get("confidence") is None
           or not (0.0 <= float(c["confidence"]) <= 1.0)]
    no_url = [c for c in ctx.contacts if not c.get("source_url")]
    status = FAIL if bad else WARN if no_url else PASS
    out.append(_check("provenance.contacts", status, {"contacts": len(ctx.contacts), "invalid": len(bad), "no_source_url": len(no_url)},
                      "source + confidence in [0, 1] (fail); source_url (warn)",
                      f"{len(bad)} contacts without source/confidence, {len(no_url)} without a source_url",
                      [f"{ctx.label(c['company_id'])}: {c['name']} ({c.get('source')!r}, {c.get('confidence')})" for c in bad]
                      + [f"{ctx.label(c['company_id'])}: {c['name']}: no source_url" for c in no_url]))

    llm = [c for c in ctx.contacts if c.get("source") == "llm_extract"]
    unsupported = []
    for c in llm:
        row = ctx.enr.get(c["company_id"], {}).get("llm_extract") or {}
        dms = (row.get("data") or {}).get("decision_makers") or [] if row.get("status") == "ok" else []
        key = _person_key(c["name"])
        if not any(_person_key(d.get("name")) == key and str(d.get("evidence") or "").strip() for d in dms if isinstance(d, dict)):
            unsupported.append(c)
    out.append(_check("provenance.llm_evidence", FAIL if unsupported else PASS, {"llm_contacts": len(llm), "without_evidence": len(unsupported)},
                      "every llm_extract contact has evidence in its llm_extract result",
                      f"{len(llm) - len(unsupported)}/{len(llm)} LLM contacts carry evidence" if llm else "no LLM contacts",
                      [f"{ctx.label(c['company_id'])}: {c['name']}" for c in unsupported]))
    return out


# -------------------------------------------------------------------------------------- tagging
def _newest_fact(ctx: Ctx, lead: dict[str, Any]) -> tuple[datetime | None, str]:
    cands: list[tuple[datetime, str]] = []
    for src, r in ctx.enr.get(lead["company_id"], {}).items():
        if r.get("fetched_at") is not None:
            cands.append((as_utc(r["fetched_at"]), f"enrichment {src}"))
    for k in ("profile_scraped_at", "listing_updated_at"):
        if lead.get(k) is not None:
            cands.append((as_utc(lead[k]), k))
    return max(cands) if cands else (None, "")


def check_tagging(ctx: Ctx) -> list[dict[str, Any]]:
    if not ctx.leads:
        return _no_leads("tagging", ctx)
    out: list[dict[str, Any]] = []
    leads = list(ctx.leads.values())
    untagged = [l for l in leads if l.get("tagged_at") is None]
    out.append(_check("tagging.untagged", FAIL if untagged else PASS, len(untagged), "0 untagged leads",
                      f"{len(leads) - len(untagged)}/{len(leads)} leads tagged", [_lead_label(l) for l in untagged]))
    tagged = [l for l in leads if l.get("tagged_at") is not None]

    stale = []
    for l in tagged:
        newest, what = _newest_fact(ctx, l)
        if newest is not None and as_utc(l["tagged_at"]) < newest:
            stale.append((l, what, newest))
    rate = _pct(len(stale), len(tagged))
    flight = ctx.in_flight()
    status = PASS if not stale else WARN if rate <= STALE_TAG_WARN or flight else FAIL
    out.append(_check("tagging.stale", status, rate,
                      f"tagged_at >= newest enrichment/profile/listing time; warn <= {_fmt_pct(STALE_TAG_WARN)} or while a run is in flight",
                      f"{len(stale)}/{len(tagged)} leads tagged before their newest fact"
                      + (f"; run {', '.join(str(r['id']) for r in flight)} in progress, re-tag after it finishes" if stale and flight else "")
                      + ("; run `leadmaker tag`" if stale and not flight else ""),
                      [f"{_lead_label(l)}: tagged {as_utc(l['tagged_at']):%m-%d %H:%M} < {what} {t:%m-%d %H:%M}" for l, what, t in stale]))

    bad_tags: list[str] = []
    dup_keys: list[str] = []
    for l in tagged:
        tags = l.get("tags") or []
        if not isinstance(tags, list):
            bad_tags.append(f"{_lead_label(l)}: tags is {type(tags).__name__}")
            continue
        keys = Counter()
        for t in tags:
            if not isinstance(t, dict):
                bad_tags.append(f"{_lead_label(l)}: non-object tag")
                continue
            keys[t.get("key")] += 1
            missing = [k for k in ("key", "reason", "source") if not str(t.get(k) or "").strip()]
            if missing:
                bad_tags.append(f"{_lead_label(l)}:{t.get('key')} missing {','.join(missing)}")
        dup_keys += [f"{_lead_label(l)}:{k} x{n}" for k, n in keys.items() if n > 1 and k != "target_contact"]
    problems = bad_tags + dup_keys
    out.append(_check("tagging.tag_fields", FAIL if problems else PASS, {"incomplete": len(bad_tags), "duplicate_keys": len(dup_keys)},
                      "every tag has key, reason, source; one tag per key",
                      f"{len(bad_tags)} tags missing key/reason/source, {len(dup_keys)} duplicate keys", problems))

    bad_seg = [l for l in tagged if l.get("segment") not in ALLOWED_SEGMENTS]
    out.append(_check("tagging.segment", FAIL if bad_seg else PASS, dict(Counter(l.get("segment") for l in tagged)),
                      list(ALLOWED_SEGMENTS), f"{len(bad_seg)} leads with a segment outside the allowed set",
                      [f"{_lead_label(l)}: {l.get('segment')!r}" for l in bad_seg]))

    bad_pri = [l for l in tagged if l.get("priority_score") is None or not (0 <= float(l["priority_score"]) <= 100)]
    pri = [float(l["priority_score"]) for l in tagged if l.get("priority_score") is not None]
    out.append(_check("tagging.priority", FAIL if bad_pri else PASS,
                      {"min": min(pri, default=None), "max": max(pri, default=None)}, "0 <= priority_score <= 100",
                      f"{len(bad_pri)} leads with a missing or out-of-range priority",
                      [f"{_lead_label(l)}: {l.get('priority_score')}" for l in bad_pri]))

    wrong = []
    for l in tagged:
        n = sum(1 for t in l.get("tags") or [] if isinstance(t, dict) and t.get("key") == "target_contact")
        if n != 1:
            wrong.append((l, n))
    none = sum(1 for _, n in wrong if n == 0)
    out.append(_check("tagging.target_contact", FAIL if wrong else PASS, f"{len(tagged) - len(wrong)}/{len(tagged)}",
                      "exactly 1 target_contact tag per lead",
                      (f"{none} leads have no target_contact tag, {len(wrong) - none} have several"
                       + ("; re-run `leadmaker tag`" if none else "")) if wrong else "every lead has one target contact",
                      [f"{_lead_label(l)}: {n}" for l, n in wrong]))
    return out


# ---------------------------------------------------------------------------------------- audit
def check_audit(ctx: Ctx) -> list[dict[str, Any]]:
    if not ctx.leads:
        return _no_leads("audit", ctx)
    out: list[dict[str, Any]] = []
    seen: dict[str, set[str]] = defaultdict(set)
    for e in ctx.audit:
        seen[e["entity_type"]].add(e["entity_id"])

    enr_ids = [f"{g}:{s}" for g in ctx.leads for s in ctx.enr.get(g, {})]
    miss = [i for i in enr_ids if i not in seen["enrichment"]]
    out.append(_check("audit.enrichments", FAIL if miss else PASS, f"{len(enr_ids) - len(miss)}/{len(enr_ids)}",
                      "every enrichment row has an audit event", f"{len(miss)} enrichment rows never logged",
                      [f"{ctx.label(i.split(':', 1)[0])}:{i.split(':', 1)[1]}" for i in miss]))
    # Contacts are logged under their source_key (stable across re-discovery).
    pipeline_contacts = [c for c in ctx.contacts if c.get("source_key")]
    miss = [c for c in pipeline_contacts if c["source_key"] not in seen["contact"]]
    out.append(_check("audit.contacts", FAIL if miss else PASS, f"{len(pipeline_contacts) - len(miss)}/{len(pipeline_contacts)}",
                      "every contact has an audit event", f"{len(miss)} contacts never logged",
                      [f"{ctx.label(c['company_id'])}: {c['name']} ({c['source']})" for c in miss]))
    tagged = [g for g, l in ctx.leads.items() if l.get("tagged_at") is not None]
    miss = [g for g in tagged if g not in seen["tags"]]
    out.append(_check("audit.tags", FAIL if miss else PASS, f"{len(tagged) - len(miss)}/{len(tagged)}",
                      "every tagged lead has a tags audit event", f"{len(miss)} tag sets never logged",
                      [ctx.label(g) for g in miss]))

    null_run, unknown, wrong_kind = [], [], []
    for e in ctx.audit:
        kinds = AUDIT_RUN_KINDS.get(e["entity_type"])
        if kinds is None:
            continue
        rid = e["run_id"]
        if rid is None:
            null_run.append(f"{e['entity_type']} {e['entity_id']}: no run id")
        elif rid not in ctx.runs:
            unknown.append(f"{e['entity_type']} {e['entity_id']}: run {rid} not in scrape_runs")
        elif ctx.runs[rid]["kind"] not in kinds:
            wrong_kind.append(f"{e['entity_type']} {e['entity_id']}: run {rid} is {ctx.runs[rid]['kind']}")
    status = FAIL if null_run or wrong_kind else WARN if unknown else PASS
    out.append(_check("audit.run_ids", status, {"no_run": len(null_run), "unknown_run": len(unknown), "wrong_kind": len(wrong_kind)},
                      "tag/enrichment/contact events carry an existing run id of the matching kind (pruned run: warn)",
                      f"{len(null_run)} without a run id, {len(wrong_kind)} from the wrong kind of run, {len(unknown)} from pruned runs",
                      null_run + wrong_kind + unknown))

    created = {e["entity_id"] for e in ctx.audit if e["entity_type"] == "company" and e["action"] == "created"}
    no_created = [g for g in ctx.leads if g not in created]
    out.append(_check("audit.contractors", INFO if no_created else PASS, f"{len(ctx.leads) - len(no_created)}/{len(ctx.leads)}",
                      "company 'created' event (informational: the log post-dates the first GAF scrape)",
                      f"{len(no_created)} leads were first seen before audit logging existed" if no_created
                      else "every lead has a created event", [ctx.label(g) for g in no_created]))
    return out


# -------------------------------------------------------------------------------------- signals
def check_signals(ctx: Ctx) -> list[dict[str, Any]]:
    if not ctx.leads:
        return _no_leads("signals", ctx)
    from .signals import news, storms, weather

    out: list[dict[str, Any]] = []
    leads = list(ctx.leads.values())
    valid = [l for l in leads if re.fullmatch(r"\d{5}", str(l.get("county_fips") or ""))]
    rate = _pct(len(valid), len(leads))
    out.append(_check("signals.county_coverage", _rate_status(rate, COUNTY_PASS, COUNTY_WARN), rate,
                      f"pass >= {_fmt_pct(COUNTY_PASS)}, warn >= {_fmt_pct(COUNTY_WARN)}",
                      f"{len(valid)}/{len(leads)} leads have a 5-digit county_fips",
                      [_lead_label(l) for l in leads if l not in valid]))

    counties = sorted({l["county_fips"] for l in valid})
    rs = regional_signals.c
    with ctx.engine.connect() as conn:
        storm_rows = {r.county_fips: as_utc(r.fetched_at) for r in conn.execute(
            select(rs.county_fips, rs.fetched_at).where(rs.kind == storms.KIND, rs.source == storms.SOURCE,
                                                        rs.external_id == storms.EXTERNAL_ID))}
        nws_newest = as_utc(conn.execute(select(func.max(rs.fetched_at)).where(rs.source == weather.SOURCE)).scalar())
        news_rows = conn.execute(select(rs.county_fips, func.count()).where(rs.kind == news.KIND).group_by(rs.county_fips)).all()
    missing = [c for c in counties if c not in storm_rows]
    old_cut = ctx.now - timedelta(days=STORM_MAX_AGE_DAYS)
    old = [c for c in counties if c in storm_rows and storm_rows[c] < old_cut]
    status = FAIL if missing else WARN if old else PASS
    out.append(_check("signals.storm_history", status, f"{len(counties) - len(missing)}/{len(counties)}",
                      f"a storm-history summary per lead county (fail), <= {STORM_MAX_AGE_DAYS} d old (warn)",
                      f"{len(missing)} lead counties without storm history, {len(old)} older than {STORM_MAX_AGE_DAYS} d",
                      [f"{c}: missing" for c in missing] + [f"{c}: fetched {storm_rows[c]:%Y-%m-%d}" for c in old]))

    # An alerts fetch that found nothing writes no rows, so a signals run whose alerts step succeeded counts too.
    for r in reversed(ctx.runs_of("signals")):
        stats = r.get("stats") or {}
        if r["status"] in ("succeeded", "partial") and "alerts" in stats and "alerts" not in (stats.get("errors") or {}):
            t = as_utc(r.get("finished_at") or r["started_at"])
            nws_newest = max(nws_newest, t) if nws_newest else t
            break
    if nws_newest is None:
        out.append(_check("signals.nws_freshness", WARN, None, f"newest NWS fetch <= {NWS_MAX_AGE_HOURS:g} h",
                          "no NWS alert fetch recorded"))
    else:
        age = _hours(ctx.now - nws_newest)
        out.append(_check("signals.nws_freshness", PASS if age <= NWS_MAX_AGE_HOURS else WARN, age,
                          f"newest NWS fetch <= {NWS_MAX_AGE_HOURS:g} h", f"newest NWS fetch {age:g} h ago"))

    per_county = {c: n for c, n in news_rows}
    lead_news = {c: per_county[c] for c in counties if c in per_county}
    out.append(_check("signals.news", INFO, {"rows": sum(per_county.values()), "lead_counties_with_news": len(lead_news)},
                      "informational", f"{sum(lead_news.values())} news rows across {len(lead_news)}/{len(counties)} lead counties"))
    return out


# ------------------------------------------------------------------------------------- coverage
def check_coverage(ctx: Ctx) -> list[dict[str, Any]]:
    if not ctx.leads:
        return _no_leads("coverage", ctx)
    out: list[dict[str, Any]] = []
    leads = list(ctx.leads.values())
    with_site = [l for l in leads if l.get("website")]
    rate = _pct(len(with_site), len(leads))
    floor = COVERAGE_FLOORS["website"]
    out.append(_check("coverage.website", INFO if rate >= floor else WARN, rate, f"floor {_fmt_pct(floor)}",
                      f"{len(with_site)}/{len(leads)} leads have a website",
                      [f"{s}: {n}" for s, n in Counter(l.get("website_source") for l in with_site).most_common()]))

    dm = Counter()
    for l in leads:
        tag = next((t for t in l.get("tags") or [] if isinstance(t, dict) and t.get("key") == "decision_maker"), None)
        dm[(tag or {}).get("value") or "untagged"] += 1
    rate = _pct(dm["identified"], len(leads))
    floor = COVERAGE_FLOORS["decision_maker_identified"]
    out.append(_check("coverage.decision_maker", INFO if rate >= floor else WARN, rate, f"floor {_fmt_pct(floor)}",
                      f"{dm['identified']}/{len(leads)} identified; " + ", ".join(f"{k} {n}" for k, n in sorted(dm.items())),
                      [f"{k}: {n}" for k, n in dm.most_common()]))

    rates = {}
    for src, rs in _source_rows(ctx).items():
        live = [r for r in rs if r["status"] != "skipped"]
        ok = sum(1 for r in live if r["status"] == "ok")
        rates[src] = f"{ok}/{len(live)}" + (f" ({_fmt_pct(_pct(ok, len(live)))})" if live else "")
    out.append(_check("coverage.source_ok_rates", INFO, rates, "informational (ok / non-skipped rows)",
                      "; ".join(f"{s} {v}" for s, v in rates.items()) or "no enrichment rows"))
    return out


# ---------------------------------------------------------------------------------- consistency
def check_consistency(ctx: Ctx) -> list[dict[str, Any]]:
    if not ctx.leads:
        return _no_leads("consistency", ctx)
    out: list[dict[str, Any]] = []

    def ok_data(g: str, src: str) -> dict[str, Any] | None:
        r = ctx.enr.get(g, {}).get(src)
        return r if r is not None and r["status"] == "ok" else None

    site_conflicts, compared = [], 0
    hosts_by_lead: dict[str, set[str]] = {}
    for g, lead in ctx.leads.items():
        hosts: dict[str, str] = {}
        for src in WEBSITE_SOURCES:
            r = ok_data(g, src)
            if r is not None and (h := _host(r.get("website") or (r.get("data") or {}).get("website"))):
                hosts[src] = h
        if (h := _host(lead.get("website"))):
            hosts_by_lead[g] = set(hosts.values()) | {h}
        if len(hosts) >= 2:
            compared += 1
            vals = list(hosts.values())
            if any(not _same_site(a, b) for i, a in enumerate(vals) for b in vals[i + 1:]):
                site_conflicts.append(f"{_lead_label(lead)}: " + ", ".join(f"{s}={h}" for s, h in hosts.items()))
    out.append(_check("consistency.website_domain", WARN if site_conflicts else PASS, f"{len(site_conflicts)}/{compared}",
                      "0 leads whose sources name different website domains",
                      f"{len(site_conflicts)} of {compared} leads with 2+ website sources disagree", site_conflicts))

    conflicts, with_phone = [], 0
    for g, lead in ctx.leads.items():
        gp = phone_digits(lead.get("phone"))
        found: dict[str, set[str]] = {}
        for src, keys in PHONE_FIELDS.items():
            r = ok_data(g, src)
            if r is None:
                continue
            ps = {p for k in keys if (p := phone_digits((r.get("data") or {}).get(k)))}
            if ps:
                found[src] = ps
        if not gp or not found:
            continue
        with_phone += 1
        if not any(gp in ps for ps in found.values()):
            conflicts.append(f"{_lead_label(lead)}: GAF {gp} vs " + ", ".join(f"{s}={'/'.join(sorted(p))}" for s, p in found.items()))
    rate = _pct(len(conflicts), with_phone)
    out.append(_check("consistency.phone", WARN if rate > PHONE_CONFLICT_WARN else PASS, rate,
                      f"leads where no source phone matches GAF's: warn > {_fmt_pct(PHONE_CONFLICT_WARN)}",
                      f"{len(conflicts)}/{with_phone} leads with a source phone have none matching the GAF phone", conflicts))

    # Template names: placeholder names anywhere, or one scraped name on several unrelated companies.
    placeholders = [c for c in ctx.contacts if _person_key(c["name"]) in PLACEHOLDER_NAMES]
    by_person: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for c in ctx.contacts:
        by_person[_person_key(c["name"])].append(c)
    suspects, registry_only = [], []
    for key, cs in by_person.items():
        gids = sorted({c["company_id"] for c in cs})
        if len(gids) < 2 or not key:
            continue
        firms = [ctx.leads[g] for g in gids]
        surname = [t for t in key.split() if len(t) >= 4 and t not in {"junior", "senior"}][-1:]
        named_after = bool(surname) and any(surname[0] in _person_key(" ".join(filter(None, (l.get("name"), l.get("legal_name"), l.get("dba")))))
                                            for l in firms)

        def related(a: dict[str, Any], b: dict[str, Any]) -> bool:
            if phone_digits(a.get("phone")) and phone_digits(a.get("phone")) == phone_digits(b.get("phone")):
                return True
            ha, hb = hosts_by_lead.get(a["company_id"], set()), hosts_by_lead.get(b["company_id"], set())
            if any(_same_site(x, y) for x in ha for y in hb):
                return True
            return name_similarity(a.get("name"), b.get("name")) >= RELATED_COMPANY_NAME_SIM

        unrelated = any(not related(a, b) for i, a in enumerate(firms) for b in firms[i + 1:])
        if not unrelated or named_after:
            continue
        label = f"{cs[0]['name']} on " + "; ".join(f"{_lead_label(ctx.leads[c['company_id']])} ({c['source']}, {c.get('title')})" for c in cs)
        (suspects if any(c["source"] in SCRAPED_CONTACT_SOURCES for c in cs) else registry_only).append(label)
    examples = [f"placeholder: {c['name']} ({c.get('title')}) on {_lead_label(ctx.leads[c['company_id']])} via {c['source']}"
                for c in placeholders] + suspects
    out.append(_check("consistency.template_names", WARN if examples else PASS,
                      {"placeholder": len(placeholders), "multi_company": len(suspects), "registry_multi_company": len(registry_only)},
                      "0 placeholder names; 0 scraped names on 2+ unrelated companies",
                      f"{len(placeholders)} placeholder names, {len(suspects)} scraped names on unrelated companies"
                      + (f"; {len(registry_only)} registry-only repeats (plausible multi-company owners)" if registry_only else ""),
                      examples + registry_only))

    shared: dict[tuple[str, str], list[tuple[str, float]]] = defaultdict(list)
    for g in ctx.leads:
        for src, key in RECORD_KEYS.items():
            r = ok_data(g, src)
            rec = (r.get("data") or {}).get(key) if r is not None else None
            if rec not in (None, ""):
                shared[(src, str(rec))].append((g, float(r.get("confidence") or 0)))
    multi = {k: v for k, v in shared.items() if len(v) > 1}
    out.append(_check("consistency.shared_records", WARN if multi else PASS, len(multi),
                      "0 registry records matched to 2+ leads",
                      f"{len(multi)} source records are attached to more than one lead (at most one match can be right)",
                      [f"{src} {rec}: " + ", ".join(f"{_lead_label(ctx.leads[g])} @ {c:g}" for g, c in sorted(v, key=lambda x: -x[1]))
                       for (src, rec), v in sorted(multi.items())]))
    return out


# --------------------------------------------------------------------------------------- report
CHECKS: tuple[Callable[[Ctx], list[dict[str, Any]]], ...] = (
    check_integrity, check_runs, check_freshness, check_provenance, check_tagging, check_audit,
    check_signals, check_coverage, check_consistency,
)


def validate(repo_or_engine: Any, postal_code: str | None = None, radius_miles: float | None = None, *,
             settings: Settings | None = None, now: datetime | None = None) -> dict[str, Any]:
    """Run every check for one area and return {area, status, counts, checks[]}. Reads only."""
    engine: Engine = getattr(repo_or_engine, "engine", repo_or_engine)
    ctx = load_context(engine, postal_code, radius_miles, settings=settings, now=now)
    checks: list[dict[str, Any]] = []
    for fn in CHECKS:
        try:
            checks += fn(ctx)
        except Exception as e:  # a crashing check is itself a failure, never a silent pass
            group = fn.__name__.removeprefix("check_")
            checks.append(_check(f"{group}.error", FAIL, None, None, f"check crashed: {type(e).__name__}: {e}"[:300]))
    counts = Counter(c["status"] for c in checks)
    status = FAIL if counts[FAIL] else WARN if counts[WARN] else PASS
    return {
        "generated_at": ctx.now.isoformat(),
        "database": engine.url.render_as_string(hide_password=True),
        "area": {"postal_code": ctx.postal_code, "radius_miles": ctx.radius_miles, "run_id": ctx.run_id,
                 "leads": len(ctx.leads)},
        "status": status,
        "counts": {s: counts.get(s, 0) for s in (PASS, WARN, FAIL, INFO)},
        "checks": checks,
    }


def exit_code(report: dict[str, Any], strict: bool = False) -> int:
    """0 when nothing failed (warnings allowed unless strict), else 1."""
    if report["counts"].get(FAIL):
        return 1
    if strict and report["counts"].get(WARN):
        return 1
    return 0


def _short(v: Any, n: int) -> str:
    if isinstance(v, dict):
        s = ", ".join(f"{k}={_short(x, 12)}" for k, x in v.items()) or "none"
    elif isinstance(v, float):
        s = f"{v:g}"
    else:
        s = "" if v is None else str(v)
    return s if len(s) <= n else s[: n - 1] + "…"


def format_report(report: dict[str, Any], *, examples: int = 2, detail_width: int = 100) -> str:
    a = report["area"]
    lines = [f"leadmaker validate: {report['database']}  area {a['postal_code']}@{a['radius_miles']}mi "
             f"(search run {a['run_id']}, {a['leads']} leads)  at {report['generated_at'][:19]}Z", ""]
    lines.append(f"{'STATUS':<7} {'CHECK':<34} {'VALUE':<26} DETAIL")
    for c in report["checks"]:
        lines.append(f"{c['status'].upper():<7} {c['id']:<34} {_short(c['value'], 26):<26} {_short(c['detail'], detail_width)}")
        if c["status"] in (WARN, FAIL):
            for ex in c["examples"][:examples]:
                lines.append(f"{'':<8}- {_short(ex, detail_width + 30)}")
    n = report["counts"]
    lines += ["", f"{n[PASS]} pass, {n[WARN]} warn, {n[FAIL]} fail, {n[INFO]} info -> {report['status'].upper()}"]
    return "\n".join(lines)
