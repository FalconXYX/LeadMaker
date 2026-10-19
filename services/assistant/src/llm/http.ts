// The one HTTP call every provider makes: POST JSON, get a streaming body. Network failures become LlmApiError
// (retryable), an aborted signal is re-thrown as is (the engine decides between timeout and client gone), and a
// non-2xx response is handed to the provider's classifier with its parsed body.
import { LlmApiError, type LlmError } from './types.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ErrorResponse { status: number; headers: Headers; body: unknown; text: string }

export async function postStream(
  fetchImpl: FetchLike, provider: string, url: string, headers: Record<string, string>, body: unknown,
  signal: AbortSignal, classify: (r: ErrorResponse) => LlmError,
): Promise<ReadableStream<Uint8Array>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw signal.reason ?? err;
    // The cause can carry the request (and its headers) in some runtimes: keep only the message.
    throw new LlmApiError(`network error: ${(err as Error)?.message ?? String(err)}`, { provider });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    throw classify({ status: res.status, headers: res.headers, body: parsed, text: text.slice(0, 2000) });
  }
  if (!res.body) throw new LlmApiError(`empty response body (HTTP ${res.status})`, { provider, status: res.status });
  return res.body;
}

/** Retry-After header (seconds or an HTTP date) in ms, or null. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const v = headers.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000));
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
