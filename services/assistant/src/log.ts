// pino logger whose every object and message passes through the Redactor (no key can reach a log line). Logs
// never contain message or context text (§7.11.6): the per-request line carries ids, counts and codes only.
import { pino, type Logger } from 'pino';
import type { Redactor } from './redact.ts';

export type { Logger };

export function createLogger(level: string, redactor: Redactor, destination?: pino.DestinationStream): Logger {
  const opts: pino.LoggerOptions = {
    level,
    base: { service: 'assistant' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => redactor.value(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((a) => (typeof a === 'string' ? redactor.text(a) : a)) as Parameters<typeof method>);
      },
    },
    serializers: { err: (e: unknown) => redactor.value(e) },
  };
  return destination ? pino(opts, destination) : pino(opts);
}
