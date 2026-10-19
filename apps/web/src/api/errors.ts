import type { UserRef } from './types';

/** Any non-2xx response. `code` is the body's `error` string (e.g. 'invalid_filter', 'rate_limited'). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly body: unknown;

  constructor(status: number, code: string, body?: unknown, message?: string) {
    super(message ?? describe(status, code));
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.details = isRecord(body) ? body.details : undefined;
  }
}

/** 401: missing, invalid or expired token. The client logs out on this. */
export class UnauthorizedError extends ApiError {
  constructor(code = 'unauthenticated', body?: unknown) {
    super(401, code, body, 'Your session has expired. Please sign in again.');
    this.name = 'UnauthorizedError';
  }
}

/** 403: e.g. a rep writing to an unallocated lead, or a non-manager allocating. */
export class ForbiddenError extends ApiError {
  constructor(code = 'forbidden', body?: unknown) {
    super(403, code, body, "You don't have permission to do that.");
    this.name = 'ForbiddenError';
  }
}

/** 404: missing, or invisible to this user (the API does not distinguish). */
export class NotFoundError extends ApiError {
  constructor(code = 'not_found', body?: unknown) {
    super(404, code, body, 'Not found, or you no longer have access.');
    this.name = 'NotFoundError';
  }
}

/** 409: optimistic-lock failure. `current` is the server's value; refresh and let the user retry. */
export class VersionConflictError extends ApiError {
  readonly current: unknown;
  readonly changedBy: UserRef | null;
  readonly changedAt: string | null;

  constructor(body: unknown) {
    const b = isRecord(body) ? body : {};
    const changedBy = isRecord(b.changedBy) ? (b.changedBy as unknown as UserRef) : null;
    super(409, typeof b.error === 'string' ? b.error : 'version_conflict', body,
      changedBy ? `${changedBy.name} changed this while you were editing.` : 'Someone else changed this while you were editing.');
    this.name = 'VersionConflictError';
    this.current = b.current;
    this.changedBy = changedBy;
    this.changedAt = typeof b.changedAt === 'string' ? b.changedAt : null;
  }
}

/** 429: per-user rate limit (or too many open event streams). */
export class RateLimitedError extends ApiError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, code = 'rate_limited', body?: unknown) {
    super(429, code, body, `Too many requests. Try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 503: the service shed load (query service 'busy'); the client already retried idempotent requests. */
export class ServiceBusyError extends ApiError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, code = 'busy', body?: unknown) {
    super(503, code, body, 'The server is busy. Please try again in a moment.');
    this.name = 'ServiceBusyError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** fetch itself failed (offline, DNS, CORS, aborted by timeout). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Network error. Check your connection.', { cause });
    this.name = 'NetworkError';
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Retry-After (seconds or HTTP date) or a body `retryAfterMs`, in ms. */
export function retryAfterMs(headers: Headers, body: unknown, fallbackMs: number): number {
  if (isRecord(body) && typeof body.retryAfterMs === 'number' && body.retryAfterMs >= 0) return body.retryAfterMs;
  const h = headers.get('Retry-After');
  if (h) {
    const s = Number(h);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
    const at = Date.parse(h);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return fallbackMs;
}

/** Maps a failed response to the typed error. */
export function toApiError(status: number, headers: Headers, body: unknown): ApiError {
  const code = isRecord(body) && typeof body.error === 'string' ? body.error : `http_${status}`;
  switch (status) {
    case 401: return new UnauthorizedError(code, body);
    case 403: return new ForbiddenError(code, body);
    case 404: return new NotFoundError(code, body);
    case 409: return new VersionConflictError(body);
    case 429: return new RateLimitedError(retryAfterMs(headers, body, 5000), code, body);
    case 503: return new ServiceBusyError(retryAfterMs(headers, body, 1000), code, body);
    default: return new ApiError(status, code, body);
  }
}

/** A short, user-facing message for any thrown value (toasts, inline errors). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

function describe(status: number, code: string): string {
  if (status === 400) return code === 'invalid_filter' ? 'That filter is not valid.' : 'The request was not valid.';
  if (status === 413) return 'That is too large to send.';
  if (status === 502 || status === 504) return 'The server did not respond. Please try again.';
  if (status >= 500) return 'Something went wrong on the server.';
  return `Request failed (${status} ${code}).`;
}
