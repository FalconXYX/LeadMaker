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
  * limits:  on-demand jobs carry requested_by; each requester may create at most
             LEADMAKER_USER_JOBS_PER_HOUR (default 20) per rolling hour. Requests
             merged into an already-open job are free.

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
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, func, select, update
from sqlalchemy.exc import IntegrityError

from .config import Settings
from .db import Repository
from .db.repository import as_utc, utcnow
from .db.schema import jobs, schedules

log = logging.getLogger(__name__)

JOB_KINDS = ("scrape", "enrich", "tag", "pipeline", "signals")
ACTIVE = ("queued", "running")
DEFAULT_USER_JOBS_PER_HOUR = 20


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
    return f"{kind}:{params.get('postal_code', '*')}:{params.get('radius_miles', '*')}:{params.get('sources') or '*'}"


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

    def fail(self, job_id: int, error: str) -> str:
        """Re-queue with backoff, or mark dead after max_attempts. Returns the new status."""
        with self.engine.begin() as conn:
            row = conn.execute(select(jobs.c.attempts, jobs.c.max_attempts).where(jobs.c.id == job_id)).first()
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
            return status

    def requeue_stale(self, older_than: timedelta = timedelta(hours=2)) -> int:
        """Re-queue running jobs whose worker lock expired. Returns how many were re-queued.

        A job that has already used all its attempts goes to 'dead' instead: a job
        that crashes its worker never reaches fail(), so it would otherwise loop forever.
        """
        cutoff = utcnow() - older_than
        with self.engine.connect() as conn:
            stale = conn.execute(
                select(jobs.c.id, jobs.c.attempts, jobs.c.max_attempts)
                .where(jobs.c.status == "running", jobs.c.locked_at < cutoff)
            ).all()
        requeued = 0
        for row in stale:
            guard = and_(jobs.c.id == row.id, jobs.c.status == "running", jobs.c.locked_at < cutoff)
            if row.attempts >= row.max_attempts:
                with self.engine.begin() as conn:
                    conn.execute(update(jobs).where(guard).values(
                        status="dead", locked_by=None, finished_at=utcnow(),
                        error=f"worker lock expired after {row.attempts} attempts",
                    ))
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
        job_id = self.enqueue(s["kind"], s["params"], schedule_id=s["id"], dedupe_key=f"schedule:{s['id']}")
        if job_id:
            with self.engine.begin() as conn:
                conn.execute(update(schedules).where(schedules.c.id == s["id"]).values(last_enqueued_at=now))
        return job_id


# ---------------------------------------------------------------------- worker
async def execute(settings: Settings, repo: Repository, kind: str, params: dict[str, Any]) -> dict[str, Any]:
    from .pipeline.enrich import EnrichOptions, run_enrich
    from .pipeline.scrape import ScrapeOptions, run_scrape
    from .pipeline.tag import run_tagging

    area = {k: params[k] for k in ("postal_code", "radius_miles") if k in params}
    out: dict[str, Any] = {}
    if kind in ("scrape", "pipeline"):
        scrape_keys = ScrapeOptions.__dataclass_fields__.keys()
        rep = await run_scrape(settings, repo, ScrapeOptions(**{k: v for k, v in params.items() if k in scrape_keys}))
        out["scrape"] = {"run_id": rep.run_id, "status": rep.status, "upsert": rep.stats.get("upsert"),
                         "profiles": rep.stats.get("profiles"), "delisted": rep.stats.get("delisted"),
                         "completeness": rep.stats.get("completeness")}
    if kind in ("enrich", "pipeline"):
        enrich_keys = EnrichOptions.__dataclass_fields__.keys()
        rep = await run_enrich(settings, repo, EnrichOptions(**{k: v for k, v in params.items() if k in enrich_keys}))
        out["enrich"] = {"run_id": rep.run_id, "status": rep.status, "by_source": rep.stats.get("by_source")}
    if kind in ("tag", "pipeline"):
        out["tag"] = run_tagging(repo, area.get("postal_code"), area.get("radius_miles"))
    if kind == "signals":
        from .pipeline.signals import run_signals

        out["signals"] = await run_signals(settings, repo, force_storms=bool(params.get("force_storms")),
                                           news=params.get("news", True))
    return out


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
    processed = 0
    while max_jobs is None or processed < max_jobs:
        q.enqueue_due_schedules()
        q.requeue_stale()
        job = q.claim(worker_id)
        if job is None:
            if once:
                break
            await asyncio.sleep(poll_seconds)
            continue
        log.info("job %s (%s) attempt %s: %s", job["id"], job["kind"], job["attempts"], job["params"])
        try:
            result = await execute(settings, repo, job["kind"], job["params"] or {})
            q.complete(job["id"], result)
            log.info("job %s succeeded", job["id"])
        except Exception as e:
            status = q.fail(job["id"], f"{type(e).__name__}: {e}")
            log.exception("job %s failed -> %s", job["id"], status)
        processed += 1
    return processed
