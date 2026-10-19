// The chat stream's wire format (§7.2): `: ok` first (flushes headers through the gateway), `: ping` every 10 s,
// one `event: <type>\ndata: <one-line JSON>` block per event, and exactly one terminal event (done or error) before
// the response ends. Events after the terminal one, or after the client went away, are dropped.
import type { ServerResponse } from 'node:http';
import type { AssistantEvent } from '@leadmaker/shared';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
  Connection: 'keep-alive',
} as const;

/** One SSE block for an event (data is the event minus its type, as one line of JSON). */
export function formatEvent(e: AssistantEvent): string {
  const { type, ...payload } = e;
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export class SseWriter {
  readonly #res: ServerResponse;
  readonly #pingMs: number;
  #timer: NodeJS.Timeout | null = null;
  #terminal = false;
  #closed = false;

  constructor(res: ServerResponse, pingMs = 10_000) {
    this.#res = res;
    this.#pingMs = pingMs;
    res.on('close', () => {
      this.#closed = true;
      this.#stopPing();
    });
  }

  /** 200 + headers, then `: ok`. */
  open(headers: Record<string, string> = {}): void {
    this.#res.writeHead(200, { ...SSE_HEADERS, ...headers });
    this.#res.flushHeaders();
    this.#res.socket?.setNoDelay(true);
    this.#write(': ok\n\n');
    if (this.#pingMs > 0) {
      this.#timer = setInterval(() => this.ping(), this.#pingMs);
      this.#timer.unref();
    }
  }

  get terminated(): boolean {
    return this.#terminal;
  }

  get closed(): boolean {
    return this.#closed || this.#res.destroyed || this.#res.writableEnded;
  }

  event(e: AssistantEvent): boolean {
    if (this.#terminal || this.closed) return false;
    if (e.type === 'done' || e.type === 'error') this.#terminal = true;
    return this.#write(formatEvent(e));
  }

  ping(): void {
    if (!this.#terminal && !this.closed) this.#write(': ping\n\n');
  }

  /** Ends the response (after the terminal event, if one was written). */
  close(): void {
    this.#stopPing();
    if (!this.closed) this.#res.end();
  }

  #write(chunk: string): boolean {
    if (this.closed) return false;
    try {
      this.#res.write(chunk);
      return true;
    } catch {
      return false;
    }
  }

  #stopPing(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
