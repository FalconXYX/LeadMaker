import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, ForbiddenError, NetworkError, NotFoundError, RateLimitedError, ServiceBusyError, UnauthorizedError,
  VersionConflictError, api, configureApiClient,
} from '@/api/client';
import { clearLeadOverride, searchLeads } from '@/api/endpoints';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
const onUnauthorized = vi.fn();
const sleep = vi.fn(async () => {});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  onUnauthorized.mockReset();
  sleep.mockClear();
  configureApiClient({ getToken: () => 'tok-123', onUnauthorized, sleep });
});
afterEach(() => vi.unstubAllGlobals());

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the request to fail');
}

describe('api client', () => {
  it('sends the bearer token and JSON body, and parses the response', async () => {
    fetchMock.mockResolvedValue(json(200, { items: [], nextCursor: null, total: 0, totalCapped: false }));
    const res = await searchLeads({ scope: 'mine' });
    expect(res.total).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/leads/search');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(init.body)).toEqual({ filter: { scope: 'mine' } });
  });

  it('maps 409 to VersionConflictError with current, changedBy and changedAt', async () => {
    fetchMock.mockResolvedValue(json(409, {
      error: 'version_conflict', current: { value: '555-0100', version: 7 },
      changedBy: { id: 'u2', name: 'Sam Rivera' }, changedAt: '2026-10-18T10:00:00Z',
    }));
    const err = await failure(api.put('/api/leads/1/overrides/phone', { value: 'x', version: 6 }));
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err).toBeInstanceOf(ApiError);
    const c = err as VersionConflictError;
    expect(c.status).toBe(409);
    expect(c.current).toEqual({ value: '555-0100', version: 7 });
    expect(c.changedBy?.name).toBe('Sam Rivera');
    expect(c.changedAt).toBe('2026-10-18T10:00:00Z');
    expect(c.message).toMatch(/Sam Rivera/);
  });

  it('maps 403 and 404', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: 'forbidden' }));
    expect(await failure(api.post('/api/leads/1/notes', { text: 'hi' }))).toBeInstanceOf(ForbiddenError);
    fetchMock.mockResolvedValueOnce(json(404, { error: 'not_found' }));
    const nf = await failure(api.get('/api/leads/nope'));
    expect(nf).toBeInstanceOf(NotFoundError);
    expect((nf as NotFoundError).code).toBe('not_found');
  });

  it('maps 429 with Retry-After seconds, preferring the body retryAfterMs', async () => {
    fetchMock.mockResolvedValueOnce(json(429, { error: 'rate_limited' }, { 'Retry-After': '3' }));
    const a = await failure(api.post('/api/refresh', {}));
    expect(a).toBeInstanceOf(RateLimitedError);
    expect((a as RateLimitedError).retryAfterMs).toBe(3000);

    fetchMock.mockResolvedValueOnce(json(429, { error: 'rate_limited', retryAfterMs: 1500 }, { 'Retry-After': '9' }));
    expect(((await failure(api.get('/api/kpis'))) as RateLimitedError).retryAfterMs).toBe(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries GETs on 503 busy, honouring Retry-After, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(json(503, { error: 'busy' }, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(json(200, { mine: { allocated: 1 } }));
    const res = await api.get<{ mine: { allocated: number } }>('/api/kpis');
    expect(res.mine.allocated).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
  });

  it('gives up after the retries with ServiceBusyError, and never retries non-idempotent writes', async () => {
    fetchMock.mockImplementation(async () => json(503, { error: 'busy' }, { 'Retry-After': '1' }));
    expect(await failure(api.get('/api/kpis'))).toBeInstanceOf(ServiceBusyError);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockClear();
    expect(await failure(api.post('/api/leads/1/notes', { text: 'x' }))).toBeInstanceOf(ServiceBusyError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls the unauthorized handler on 401 except for anonymous requests', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'invalid_token' }));
    expect(await failure(api.get('/api/me'))).toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json(401, { error: 'unknown_user' }));
    const err = await failure(api.post('/auth/dev-login', { email: 'x' }, { anonymous: true }));
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBeUndefined();
  });

  it('wraps fetch failures in NetworkError and other statuses in ApiError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await failure(api.get('/api/kpis'))).toBeInstanceOf(NetworkError);
    fetchMock.mockResolvedValueOnce(json(400, { error: 'invalid_filter', details: { x: 1 } }));
    const e = (await failure(api.post('/api/leads/search', {}))) as ApiError;
    expect(e.constructor).toBe(ApiError);
    expect(e.code).toBe('invalid_filter');
    expect(e.details).toEqual({ x: 1 });
  });

  it('puts the version in the query string when clearing an override', async () => {
    fetchMock.mockResolvedValue(json(200, { field: 'phone', version: 8 }));
    await clearLeadOverride('lead-1', 'phone', 7);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/leads/lead-1/overrides/phone?version=7');
    expect(fetchMock.mock.calls[0]![1].method).toBe('DELETE');
  });
});
