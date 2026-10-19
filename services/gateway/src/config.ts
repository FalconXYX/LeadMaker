import { EVENTS_STREAM, limitsFromEnv, USER_ROLE_TTL_SECONDS, type Limits } from '@leadmaker/shared';

export const DEV_JWT_SECRET = 'dev-jwt-secret-change-me';
const DEV_INTERNAL_TOKEN = 'dev-internal-token-change-me';

export type Config = {
  port: number;
  jwtSecret: string;
  jwtTtl: string;
  internalToken: string;
  demoMode: boolean;
  queryUrl: string;
  crmWriteUrl: string;
  notifierUrl: string;
  /** The on-demand AI service (/api/assistant/*). The gateway works without it: its routes then answer 502. */
  assistantUrl: string;
  redisUrl: string;
  rateLimitPerSecond: number;
  rateLimitBurst: number;
  eventsStream: string;
  sseMaxPerUser: number;
  sseHeartbeatMs: number;
  /** users.role is cached this long per user, so a role change or deletion takes effect within it. */
  roleTtlSeconds: number;
  /** How often an open SSE stream re-reads its user's role. */
  sseRoleCheckMs: number;
  upstreamTimeoutMs: number;
  /** Deadline for /api/assistant/* (an answer streams for up to the assistant's own 60 s request deadline). */
  assistantTimeoutMs: number;
  maxBodyBytes: number;
  /** crm-write's request limits, read from the same environment variables, for GET /api/config. */
  limits: Limits;
  logLevel: string;
};

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid number: ${v}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const required = (name: string, devDefault: string): string => {
    const v = env[name];
    if (v) return v;
    if (production) throw new Error(`${name} is not set`);
    return devDefault;
  };
  return {
    port: num(env.PORT, 8080),
    jwtSecret: required('JWT_SECRET', DEV_JWT_SECRET),
    jwtTtl: env.JWT_TTL || '12h',
    internalToken: required('INTERNAL_TOKEN', DEV_INTERNAL_TOKEN),
    demoMode: env.DEMO_MODE === '1' || env.DEMO_MODE === 'true',
    queryUrl: env.QUERY_URL || 'http://localhost:8081',
    crmWriteUrl: env.CRM_WRITE_URL || 'http://localhost:8082',
    notifierUrl: env.NOTIFIER_URL || 'http://localhost:8084',
    assistantUrl: env.ASSISTANT_URL || 'http://localhost:8085',
    redisUrl: env.REDIS_URL || 'redis://localhost:56379',
    rateLimitPerSecond: num(env.RATE_LIMIT_PER_SECOND, 10),
    rateLimitBurst: num(env.RATE_LIMIT_BURST, 40),
    eventsStream: env.EVENTS_STREAM || EVENTS_STREAM,
    sseMaxPerUser: num(env.SSE_MAX_CONNECTIONS_PER_USER, 5),
    sseHeartbeatMs: num(env.SSE_HEARTBEAT_MS, 15_000),
    roleTtlSeconds: num(env.USER_ROLE_TTL_SECONDS, USER_ROLE_TTL_SECONDS),
    sseRoleCheckMs: num(env.SSE_ROLE_CHECK_MS, 10_000),
    upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 5000),
    assistantTimeoutMs: num(env.ASSISTANT_TIMEOUT_MS, 90_000),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 1_048_576),
    limits: limitsFromEnv(env),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
