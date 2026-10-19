"""DB-backed job queue + scheduler + worker.

Covers Section 1's "scheduled & on-demand runs" and "job queues" requirements
without new infrastructure: jobs live in the same database, so any number of
`leadmaker worker` processes can share them.

  * enqueue: on-demand (`leadmaker jobs enqueue ...`) or from a schedule.
  * claim:   Postgres -> SELECT ... FOR UPDATE SKIP LOCKED; SQLite -> atomic
             conditional UPDATE (status='queued' guard), so two workers never
             run the same job.
  * retry:   exponential backoff (attempts^2 minutes) up to max_attempts, then
             'dead' (a dead-letter state you can inspect and re-queue).
  * dedupe:  at most one queued/running job per dedupe_key (e.g. one refresh of
             ZIP 10013 at a time), so schedules and manual triggers don't pile up.
             The check-then-insert is backed by the unique partial index
             uq_jobs_open_dedupe, so a lost race returns "already queued" instead
             of creating a second job; every path that re-opens a job honours it.
  * stale:   jobs locked by a crashed worker are re-queued after a timeout (or
             marked dead once they have used all attempts, so a job that kills
             its worker cannot loop forever).
  * limits:  on-demand jobs carry requested_by (a users.id uuid); each requester may
             create at most LEADMAKER_USER_JOBS_PER_HOUR (default 20) per rolling hour.
             Requests merged into an already-open job are free. The CRM Write Service
             enqueues refreshes into the same table with the same dedupe key and limit.

Production path: swap this table for SQS/Cloud Tasks (or Celery/Temporal) --
job kinds and params stay the same. Per-host rate limits are enforced inside
each worker by HttpClient; with many workers, a shared limiter (e.g. a Redis
token bucket per source) is needed so total load per host stays polite
(not yet built).
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, func, select, update
from sqlalchemy.exc import IntegrityError

from .config import Settings
from .db import Repository
from .db.repository import as_utc, utcnow
from .db.schema import jobs, schedules, users

log = logging.getLogger(__name__)

JOB_KINDS = ("scrape", "enrich", "tag", "pipeline", "signals", "insights", "briefing")
ACTIVE = ("queued", "running")
DEFAULT_USER_JOBS_PER_HOUR = 20
# A rep's "Refresh" on a profile (crm-write POST /api/leads/:id/insights/refresh): runs before everything else.
MANUAL_INSIGHTS_PRIORITY = 10
# A due job at or below this priority wakes an idle worker within LEADMAKER_WORKER_URGENT_POLL_SECONDS (default 1 s)
# instead of the full --poll interval; refreshes (100) and AI follow-ups (150, 200) wait for the normal poll.
URGENT_PRIORITY = 50


class JobRateLimitError(Exception):
    """A requester created too many on-demand jobs in the last hour."""

    def __init__(self, requested_by: str, limit: int, retry_at: datetime | None):
        self.requested_by = requested_by
        self.limit = limit
        self.retry_at = retry_at  # when the oldest job in the window ages out
        when = f"; try again after {retry_at:%H:%M} UTC" if retry_at else ""
        super().__init__(f"{requested_by} reached the limit of {limit} on-demand jobs per hour{when}")


def _user_jobs_per_hour() -> int:
    raw = os.environ.get("LEADMAKER_USER_JOBS_PER_HOUR")
    return int(raw) if raw else DEFAULT_USER_JOBS_PER_HOUR


def area_dedupe_key(kind: str, params: dict[str, Any]) -> str:
    """`{kind}:{postal_code}:{radius}:{sources}` with the radius as %g (25, not 25.0) and sources sorted and
    comma-joined, so the CLI, schedules and the CRM Write Service build the same key for the same area."""
    radius = params.get("radius_miles")
    try:
        radius = f"{float(radius):g}"
    except (TypeError, ValueError):
        radius = "*" if radius is None else str(radius)
    sources = params.get("sources") or "*"
    if isinstance(sources, (list, tuple)):
        sources = ",".join(sorted(str(s) for s in sources)) or "*"
    return f"{kind}:{params.get('postal_code', '*')}:{radius}:{sources}"


def user_id(value: str) -> str:
    """A requester id must be a users.id (uuid); returns it in canonical form."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        raise ValueError(f"requested_by must be a user id (uuid), got {value!r}") from None


