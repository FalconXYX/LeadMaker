import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level = process.env.LOG_LEVEL || 'info'): Logger {
  return pino({
    level,
    base: { service: 'notifier' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
