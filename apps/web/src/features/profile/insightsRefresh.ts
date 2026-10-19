// The AI insights card's Refresh (or Generate, before a lead has any): POST /api/leads/:id/insights/refresh queues a
// single-lead insights job from the lead as it is now (tags, notes, logged activity, edits), and answers 202
// {jobId, requestedAt, merged}. The card then waits until the profile shows how that run ended: an insight newer than
// the request ("Updated"), or an insightAttempt with status 'error' after requestedAt (ATTEMPT_ERROR at once, instead of
// waiting out the timeout). The app-wide event stream refetches the profile on lead.updated ['insights'] (the worker
// emits it on success and on a failed manual run), and a 3 s poll covers a missed event, for up to 100 s. Any refusal
// (429 try_again_later, 409, 5xx, offline) or the timeout shows the neutral REFRESH_ERROR line.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as ep from '@/api/endpoints';
import { qk } from '@/api/queries';
import type { InsightAttempt, LeadProfile } from '@/api/types';

export type RefreshPhase = 'idle' | 'updating' | 'updated' | 'error';

export const REFRESH_POLL_MS = 3000;
/**
 * A manual run makes up to 3 model calls (the answer plus 2 retries, leadmaker/insights MANUAL_ATTEMPTS) at 20-30 s
 * each on a slow free-tier day, so the wait covers them; a run that ends in error says so at once (ATTEMPT_ERROR).
 */
export const REFRESH_TIMEOUT_MS = 100_000;
/** How long "Updated" shows before the button reads Refresh again. */
export const REFRESH_DONE_MS = 2500;
/** The neutral line when the request is refused (429 included) or unreachable, or nothing comes back in time. */
export const REFRESH_ERROR = 'Couldn’t refresh right now. Try again in a moment.';
/** The run itself ended in error (the model's answer didn't pass the quality checks, or the model failed). */
export const ATTEMPT_ERROR = 'Couldn’t update the insights this time. Try again.';

/**
 * LeadProfile.insightAttempt (packages/shared): the latest company_insights row for the lead, any status (the served
 * insight stays the latest OK one).
 */
export type { InsightAttempt };

/** The profile's insightAttempt, or null when absent (an older query service that predates the field). */
export function attemptOf(profile: Pick<LeadProfile, 'insightAttempt'> | object): InsightAttempt | null {
  return (profile as { insightAttempt?: InsightAttempt | null }).insightAttempt ?? null;
}

/** True when `generatedAt` is a valid time after `since` (ms). */
export function isNewerInsight(generatedAt: string | null | undefined, since: number): boolean {
  const t = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  return !Number.isNaN(t) && t > since;
}

/** True when the latest attempt is an error written after `since` (ms): that run is over and nothing new is coming. */
export function isFailedAttempt(attempt: InsightAttempt | null | undefined, since: number): boolean {
  return attempt?.status === 'error' && isNewerInsight(attempt.at, since);
}

export function useInsightsRefresh(
  leadId: string,
  generatedAt: string | null | undefined,
  attempt?: InsightAttempt | null,
) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<RefreshPhase>('idle');
  /** The line under the header while phase is 'error'. */
  const [problem, setProblem] = useState(REFRESH_ERROR);
  const latest = useRef(generatedAt);
  latest.current = generatedAt;
  const latestAttempt = useRef(attempt);
  latestAttempt.current = attempt;
  const attemptStatus = attempt?.status;
  const attemptAt = attempt?.at;
  /** The request's time (ms) while waiting for the new insight; null otherwise. */
  const since = useRef<number | null>(null);
  /**
   * The server's requestedAt (ms) once the POST answers; null before that and when not waiting. Only an error after it
   * ends the wait: an older one belongs to an earlier run.
   */
  const requested = useRef<number | null>(null);
  const poll = useRef<ReturnType<typeof setInterval>>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const done = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Bumped per click and per lead: a slow answer to an older click or another lead is ignored. */
  const run = useRef(0);

  const stopWaiting = useCallback(() => {
    clearInterval(poll.current);
    clearTimeout(timeout.current);
    since.current = null;
    requested.current = null;
  }, []);

  const failed = useCallback((message: string) => {
    stopWaiting();
    setProblem(message);
    setPhase('error');
  }, [stopWaiting]);

  const arrived = useCallback(() => {
    stopWaiting();
    setPhase('updated');
    done.current = setTimeout(() => setPhase('idle'), REFRESH_DONE_MS);
  }, [stopWaiting]);

  // A different lead (or leaving the page): drop whatever this one was waiting for.
  useEffect(() => () => {
    run.current++;
    stopWaiting();
    clearTimeout(done.current);
    setPhase('idle');
  }, [leadId, stopWaiting]);

  // The refetched profile (live event or poll) carries an insight written after the request, or says the run failed.
  useEffect(() => {
    if (since.current === null) return;
    if (isNewerInsight(generatedAt, since.current)) arrived();
    else if (requested.current !== null && isFailedAttempt(latestAttempt.current, requested.current)) failed(ATTEMPT_ERROR);
  }, [generatedAt, attemptStatus, attemptAt, arrived, failed]);

  const refresh = useCallback(async () => {
    if (since.current !== null) return; // already waiting
    const mine = ++run.current;
    clearTimeout(done.current);
    stopWaiting();
    setPhase('updating');
    // Until the server answers, any insight newer than the one on screen counts.
    const before = latest.current ? Date.parse(latest.current) : Number.NEGATIVE_INFINITY;
    since.current = Number.isNaN(before) ? Number.NEGATIVE_INFINITY : before;
    let res: Awaited<ReturnType<typeof ep.refreshLeadInsights>> | undefined;
    try {
      res = await ep.refreshLeadInsights(leadId);
    } catch {
      if (mine !== run.current) return;
      failed(REFRESH_ERROR);
      return;
    }
    // Another lead or click took over, or a newer insight already landed while the request was in flight.
    if (mine !== run.current || since.current === null) return;
    // The server's clock, the same one generated_at comes from; if it's missing, keep the on-screen baseline.
    const requestedMs = Date.parse(res?.requestedAt ?? '');
    if (!Number.isNaN(requestedMs)) {
      since.current = Math.max(since.current, requestedMs);
      requested.current = requestedMs;
    }
    if (isNewerInsight(latest.current, since.current)) {
      arrived();
      return;
    }
    if (requested.current !== null && isFailedAttempt(latestAttempt.current, requested.current)) {
      failed(ATTEMPT_ERROR);
      return;
    }
    const key = qk.leads.detail(leadId);
    poll.current = setInterval(() => void qc.invalidateQueries({ queryKey: key, exact: true }), REFRESH_POLL_MS);
    timeout.current = setTimeout(() => {
      if (mine !== run.current) return;
      failed(REFRESH_ERROR);
    }, REFRESH_TIMEOUT_MS);
  }, [leadId, qc, stopWaiting, arrived, failed]);

  return { phase, problem, refresh };
}