class JobQueue:
    def __init__(self, repo: Repository, *, user_jobs_per_hour: int | None = None):
        self.repo = repo
        self.engine = repo.engine
        # Per-requester cap for on-demand jobs; <= 0 disables it.
        self.user_jobs_per_hour = _user_jobs_per_hour() if user_jobs_per_hour is None else user_jobs_per_hour

    # ---------------------------------------------------------------- enqueue
    def enqueue(
        self,
        kind: str,
        params: dict[str, Any],
        *,
        priority: int = 100,
        run_after: datetime | None = None,
        dedupe_key: str | None = None,
        max_attempts: int = 3,
        schedule_id: int | None = None,
        requested_by: str | None = None,
    ) -> int | None:
        """Returns the new job id, or None if an equivalent job is already queued/running.

        With requested_by (a rep's user id), the job counts against that requester's
        hourly limit; JobRateLimitError is raised when it is used up. A request that
        merges into an open job returns None before the limit is checked, so it is free.
        Use open_job_id(dedupe_key) to find the job a None was merged into.
        """
        if kind not in JOB_KINDS:
            raise ValueError(f"unknown job kind {kind!r}; expected one of {JOB_KINDS}")
        if requested_by:
            requested_by = user_id(requested_by)
        dedupe_key = dedupe_key or area_dedupe_key(kind, params)
        now = utcnow()
        try:
            with self.engine.begin() as conn:
                dup = conn.execute(
                    select(jobs.c.id).where(jobs.c.dedupe_key == dedupe_key, jobs.c.status.in_(ACTIVE)).limit(1)
                ).first()
                if dup is not None:
                    return None
                if requested_by:
                    if conn.execute(select(users.c.id).where(users.c.id == requested_by)).first() is None:
                        raise ValueError(f"requested_by {requested_by} is not a known user")
                    self._check_rate(conn, requested_by, now)
                res = conn.execute(
                    jobs.insert().values(
                        kind=kind, params=params, dedupe_key=dedupe_key, status="queued", priority=priority,
                        attempts=0, max_attempts=max_attempts, run_after=run_after or now,
                        schedule_id=schedule_id, requested_by=requested_by, created_at=now,
                    )
                )
                return int(res.inserted_primary_key[0])
        except IntegrityError:
            # Another enqueue of the same key committed between our check and insert;
            # the unique index kept exactly one open job, which is what we wanted.
            if self.open_job_id(dedupe_key) is not None:
                log.info("enqueue raced on %s; merged into the open job", dedupe_key)
                return None
            raise

    def open_job_id(self, dedupe_key: str) -> int | None:
        """The queued/running job holding this dedupe key, if any."""
        with self.engine.connect() as conn:
            return conn.execute(
                select(jobs.c.id).where(jobs.c.dedupe_key == dedupe_key, jobs.c.status.in_(ACTIVE)).limit(1)
            ).scalar()

    def has_urgent(self, max_priority: int = URGENT_PRIORITY) -> bool:
        """A queued, due job at or below max_priority (e.g. a manual insights refresh) is waiting."""
        with self.engine.connect() as conn:
            return conn.execute(
                select(jobs.c.id).where(jobs.c.status == "queued", jobs.c.priority <= max_priority,
                                        jobs.c.run_after <= utcnow()).limit(1)
            ).first() is not None

    def _check_rate(self, conn, requested_by: str, now: datetime) -> None:
        """Soft limit: two simultaneous requests by one user can both pass at limit-1."""
        limit = self.user_jobs_per_hour
        if limit <= 0:
            return
        window = now - timedelta(hours=1)
        count, oldest = conn.execute(
            select(func.count(), func.min(jobs.c.created_at)).where(
                jobs.c.requested_by == requested_by, jobs.c.created_at > window
            )
        ).one()
        if count >= limit:
            # In UTC: Postgres hands back timestamps in the session's time zone.
            retry_at = (as_utc(oldest) + timedelta(hours=1)).astimezone(timezone.utc) if oldest else None
            raise JobRateLimitError(requested_by, limit, retry_at)

    # ------------------------------------------------------------------ claim
    def claim(self, worker_id: str, kinds: tuple[str, ...] | None = None) -> dict[str, Any] | None:
        now = utcnow()
        cond = and_(jobs.c.status == "queued", jobs.c.run_after <= now)
        if kinds:
            cond = and_(cond, jobs.c.kind.in_(kinds))
        with self.engine.begin() as conn:
            q = select(jobs.c.id).where(cond).order_by(jobs.c.priority, jobs.c.id).limit(5)
            if conn.dialect.name == "postgresql":
                q = q.with_for_update(skip_locked=True)
            for (job_id,) in conn.execute(q).all():
                res = conn.execute(
                    update(jobs)
                    .where(jobs.c.id == job_id, jobs.c.status == "queued")
                    .values(status="running", locked_by=worker_id, locked_at=now, attempts=jobs.c.attempts + 1)
                )
                if res.rowcount == 1:
                    row = conn.execute(select(jobs).where(jobs.c.id == job_id)).first()
                    return dict(row._mapping)
        return None

    def complete(self, job_id: int, result: dict[str, Any]) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                update(jobs).where(jobs.c.id == job_id).values(
                    status="succeeded", result=result, error=None, finished_at=utcnow(), locked_by=None
                )
            )

    def fail(self, job_id: int, error: str, run_ids: Sequence[int] = ()) -> str:
        """Re-queue with backoff, or mark dead after max_attempts. Returns the new status. `run_ids`: the runs
        the failed attempt started, for the dead-job event (job_dead_event)."""
        with self.engine.begin() as conn:
            row = conn.execute(
                select(jobs.c.attempts, jobs.c.max_attempts, jobs.c.kind, jobs.c.requested_by).where(jobs.c.id == job_id)
            ).first()
            if row is None:
                return "missing"
            if row.attempts >= row.max_attempts:
                status, values = "dead", {"finished_at": utcnow()}
            else:
                status = "queued"
                values = {"run_after": utcnow() + timedelta(minutes=row.attempts**2)}
            conn.execute(
                update(jobs).where(jobs.c.id == job_id).values(status=status, error=error[:4000], locked_by=None, **values)
            )
            if status == "dead":
                job_dead_event(conn, job_id, row.kind, row.requested_by, run_ids)
            return status

    def requeue_stale(self, older_than: timedelta = timedelta(hours=2)) -> int:
        """Re-queue running jobs whose worker lock expired. Returns how many were re-queued.

        A job that has already used all its attempts goes to 'dead' instead: a job
        that crashes its worker never reaches fail(), so it would otherwise loop forever.
        """
        cutoff = utcnow() - older_than
        with self.engine.connect() as conn:
            stale = conn.execute(
                select(jobs.c.id, jobs.c.attempts, jobs.c.max_attempts, jobs.c.kind, jobs.c.requested_by)
                .where(jobs.c.status == "running", jobs.c.locked_at < cutoff)
            ).all()
        requeued = 0
        for row in stale:
            guard = and_(jobs.c.id == row.id, jobs.c.status == "running", jobs.c.locked_at < cutoff)
            if row.attempts >= row.max_attempts:
                with self.engine.begin() as conn:
                    died = conn.execute(update(jobs).where(guard).values(
                        status="dead", locked_by=None, finished_at=utcnow(),
                        error=f"worker lock expired after {row.attempts} attempts",
                    )).rowcount
                    if died:
                        job_dead_event(conn, row.id, row.kind, row.requested_by)
                log.warning("job %s dead: worker lock expired on its last attempt", row.id)
            elif self._reopen(row.id, guard, locked_by=None, error="re-queued: worker lock expired"):
                requeued += 1
        return requeued

    def retry_dead(self, job_id: int | None = None) -> int:
        """Re-queue dead jobs. One whose dedupe key already has an open job is left dead
        (the open job does the same work); among dead jobs sharing a key, the newest wins."""
        q = select(jobs.c.id).where(jobs.c.status == "dead").order_by(jobs.c.id.desc())
        if job_id is not None:
            q = q.where(jobs.c.id == job_id)
        with self.engine.connect() as conn:
            dead_ids = conn.execute(q).scalars().all()
        requeued = 0
        for jid in dead_ids:
            guard = and_(jobs.c.id == jid, jobs.c.status == "dead")
            if self._reopen(jid, guard, attempts=0, run_after=utcnow(), finished_at=None):
                requeued += 1
        return requeued

    def _reopen(self, job_id: int, where, **values: Any) -> bool:
        """Set one job back to 'queued' unless that would give its dedupe key a second open job."""
        try:
            with self.engine.begin() as conn:
                return bool(conn.execute(update(jobs).where(where).values(status="queued", **values)).rowcount)
        except IntegrityError:
            log.info("not re-queuing job %s: its dedupe key already has an open job", job_id)
            return False

    def list(self, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        q = select(jobs).order_by(jobs.c.id.desc()).limit(limit)
        if status:
            q = q.where(jobs.c.status == status)
        with self.engine.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(q)]

    # -------------------------------------------------------------- schedules
    def add_schedule(
        self, name: str, kind: str, params: dict[str, Any], every_hours: float, start_at: datetime | None = None
    ) -> int:
        if kind not in JOB_KINDS:
            raise ValueError(f"unknown job kind {kind!r}")
        if every_hours <= 0:
            raise ValueError("every_hours must be positive")
        now = utcnow()
        with self.engine.begin() as conn:
            existing = conn.execute(select(schedules.c.id).where(schedules.c.name == name)).first()
            values = {"kind": kind, "params": params, "every_hours": every_hours, "enabled": True,
                      "next_run_at": start_at or now}
            if existing:
                conn.execute(update(schedules).where(schedules.c.id == existing.id).values(**values))
                return int(existing.id)
            res = conn.execute(schedules.insert().values(name=name, created_at=now, **values))
            return int(res.inserted_primary_key[0])

    def list_schedules(self) -> list[dict[str, Any]]:
        with self.engine.connect() as conn:
            return [dict(r._mapping) for r in conn.execute(select(schedules).order_by(schedules.c.id))]

    def set_schedule_enabled(self, name: str, enabled: bool) -> bool:
        with self.engine.begin() as conn:
            res = conn.execute(update(schedules).where(schedules.c.name == name).values(enabled=enabled))
            return bool(res.rowcount)

    def enqueue_due_schedules(self, now: datetime | None = None) -> list[int]:
        now = now or utcnow()
        with self.engine.connect() as conn:
            due = [dict(r._mapping) for r in conn.execute(
                select(schedules).where(schedules.c.enabled.is_(True), schedules.c.next_run_at <= now)
            )]
        return [job_id for s in due if (job_id := self._fire_schedule(s, now))]

    def _fire_schedule(self, s: dict[str, Any], now: datetime) -> int | None:
        """Claim the schedule's due slot, then enqueue its job.

        Many workers poll schedules at once, so the slot is claimed by advancing
        next_run_at only while it is still due: only the winner enqueues. Without it,
        a worker holding a stale read could enqueue the same slot again after the
        first job already finished (the dedupe key is free by then). The guard is
        "still due", not "equals what we read", so a row whose timestamp was written
        in another format (e.g. by hand in sqlite3) still fires instead of sticking.
        """
        # Advance to the next slot in the future (skip missed slots instead of bursting).
        step = timedelta(hours=s["every_hours"])
        nxt = as_utc(s["next_run_at"]) or now
        while nxt <= now:
            nxt += step
        with self.engine.begin() as conn:
            won = conn.execute(
                update(schedules)
                .where(schedules.c.id == s["id"], schedules.c.next_run_at <= now)
                .values(next_run_at=nxt)
            ).rowcount
        if not won:
            return None  # another worker claimed this slot
        job_id = self.enqueue(s["kind"], s["params"], schedule_id=s["id"],
                              dedupe_key=area_dedupe_key(s["kind"], s["params"]))
        if job_id:
            with self.engine.begin() as conn:
                conn.execute(update(schedules).where(schedules.c.id == s["id"]).values(last_enqueued_at=now))
        return job_id


