// Pub/sub for live events (toasts, highlights) and the connection status, independent of React.
import type { LiveStatus } from './connection';
import type { LiveEvent, LiveEventType } from './eventMap';

type Handler = (event: LiveEvent) => void;

const handlers = new Map<LiveEventType | '*', Set<Handler>>();
let status: LiveStatus = 'idle';
const statusListeners = new Set<() => void>();

export const liveEvents = {
  /** Subscribe to one event type, or '*' for all. Returns the unsubscribe function. */
  subscribe(type: LiveEventType | '*', handler: Handler): () => void {
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  },
  emit(event: LiveEvent): void {
    for (const h of handlers.get(event.type) ?? []) safe(h, event);
    for (const h of handlers.get('*') ?? []) safe(h, event);
  },
  getStatus: (): LiveStatus => status,
  setStatus(next: LiveStatus): void {
    status = next;
    statusListeners.forEach((l) => l());
  },
  subscribeStatus(fn: () => void): () => void {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
  },
};

function safe(h: Handler, e: LiveEvent): void {
  try {
    h(e);
  } catch (err) {
    console.error('live event handler failed', err);
  }
}
