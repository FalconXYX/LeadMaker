import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// Token bucket in one round trip, on Redis server time so every gateway replica shares one clock.
// Returns {allowed, tokens left (floored), ms until the next token}.
const TOKEN_BUCKET = `
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000)
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000)
return {allowed, math.floor(tokens), wait}
`;

export type RateDecision = { allowed: boolean; remaining: number; retryAfterMs: number };

export type RateLimiter = (key: string) => Promise<RateDecision>;

const TOKEN_BUCKET_SHA = createHash('sha1').update(TOKEN_BUCKET).digest('hex');

export function tokenBucket(redis: Redis, ratePerSecond: number, burst: number): RateLimiter {
  return async (key) => {
    let reply: unknown;
    try {
      reply = await redis.evalsha(TOKEN_BUCKET_SHA, 1, key, ratePerSecond, burst);
    } catch (err) {
      if (!String(err).includes('NOSCRIPT')) throw err;
      reply = await redis.eval(TOKEN_BUCKET, 1, key, ratePerSecond, burst);
    }
    const [allowed, remaining, wait] = reply as number[];
    return { allowed: allowed === 1, remaining, retryAfterMs: wait };
  };
}

/** 429 + Retry-After when the bucket is empty. Fails open if Redis is unreachable. */
export function rateLimit(limiter: RateLimiter, keyOf: (req: Request) => string, log: Logger) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let decision: RateDecision;
    try {
      decision = await limiter(keyOf(req));
    } catch (err) {
      log.warn({ err, reqId: req.id }, 'rate limiter unavailable; allowing request');
      next();
      return;
    }
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (decision.allowed) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
    res.status(429).json({ error: 'rate_limited', retryAfterMs: decision.retryAfterMs });
  };
}
