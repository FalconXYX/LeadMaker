// The AI insights card's Refresh (or Generate, before a lead has any): POST /api/leads/:id/insights/refresh queues a
// single-lead insights job from the lead as it is now (tags, notes, logged activity, edits), and answers 202
// {jobId, requestedAt, merged}. The card then waits for the profile's insight to be newer than the request: the
// app-wide event stream refetches the profile on lead.updated ['insights'], and a 3 s poll covers a missed event, for
// up to 90 s. Any refusal (429 try_again_later, 409, 5xx, offline) shows the one neutral REFRESH_ERROR line.
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as ep from '@/api/endpoints';
import { qk } from '@/api/queries';

export type RefreshPhase = 'idle' | 'updating' | 'updated' | 'error';

export const REFRESH_POLL_MS = 3000;
export const REFRESH_TIMEOUT_MS = 90_000;
/** How long "Updated" shows before the button reads Refresh again. */
export const REFRESH_DONE_MS = 2500;
/** One neutral line for every failure: the request refused (429 included), unreachable, or no new insight in time. */
export const REFRESH_ERROR = 'Couldn’t refresh right now. Try again in a moment.';

/** True when `generatedAt` is a valid time after `since` (ms). */
export function isNewerInsight(generatedAt: string | null | undefined, since: number): boolean {
  const t = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  return !Number.isNaN(t) && t > since;
}

export function useInsightsRefresh(leadId: string, generatedAt: string | null | undefined) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<RefreshPhase>('idle');
  const latest = useRef(generatedAt);
  latest.current = generatedAt;
  /** The request's time (ms) while waiting for the new insight; null otherwise. */
  const since = useRef<number | null>(null);
  const poll = useRef<ReturnType<typeof setInterval>>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const done = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Bumped per click and per lead: a slow answer to an older click or another lead is ignored. */
  const run = useRef(0);

  const stopWaiting = useCallback(() => {
    clearInterval(poll.current);
    clearTimeout(timeout.current);
    since.current = null;
  }, []);

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

  // The refetched profile (live event or poll) carries an insight written after the request.
  useEffect(() => {
    if (since.current !== null && isNewerInsight(generatedAt, since.current)) arrived();
  }, [generatedAt, arrived]);

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
      stopWaiting();
      setPhase('error');
      return;
    }
    // Another lead or click took over, or a newer insight already landed while the request was in flight.
    if (mine !== run.current || since.current === null) return;
    // The server's clock, the same one generated_at comes from; if it's missing, keep the on-screen baseline.
    const requested = Date.parse(res?.requestedAt ?? '');
    if (!Number.isNaN(requested)) since.current = Math.max(since.current, requested);
    if (isNewerInsight(latest.current, since.current)) {
      arrived();
      return;
    }
    const key = qk.leads.detail(leadId);
    poll.current = setInterval(() => void qc.invalidateQueries({ queryKey: key, exact: true }), REFRESH_POLL_MS);
    timeout.current = setTimeout(() => {
      if (mine !== run.current) return;
      stopWaiting();
      setPhase('error');
    }, REFRESH_TIMEOUT_MS);
  }, [leadId, qc, stopWaiting, arrived]);

  return { phase, refresh };
}
