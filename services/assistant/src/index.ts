// The assistant service: on-demand AI (Section 4) behind the gateway at /api/assistant/*. Stateless; Redis holds
// the limits and the global provider budget. Shutdown: stop accepting, give in-flight streams the grace period,
// then abort them (each still ends with an `error` event) and exit.
import { Redis } from 'ioredis';
import { StreamRegistry, createApp, type ModelSlot } from './app.ts';
import { CircuitBreaker } from './circuit.ts';
import { configWarnings, loadConfig } from './config.ts';
import { FallbackStore, MemoryStore, ProviderBudgetLimiter, RedisStore, UserLimits, quotaDayTz } from './limits.ts';
import { createProvider, providerSetting, secretValues, type LlmProvider } from './llm/index.ts';
import { createLogger } from './log.ts';
import { HttpQueryClient, VocabularyCache } from './query-client.ts';
import { Redactor } from './redact.ts';

const config = loadConfig();
const redactor = new Redactor(secretValues());
const log = createLogger(config.logLevel, redactor);

let provider: LlmProvider | null = null;
try {
  provider = createProvider();
} catch (err) {
  log.error({ err, setting: providerSetting() }, 'invalid LLM provider setting; the assistant reports "not configured"');
}
const ready = provider?.isConfigured();
if (!provider) log.warn('no LLM provider configured: chat answers ai_not_configured (set GEMINI_API_KEY or LEADMAKER_LLM_PROVIDER)');
else if (ready && !ready.ok) log.warn({ provider: provider.name, reason: ready.reason }, 'LLM provider not configured');
else log.info({ provider: provider.name, model: provider.model, rpm: config.providerRpm, rpd: config.providerRpd, userCallsPerDay: config.user.callsPerDay }, 'LLM provider ready');

// Commands fail fast so a Redis outage falls back to in-memory counters instead of stalling requests.
const redis = new Redis(config.redisUrl, { commandTimeout: 500, maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
redis.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
const store = new FallbackStore(new RedisStore(redis), new MemoryStore(), log);

for (const warning of configWarnings(config)) log.warn(warning);

const budgetFor = (p: LlmProvider, rpd: number) =>
  new ProviderBudgetLimiter(store, p.fingerprint, { rpm: config.providerRpm, rpd, dayTz: quotaDayTz(p.name) });
// Fallback models: the same provider and key, another model (each Gemini free-tier model has its own daily quota).
const fallbacks: ModelSlot[] = [];
if (provider && ready?.ok) {
  for (const f of config.fallbackModels) {
    if (f.model === provider.model) continue;
    try {
      const p = createProvider({ ...process.env, LEADMAKER_ASSISTANT_LLM_MODEL: f.model });
      if (p && p.name === provider.name && p.isConfigured().ok) fallbacks.push({ provider: p, budget: budgetFor(p, f.rpd || config.providerRpd) });
    } catch (err) {
      log.warn({ err: (err as Error).message, model: f.model }, 'fallback model skipped');
    }
  }
  if (fallbacks.length) log.info({ models: fallbacks.map((f) => f.provider.model) }, 'fallback models ready');
}

const query = new HttpQueryClient({
  baseUrl: config.queryUrl, internalToken: config.internalToken, timeoutMs: config.queryTimeoutMs, vocabCache: new VocabularyCache(),
});
const streams = new StreamRegistry();
const app = createApp({
  config,
  log,
  provider,
  queryFor: (reqId) => query.forRequest(reqId),
  userLimits: new UserLimits(store, config.user),
  budget: provider ? budgetFor(provider, config.providerRpd) : null,
  fallbacks,
  circuit: new CircuitBreaker(),
  redisPing: () => redis.ping(),
}, streams);

const server = app.listen(config.port, () => log.info({ port: config.port }, 'assistant listening'));
server.keepAliveTimeout = 65_000;
// SSE answers can take a while; the gateway's deadline (ASSISTANT_TIMEOUT_MS) bounds them.
server.requestTimeout = 0;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  streams.shuttingDown = true;
  log.info({ signal, inFlight: streams.active.size }, 'shutting down');
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  const deadline = Date.now() + config.shutdownGraceMs;
  while (streams.active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (streams.active.size) {
    streams.abortAll(new Error('server shutting down'));
    await new Promise((r) => setTimeout(r, 250));
  }
  server.closeAllConnections();
  await closed;
  redis.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
