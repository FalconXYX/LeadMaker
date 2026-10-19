import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { isUuid } from '@leadmaker/shared';

/** An error response in the shared ApiError shape ({error, details?}); 409s use VersionConflict. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    super(String(body.error ?? status));
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

const apiError = (status: number, error: string, details?: unknown) =>
  new HttpError(status, details === undefined ? { error } : { error, details });

export const badRequest = (error: string, details?: unknown) => apiError(400, error, details);
export const unauthorized = (details?: string) => apiError(401, 'unauthorized', details);
export const forbidden = (details: string) => apiError(403, 'forbidden', details);
export const notFound = (error = 'not_found', details?: unknown) => apiError(404, error, details);

export { isUuid };
export const uuid = z.string().refine(isUuid, 'must be a uuid').transform((s) => s.toLowerCase());

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw badRequest('invalid_request', {
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** Postgres SQLSTATE of a Prisma (adapter-pg) error. */
export function pgCode(e: unknown): string | undefined {
  return (e as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } })
    ?.meta?.driverAdapterError?.cause?.originalCode;
}

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).set(err.headers).json(err.body);
      return;
    }
    const type = (err as { type?: string })?.type;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    log.error({ err, method: req.method, url: req.originalUrl }, 'request failed');
    res.status(500).json({ error: 'internal_error' });
  };
}
