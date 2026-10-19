// One EventSource with reconnect + exponential backoff and Last-Event-ID resume. Framework-free.
import { STREAM_EVENT_TYPES, parseLiveEvent, type LiveEvent } from './eventMap';

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
  onerror: ((ev: Event) => unknown) | null;
  onopen: ((ev: Event) => unknown) | null;
}

export interface ConnectionOptions {
  /** Returns the stream URL, or null when there is no valid token (the connection then stops). */
  url: (lastEventId: string | null) => string | null;
  onEvent: (event: LiveEvent) => void;
  onStatus?: (status: LiveStatus) => void;
  /** Called on 'ready' after a reconnect (not the first connect). */
  onResync?: () => void;
  /** No valid token any more. */
  onAuthLost?: () => void;
  createEventSource?: (url: string) => EventSourceLike;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

export class EventStreamConnection {
  private es: EventSourceLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private everOpened = false;
  private stopped = true;
  private lastEventId: string | null = null;
  status: LiveStatus = 'idle';

  constructor(private readonly opts: ConnectionOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.es?.close();
    this.es = null;
    this.setStatus('closed');
  }

  /** Reconnect now (e.g. the browser came back online). */
  retryNow(): void {
    if (this.stopped || this.status === 'open') return;
    this.clearTimer();
    this.connect();
  }

  get resumeId(): string | null {
    return this.lastEventId;
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.opts.createEventSource && typeof EventSource === 'undefined') {
      this.setStatus('closed');
      return;
    }
    const url = this.opts.url(this.lastEventId);
    if (!url) {
      this.stop();
      this.opts.onAuthLost?.();
      return;
    }
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting');
    const create = this.opts.createEventSource ?? ((u: string) => new EventSource(u));
    const es = create(url);
    this.es = es;

    for (const type of STREAM_EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        const m = ev as MessageEvent<string>;
        if (m.lastEventId) this.lastEventId = m.lastEventId;
        const parsed = parseLiveEvent(type, m.lastEventId ?? '', m.data);
        if (parsed) this.opts.onEvent(parsed);
      });
    }
    es.addEventListener('ready', (ev) => {
      const wasReconnect = this.everOpened;
      this.attempts = 0;
      this.everOpened = true;
      try {
        const id = (JSON.parse((ev as MessageEvent<string>).data) as { lastEventId?: string }).lastEventId;
        if (id && !this.lastEventId) this.lastEventId = id;
      } catch {
        /* ignore */
      }
      this.setStatus('open');
      if (wasReconnect) this.opts.onResync?.();
    });
    es.onopen = () => {
      if (this.everOpened) this.setStatus('open');
    };
    es.onerror = () => {
      // The browser would retry on its own without backoff (and never after an HTTP error): take over.
      es.close();
      if (this.es !== es || this.stopped) return;
      this.es = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const base = this.opts.baseDelayMs ?? 1000;
    const max = this.opts.maxDelayMs ?? 30_000;
    const exp = Math.min(max, base * 2 ** this.attempts);
    const delay = Math.round(exp * (0.5 + (this.opts.random ?? Math.random)() * 0.5));
    this.attempts++;
    this.setStatus('reconnecting');
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setStatus(s: LiveStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }
}