def job_dead_event(conn, job_id: int, kind: str, requested_by: Any, run_ids: Sequence[int] = ()) -> None:
    """In the transaction that marks a requester's job dead: a pipeline.run_completed of kind 'job' with status
    'failed' (no run of its own; no company ids) and the job fields, so the notifier tells the requester their
    refresh failed. Scheduled and CLI jobs (no requester) emit nothing."""
    if not requested_by:
        return
    Repository._emit(conn, "pipeline.run_completed", {
        "run_id": None, "kind": "job", "status": "failed", "complete": False, "changed_companies": 0,
        "company_ids": [], "company_ids_truncated": False, "job_id": job_id, "job_kind": kind, "job_status": "dead",
        "requested_by": str(requested_by), "job_run_ids": list(run_ids),
    })


# ---------------------------------------------------------------------- worker
@contextmanager
def job_events(repo: Repository, job: dict[str, Any]) -> Iterator[list[int]]:
    """Stamps every pipeline.run_completed the job's runs emit with job_id, job_kind, requested_by and
    job_run_ids (the job's earlier runs), so the notifier can tell the requester when their refresh is done.
    Yields the list of the runs started so far."""
    stamp = {"job_id": job["id"], "job_kind": job["kind"],
             "requested_by": str(job["requested_by"]) if job.get("requested_by") else None}
    runs: list[int] = []

    def emit(conn, event_type: str, payload: dict[str, Any], company_id: str | None = None) -> None:
        if event_type == "pipeline.run_completed":
            payload = {**payload, **stamp, "job_run_ids": list(runs)}
            runs.append(payload["run_id"])
        Repository._emit(conn, event_type, payload, company_id)

    repo._emit = emit  # Repository.finish_run emits through self._emit
    try:
        yield runs
    finally:
        del repo._emit


