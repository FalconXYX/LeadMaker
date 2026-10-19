// HTTP client to the query service. Every call carries the requesting user's identity (x-user-id / x-user-role +
// the internal token), so query applies the same visibility rule as for the user's own page loads: the assistant
// can never read a lead the user can't view. 3 s timeout per call.
import {
  HEADER_INTERNAL_TOKEN, HEADER_USER_ID, HEADER_USER_ROLE, type FilterVocabulary, type LeadAiContext, type LeadFilter,
  type LeadSearchResult, type Viewer,
} from '@leadmaker/shared';
import type { FetchLike } from './llm/http.ts';

export interface QueryClient {
  /** null = 404 (missing or not visible to this viewer). */
  aiContext(viewer: Viewer, leadId: string, signal?: AbortSignal): Promise<LeadAiContext | null>;
  vocabulary(viewer: Viewer, signal?: AbortSignal): Promise<FilterVocabulary>;
  search(viewer: Viewer, filter: LeadFilter, signal?: AbortSignal): Promise<LeadSearchResult>;
}

/** Query unreachable, timed out, or answered with an unexpected status. */
export class QueryError extends Error {
  status: number | null;
  timeout: boolean;

  constructor(message: string, status: number | null, timeout = false) {
    super(message);
    this.name = 'QueryError';
    this.status = status;
    this.timeout = timeout;
  }
}

/** Per-user vocabulary, 60 s (the query service caches it for 300 s too; this saves the hop). */
export class VocabularyCache {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #entries = new Map<string, { at: number; value: FilterVocabulary }>();

  constructor(ttlMs = 60_000, max = 1000) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  get(key: string, now = Date.now()): FilterVocabulary | undefined {
    const e = this.#entries.get(key);
    if (!e) return undefined;
    if (now - e.at > this.#ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: FilterVocabulary, now = Date.now()): void {
    this.#entries.delete(key);
    this.#entries.set(key, { at: now, value });
    while (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value!);
  }
}

export interface HttpQueryClientOptions {
  baseUrl: string;
  internalToken: string;
  timeoutMs: number;
  requestId?: string;
  vocabCache?: VocabularyCache;
  fetch?: FetchLike;
}

export class HttpQueryClient implements QueryClient {
  readonly #o: HttpQueryClientOptions;
  readonly #fetch: FetchLike;

  constructor(opts: HttpQueryClientOptions) {
    this.#o = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The same client for another request id (log correlation). */
  forRequest(requestId: string): HttpQueryClient {
    return new HttpQueryClient({ ...this.#o, requestId, fetch: this.#fetch });
  }

  async #call(viewer: Viewer, method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(this.#o.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      accept: 'application/json',
      [HEADER_INTERNAL_TOKEN]: this.#o.internalToken,
      [HEADER_USER_ID]: viewer.id,
      [HEADER_USER_ROLE]: viewer.role,
    };
    if (this.#o.requestId) headers['x-request-id'] = this.#o.requestId;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch(`${this.#o.baseUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (timeout.aborted) throw new QueryError(`query ${method} ${path.split('?')[0]} timed out`, null, true);
      throw new QueryError(`query unreachable: ${(err as Error)?.message ?? String(err)}`, null);
    }
    let json: unknown = null;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (timeout.aborted) throw new QueryError(`query ${method} ${path.split('?')[0]} timed out`, null, true);
      json = null;
    }
    return { status: res.status, json };
  }

  async aiContext(viewer: Viewer, leadId: string, signal?: AbortSignal): Promise<LeadAiContext | null> {
    const r = await this.#call(viewer, 'GET', `/leads/${encodeURIComponent(leadId)}/ai-context`, undefined, signal);
    if (r.status === 404 || r.status === 400) return null;
    if (r.status !== 200 || !r.json) throw new QueryError(`query ai-context answered ${r.status}`, r.status);
    return r.json as LeadAiContext;
  }

  async vocabulary(viewer: Viewer, signal?: AbortSignal): Promise<FilterVocabulary> {
    const key = `${viewer.role}:${viewer.id}`;
    const hit = this.#o.vocabCache?.get(key);
    if (hit) return hit;
    const r = await this.#call(viewer, 'GET', '/filter-vocabulary', undefined, signal);
    if (r.status !== 200 || !r.json) throw new QueryError(`query filter-vocabulary answered ${r.status}`, r.status);
    const vocab = r.json as FilterVocabulary;
    this.#o.vocabCache?.set(key, vocab);
    return vocab;
  }

  async search(viewer: Viewer, filter: LeadFilter, signal?: AbortSignal): Promise<LeadSearchResult> {
    const r = await this.#call(viewer, 'POST', '/leads/search', { filter }, signal);
    if (r.status !== 200 || !r.json) throw new QueryError(`query leads/search answered ${r.status}`, r.status);
    return r.json as LeadSearchResult;
  }
}
