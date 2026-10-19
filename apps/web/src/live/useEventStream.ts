import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { eventsUrl } from '@/api/endpoints';
import { isTokenExpired, sessionStore } from '@/auth/session';
import { EventStreamConnection, type LiveStatus } from './connection';
import { RESYNC_KEYS, invalidationsFor, type LiveEvent, type LiveEventType } from './eventMap';
import { liveEvents } from './liveEvents';

const FLUSH_MS = 250;

/**
 * Opens the session's single SSE connection (mounted once, in AppShell) and turns events into
 * query invalidations, batched so a pipeline run's burst of events causes one refetch per query.
 */
export function useEventStream(token: string | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!token) return;
    const pending = new Map<string, QueryKey>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const queue = (keys: QueryKey[]) => {
      for (const k of keys) pending.set(JSON.stringify(k), k);
      flushTimer ??= setTimeout(() => {
        flushTimer = null;
        const keysNow = [...pending.values()];
        pending.clear();
        for (const queryKey of keysNow) void qc.invalidateQueries({ queryKey });
      }, FLUSH_MS);
    };

    const conn = new EventStreamConnection({
      url: (lastEventId) => (isTokenExpired(token) ? null : eventsUrl(token, lastEventId)),
      onEvent: (event) => {
        queue(invalidationsFor(event));
        liveEvents.emit(event);
      },
      onStatus: (s) => liveEvents.setStatus(s),
      onResync: () => queue(RESYNC_KEYS),
      onAuthLost: () => sessionStore.set(null, 'expired'),
    });
    conn.start();
    const online = () => conn.retryNow();
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      conn.stop();
      if (flushTimer) clearTimeout(flushTimer);
      liveEvents.setStatus('idle');
    };
  }, [token, qc]);
}

/** Run `handler` for live events of a type ('*' = all), e.g. to show a toast. */
export function useLiveEvent(type: LiveEventType | '*', handler: (event: LiveEvent) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => liveEvents.subscribe(type, (e) => ref.current(e)), [type]);
}

/** 'open' | 'connecting' | 'reconnecting' | 'closed' | 'idle', for a connection indicator. */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(liveEvents.subscribeStatus, liveEvents.getStatus, liveEvents.getStatus);
}