# --------------------------------------------------------------------- Section 4: AI follow-ups and schedules
INSIGHTS_FOLLOW_UP_PRIORITY = 200  # after refreshes (100) and the briefing (150): lower runs first
BRIEFING_FOLLOW_UP_PRIORITY = 150
INSIGHTS_MAX_ATTEMPTS = 2  # an auth failure dead-letters after two tries
# name -> (kind, params, every_hours); created at worker start only with LEADMAKER_AI_SCHEDULES=1 (off by default,
# so a running stack never spends LLM quota unattended).
AI_SCHEDULES = {
    "insights-stale": ("insights", {"stale": True}, 0.25),
    "briefing": ("briefing", {}, 1.0),
}


def _env_on(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


def llm_configured(settings: Settings) -> bool:
    """A usable LLM provider is configured (a key, or the fake where it is allowed)."""
    from .insights.run import provider_ready

    try:
        return provider_ready(settings)[0] is not None
    except Exception:  # a broken provider setting must not fail the job that asks
        log.exception("could not check the LLM provider")
        return False


def briefing_on_refresh(repo: Repository, settings: Settings, llm: bool | None = None) -> bool:
    """Whether refreshes queue the territory briefing. LEADMAKER_BRIEFING_ON_REFRESH=1 / 0 forces it; unset
    ("auto") means on once the feature is in use: an LLM is configured, or territory_briefs already has a row
    (from `leadmaker briefing`, the opt-in schedule or an earlier chain). So a bare pipeline (Section 1 runs,
    offline tests) queues nothing extra, and a stack that shows briefs keeps them current."""
    raw = (os.environ.get("LEADMAKER_BRIEFING_ON_REFRESH") or "auto").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    if llm if llm is not None else llm_configured(settings):
        return True
    from .db.schema import territory_briefs

    with repo.engine.connect() as conn:
        return conn.execute(select(territory_briefs.c.scope).limit(1)).first() is not None


def enqueue_ai_follow_ups(repo: Repository, settings: Settings, area: dict[str, Any] | None,
                          *, insights: bool = True) -> dict[str, Any]:
    """After a refresh (scrape, tag, pipeline): queue `insights` for the area it touched (or `{"stale": true}`
    without one), only when a provider is configured and LEADMAKER_INSIGHTS_ON_REFRESH is not 0, and the
    deterministic `briefing` (see briefing_on_refresh). Dedupe keys merge repeats into the open job. Enqueue
    failures are logged and never fail the calling job.
    Returns {"insights": job id | None (merged) | "skipped" | "error", "briefing": the same}."""
    q = JobQueue(repo)
    out: dict[str, Any] = {}
    llm: bool | None = None
    if insights:
        try:
            llm = llm_configured(settings)
            if not _env_on("LEADMAKER_INSIGHTS_ON_REFRESH", True) or not llm:
                out["insights"] = "skipped"
            else:
                area = area or {}
                params: dict[str, Any] = (
                    {"postal_code": area["postal_code"], "radius_miles": area["radius_miles"]}
                    if area.get("postal_code") and area.get("radius_miles") else {"stale": True})
                out["insights"] = q.enqueue("insights", params, priority=INSIGHTS_FOLLOW_UP_PRIORITY,
                                            max_attempts=INSIGHTS_MAX_ATTEMPTS)
        except Exception:
            log.exception("could not enqueue the insights follow-up")
            out["insights"] = "error"
    try:
        if briefing_on_refresh(repo, settings, llm):
            out["briefing"] = q.enqueue("briefing", {}, priority=BRIEFING_FOLLOW_UP_PRIORITY)
        else:
            out["briefing"] = "skipped"
    except Exception:
        log.exception("could not enqueue the briefing follow-up")
        out["briefing"] = "error"
    return out


def ensure_ai_schedules(q: JobQueue) -> dict[str, int]:
    """Create the AI schedules (AI_SCHEDULES) when missing or different. An existing identical schedule is left
    alone, so a restart neither re-fires it nor re-enables one an operator disabled. Returns {name: id}."""
    have = {s["name"]: s for s in q.list_schedules()}
    out: dict[str, int] = {}
    for name, (kind, params, every) in AI_SCHEDULES.items():
        s = have.get(name)
        if s is not None and s["kind"] == kind and (s["params"] or {}) == params and float(s["every_hours"]) == every:
            out[name] = int(s["id"])
            continue
        out[name] = q.add_schedule(name, kind, params, every)
    return out


async def execute(settings: Settings, repo: Repository, kind: str, params: dict[str, Any]) -> dict[str, Any]:
    """Run one job. A scrape (also inside 'pipeline') is followed by county assignment and tagging for the
    area it read, so refreshed and new leads come with county_fips, tags, segment and priority. Scrape, tag and
    pipeline then queue the AI follow-ups (insights for the area, the territory briefing); signals queues the
    briefing."""
    if kind == "insights":
        from .insights import InsightsOptions, run_insights

        return {"insights": await run_insights(settings, repo, InsightsOptions.from_params(params))}
    if kind == "briefing":
        from .briefing import run_briefing

        rewrite = params.get("rewrite")
        return {"briefing": await run_briefing(settings, repo, scopes=params.get("scopes"),
                                               rewrite=None if rewrite is None else bool(rewrite),
                                               force=bool(params.get("force")))}

    from .pipeline.enrich import EnrichOptions, run_enrich
    from .pipeline.scrape import ScrapeOptions, run_scrape
    from .pipeline.signals import run_counties
    from .pipeline.tag import run_tagging

    area = {k: params[k] for k in ("postal_code", "radius_miles") if k in params}
    out: dict[str, Any] = {}
    if kind in ("scrape", "pipeline"):
        scrape_keys = ScrapeOptions.__dataclass_fields__.keys()
        rep = await run_scrape(settings, repo, ScrapeOptions(**{k: v for k, v in params.items() if k in scrape_keys}))
        if rep.area is not None:  # the area as read (ScrapeOptions defaults included), as its search hits store it
            area = {"postal_code": rep.area.postal_code, "radius_miles": rep.area.radius_miles}
        out["scrape"] = {"run_id": rep.run_id, "status": rep.status, "upsert": rep.stats.get("upsert"),
                         "profiles": rep.stats.get("profiles"), "delisted": rep.stats.get("delisted"),
                         "completeness": rep.stats.get("completeness")}
    if kind in ("enrich", "pipeline"):
        enrich_keys = EnrichOptions.__dataclass_fields__.keys()
        rep = await run_enrich(settings, repo, EnrichOptions(**{k: v for k, v in params.items() if k in enrich_keys}))
        out["enrich"] = {"run_id": rep.run_id, "status": rep.status, "by_source": rep.stats.get("by_source")}
    if kind in ("scrape", "pipeline"):
        ids = repo.area_company_ids(area["postal_code"], area["radius_miles"]) if len(area) == 2 else None
        try:
            out["counties"] = await run_counties(settings, repo, ids)
        except Exception as e:  # the scrape landed; the next refresh or signals run assigns the county
            log.exception("county assignment after %s failed", kind)
            out["counties"] = {"error": f"{type(e).__name__}: {e}"[:500]}
    if kind in ("scrape", "tag", "pipeline"):
        out["tag"] = run_tagging(repo, area.get("postal_code"), area.get("radius_miles"))
        out["follow_up"] = enqueue_ai_follow_ups(repo, settings, area)
    if kind == "signals":
        from .pipeline.signals import run_signals

        out["signals"] = await run_signals(settings, repo, force_storms=bool(params.get("force_storms")),
                                           news=params.get("news", True))
        out["follow_up"] = enqueue_ai_follow_ups(repo, settings, None, insights=False)
    return out


def urgent_poll_seconds() -> float:
    raw = (os.environ.get("LEADMAKER_WORKER_URGENT_POLL_SECONDS") or "").strip()
    try:
        return float(raw) if raw else 1.0
    except ValueError:
        return 1.0


async def idle(q: JobQueue, poll_seconds: float, *, step: float | None = None, sleep=asyncio.sleep) -> None:
    """Wait out an idle poll, but return as soon as an urgent job (has_urgent) is due, checked every `step` seconds
    (urgent_poll_seconds; <= 0, or not shorter than the poll, sleeps the whole poll)."""
    step = urgent_poll_seconds() if step is None else step
    if step <= 0 or step >= poll_seconds:
        await sleep(poll_seconds)
        return
    waited = 0.0
    while waited < poll_seconds:
        await sleep(min(step, poll_seconds - waited))
        waited += step
        try:
            if q.has_urgent():
                return
        except Exception:  # a database hiccup: the next full poll reports it
            log.warning("urgent-job check failed", exc_info=True)


async def work(
    settings: Settings,
    repo: Repository,
    *,
    worker_id: str | None = None,
    once: bool = False,
    poll_seconds: float = 15.0,
    max_jobs: int | None = None,
) -> int:
    """Run jobs until stopped (or until the queue is empty with once=True). Returns jobs processed."""
    q = JobQueue(repo)
    worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}"
    if _env_on("LEADMAKER_AI_SCHEDULES", False):
        try:
            log.info("AI schedules: %s", ensure_ai_schedules(q))
        except Exception:
            log.exception("could not create the AI schedules")
    processed = 0
    while max_jobs is None or processed < max_jobs:
        q.enqueue_due_schedules()
        q.requeue_stale()
        job = q.claim(worker_id)
        if job is None:
            if once:
                break
            await idle(q, poll_seconds)
            continue
        log.info("job %s (%s) attempt %s: %s", job["id"], job["kind"], job["attempts"], job["params"])
        runs: list[int] = []
        try:
            with job_events(repo, job) as runs:
                result = await execute(settings, repo, job["kind"], job["params"] or {})
            q.complete(job["id"], result)
            log.info("job %s succeeded", job["id"])
        except Exception as e:
            status = q.fail(job["id"], f"{type(e).__name__}: {e}", run_ids=runs)
            log.exception("job %s failed -> %s", job["id"], status)
        processed += 1
    return processed
