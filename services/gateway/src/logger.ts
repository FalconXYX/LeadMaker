import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A client-supplied X-Request-Id is kept only when it is short and plain; otherwise a new one is minted. */
export function requestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
}

/** Drops credentials from logged URLs (EventSource passes the JWT as ?access_token=). */
export function redactUrl(url: string): string {
  return url.replace(/([?&]access_token=)[^&]*/g, '$1[redacted]');
}

export function requestLogger(log: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    req.id = requestId(req.headers['x-request-id']);
    req.log = log.child({ reqId: req.id });
    res.setHeader('X-Request-Id', req.id);
    res.on('close', () => {
      req.log.info({
        method: req.method,
        url: redactUrl(req.originalUrl),
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
        userId: req.user?.id,
        aborted: !res.writableFinished || undefined,
      }, 'request');
    });
    next();
  };
}
