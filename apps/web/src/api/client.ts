import { ApiError, NetworkError, ServiceBusyError, UnauthorizedError, toApiError } from './errors';

export * from './errors';

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /** Retries on 503 busy; default 2 for GET, 0 otherwise (writes are not idempotent). */
  busyRetries?: number;
  /** Skip the bearer token and the global 401 handler (login). */
  anonymous?: boolean;
}

interface ClientConfig {
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized: (err: UnauthorizedError) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const config: ClientConfig = {
  baseUrl: '',
  getToken: () => null,
  onUnauthorized: () => {},
  sleep: abortableSleep,
};

/** Wired once by AuthProvider (token source + logout on 401); tests may override `sleep`. */
export function configureApiClient(patch: Partial<ClientConfig>): void {
  Object.assign(config, patch);
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${config.baseUrl}${path}${s ? `?${s}` : ''}`;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const retries = opts.busyRetries ?? (method === 'GET' ? 2 : 0);
  for (let attempt = 0; ; attempt++) {
    try {
      return await once<T>(method, path, opts);
    } catch (err) {
      if (err instanceof ServiceBusyError && attempt < retries) {
        await config.sleep(Math.min(err.retryAfterMs || 500, 5000) * (attempt + 1), opts.signal);
        continue;
      }
      if (err instanceof UnauthorizedError && !opts.anonymous) config.onUnauthorized(err);
      throw err;
    }
  }
}

async function once<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = opts.anonymous ? null : config.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new NetworkError(err);
  }

  const body = await readBody(res);
  if (!res.ok) throw toApiError(res.status, res.headers, body);
  return body as T;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  if ((res.headers.get('Content-Type') ?? '').includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'body'>) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
};

/** For TanStack Query's `retry`: never retry 4xx (they will not change), retry network/5xx twice. */
export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status < 500) return false;
  return failureCount < 2;
}
