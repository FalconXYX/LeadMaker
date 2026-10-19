import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level = process.env.LOG_LEVEL || 'info'): Logger {
  return pino({ name: 'query', level });
}
