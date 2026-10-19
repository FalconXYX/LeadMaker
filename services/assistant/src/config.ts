// Assistant service configuration (§7.10, §12). Provider selection and keys are read by createProvider (llm/index.ts);
// nothing here ever holds or logs a key.
import { DEV_INTERNAL_TOKEN, internalToken } from '@leadmaker/shared';
import { DEFAULT_FALLBACKS, resolveProviderName } from './llm/index.ts';

/** A fallback model of the same provider and its own daily budget (0 = the primary's providerRpd). */
export interface FallbackModel { model: string; rpd: number }

export interface Config {
  port: number;
  queryUrl: string;
  redisUrl: string;
  internalToken: string;
  logLevel: string;
  maxBodyBytes: number;
  /**
   * Per user: the minute bucket, concurrent streams, requests a day, tokens a day, and provider calls a day (one
   * request can make up to maxToolRounds calls; this is the user's share of the team's provider budget).
   */
  user: { perMinute: number; burst: number; maxStreams: number; perDay: number; tokensPerDay: number; callsPerDay: number };
  /** Concurrent streams per instance (503 busy beyond). */
  maxStreams: number;
  /**
   * Global provider budget of the primary model; 0 = off. Defaults: Gemini 8 RPM / 100 RPD (the assistant's share of
   * gemini-3.5-flash-lite's free day; the worker's batch has its own 150), paid providers 120 RPM / 5,000 RPD as a
   * cost ceiling, the fake none.
   */
  providerRpm: number;
  providerRpd: number;
  /** LEADMAKER_ASSISTANT_FALLBACK_MODELS="model[:rpd],...": tried in order when the primary's day is spent. */
  fallbackModels: FallbackModel[];
  queryTimeoutMs: number;
  providerTimeoutMs: number;
  requestTimeoutMs: number;
  maxToolRounds: number;
  maxOutputTokens: number;
  pingMs: number;
  /** In-flight streams get this long after SIGTERM before they are aborted. */
  shutdownGraceMs: number;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, { min = 0 }: { min?: number } = {}): number {
  const v = env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min}`);
  return n;
}

/** "gemini-3.8-flash:20, gemini-3.6-flash" -> [{model, rpd}] (rpd 0 = the primary's). */
export function parseFallbackModels(raw: string | undefined): FallbackModel[] {
  const out: FallbackModel[] = [];
  for (const part of (raw ?? '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const m = /^([A-Za-z0-9._\/-]{1,100})(?::(\d{1,7}))?$/.exec(item);
    if (!m) throw new Error(`LEADMAKER_ASSISTANT_FALLBACK_MODELS: "${item.slice(0, 60)}" is not model[:requests per day]`);
    if (!out.some((f) => f.model === m[1])) out.push({ model: m[1]!, rpd: m[2] ? Number(m[2]) : 0 });
  }
  return out;
}

/** Fair share: with a global day budget, one user may make at most a quarter of its calls (minimum 6). */
export const FAIR_SHARE_USERS = 4;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let provider: string | null = null;
  try {
    provider = resolveProviderName(env);
  } catch {
    provider = null; // reported as not configured; index.ts logs why
  }
  const gemini = provider === 'gemini';
  const paid = provider === 'anthropic' || provider === 'openai_compat';
  const providerRpd = num(env, 'LEADMAKER_ASSISTANT_RPD', gemini ? 100 : paid ? 5000 : 0);
  const rawFallbacks = env.LEADMAKER_ASSISTANT_FALLBACK_MODELS?.trim() || (provider ? DEFAULT_FALLBACKS[provider as keyof typeof DEFAULT_FALLBACKS] : '');
  const fallbackModels = provider && provider !== 'fake' && rawFallbacks.toLowerCase() !== 'none' ? parseFallbackModels(rawFallbacks) : [];
  const totalRpd = providerRpd > 0 ? providerRpd + fallbackModels.reduce((n, f) => n + (f.rpd || providerRpd), 0) : 0;
  const perMinute = num(env, 'ASSISTANT_USER_PER_MINUTE', 6, { min: 1 });
  return {
    port: num(env, 'PORT', 8085, { min: 1 }),
    queryUrl: env.QUERY_URL || 'http://localhost:8081',
    redisUrl: env.REDIS_URL || 'redis://localhost:56379',
    internalToken: internalToken(env),
    logLevel: env.LOG_LEVEL || 'info',
    maxBodyBytes: 65_536,
    user: {
      perMinute,
      // The bucket's capacity: by default the per-minute count, so the 7th request within a minute is refused.
      burst: num(env, 'ASSISTANT_USER_BURST', perMinute, { min: 1 }),
      maxStreams: num(env, 'ASSISTANT_USER_MAX_STREAMS', 2, { min: 1 }),
      perDay: num(env, 'ASSISTANT_USER_PER_DAY', 150, { min: 1 }),
      tokensPerDay: num(env, 'ASSISTANT_USER_TOKENS_PER_DAY', 300_000, { min: 1 }),
      callsPerDay: num(env, 'ASSISTANT_USER_LLM_CALLS_PER_DAY',
        totalRpd > 0 ? Math.max(6, Math.floor(totalRpd / FAIR_SHARE_USERS)) : 300, { min: 1 }),
    },
    maxStreams: num(env, 'ASSISTANT_MAX_STREAMS', 100, { min: 1 }),
    providerRpm: num(env, 'LEADMAKER_ASSISTANT_RPM', gemini ? 8 : paid ? 120 : 0),
    providerRpd,
    fallbackModels,
    queryTimeoutMs: num(env, 'ASSISTANT_QUERY_TIMEOUT_MS', 3000, { min: 1 }),
    providerTimeoutMs: num(env, 'ASSISTANT_PROVIDER_TIMEOUT_MS', 30_000, { min: 1 }),
    requestTimeoutMs: num(env, 'ASSISTANT_REQUEST_TIMEOUT_MS', 60_000, { min: 1 }),
    maxToolRounds: num(env, 'ASSISTANT_MAX_TOOL_ROUNDS', 3, { min: 1 }),
    maxOutputTokens: num(env, 'ASSISTANT_MAX_OUTPUT_TOKENS', 2048, { min: 64 }),
    pingMs: num(env, 'ASSISTANT_SSE_PING_MS', 10_000, { min: 0 }),
    shutdownGraceMs: num(env, 'ASSISTANT_SHUTDOWN_GRACE_MS', 5000, { min: 0 }),
  };
}

/** Configuration that works but defeats a limit: logged as warnings at startup. */
export function configWarnings(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const totalRpd = config.providerRpd > 0
    ? config.providerRpd + config.fallbackModels.reduce((n, f) => n + (f.rpd || config.providerRpd), 0) : 0;
  if (totalRpd > 0 && config.user.callsPerDay >= totalRpd) {
    out.push(`ASSISTANT_USER_LLM_CALLS_PER_DAY (${config.user.callsPerDay}) is not below the provider day budget `
      + `(${totalRpd}): one user can spend the whole team's AI day`);
  }
  if (env.NODE_ENV === 'production' && config.internalToken === DEV_INTERNAL_TOKEN) {
    out.push('INTERNAL_TOKEN is the public development default: set a secret INTERNAL_TOKEN for every service');
  }
  return out;
}
