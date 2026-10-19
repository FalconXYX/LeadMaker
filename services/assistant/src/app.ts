// HTTP surface of the assistant (§7.2), behind the gateway at /api/assistant/* (internal token + the caller's
// identity headers). POST /chat answers as an SSE stream; GET /status reports availability without calling the model.
// Models: the primary, then any fallbacks (LEADMAKER_ASSISTANT_FALLBACK_MODELS), each with its own daily budget. A
// request starts on the first model whose day is not spent and moves to the next when that one's quota runs out
// before anything was shown; every call also counts against the user's own daily share (UserLimits.callBudget).
// Request-level problems are JSON before the stream opens (401, 413, 400, 429, 503, 404); once it is open, every
// failure is an `event: error` with server-written copy.
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ASSISTANT_PROMPT_VERSION, assistantChatRequestSchema, authenticateInternal, isUuid, type AssistantEvent, type AssistantStatus,
  type AssistantStatusReason, type LeadAiContext, type Viewer,
} from '@leadmaker/shared';
import type { CircuitBreaker } from './circuit.ts';
import type { Config } from './config.ts';
import { runAssistant, type EngineResult } from './engine.ts';
import { errorPayload } from './errors.ts';
import type { ProviderBudgetLimiter, UserLimits } from './limits.ts';
import type { LlmProvider } from './llm/types.ts';
import type { Logger } from './log.ts';
import type { QueryClient } from './query-client.ts';
import { SseWriter } from './sse.ts';

/** One model the assistant may answer with, and its global budget. */
export interface ModelSlot { provider: LlmProvider; budget: ProviderBudgetLimiter | null }

export interface AppDeps {
  config: Config;
  log: Logger;
  provider: LlmProvider | null;
  /** Tried in order after the primary (provider + budget) when its quota is spent. */
  fallbacks?: ModelSlot[];
  /** The query client for one request (carries its request id). */
  queryFor: (requestId: string) => QueryClient;
  userLimits: UserLimits;
  budget: ProviderBudgetLimiter | null;
  circuit: CircuitBreaker;
  now?: () => Date;
  /** Readiness probe of Redis (informational: limits fall back to memory without it). */
  redisPing?: () => Promise<unknown>;
}

/** In-flight chat streams, so shutdown can abort them after the grace period. */
export class StreamRegistry {
  readonly active = new Set<AbortController>();
  shuttingDown = false;

  abortAll(reason: unknown): void {
    for (const a of this.active) a.abort(reason);
  }
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function viewerOf(res: Response): Viewer {
  return res.locals.viewer as Viewer;
}

function retryAfter(res: Response, ms: number): void {
  res.set('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
}

export function createApp(deps: AppDeps, streams = new StreamRegistry()) {
  const { config, log, provider, userLimits, budget, circuit } = deps;
  const now = deps.now ?? (() => new Date());
  const slots: ModelSlot[] = [
    ...(provider ? [{ provider, budget }] : []),
    ...(deps.fallbacks ?? []).filter((f) => f.provider.isConfigured().ok),
  ];

  /** The configured slots whose day is not spent, in order, and the earliest reset among the spent ones. */
  async function openSlots(): Promise<{ open: ModelSlot[]; resetsAt: Date | null }> {
    const open: ModelSlot[] = [];
    let resetsAt: Date | null = null;
    for (const slot of slots) {
      if (!slot.provider.isConfigured().ok) continue;
      const until = await slot.budget?.exhaustedUntil().catch(() => null);
      if (until) {
        if (!resetsAt || until < resetsAt) resetsAt = until;
      } else {
        open.push(slot);
      }
    }
    return { open, resetsAt };
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    let redis = 'ok';
    try {
      await deps.redisPing?.();
    } catch {
      redis = 'down';
    }
    const configured = !!provider && provider.isConfigured().ok;
    res.status(streams.shuttingDown ? 503 : 200).json({ status: streams.shuttingDown ? 'stopping' : 'ok', redis, aiConfigured: configured });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    const auth = authenticateInternal(req.headers, config.internalToken);
    if (!auth.ok) return void res.status(auth.status).json({ error: auth.error });
    res.locals.viewer = auth.viewer;
    const header = req.headers['x-request-id'];
    res.locals.reqId = typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
    next();
  });

  api.get('/status', async (_req, res) => {
    const viewer = viewerOf(res);
    let reason: AssistantStatusReason = 'ok';
    let resetsAt: string | null = null;
    let current: LlmProvider | null = provider;
    if (!provider || !provider.isConfigured().ok) reason = 'not_configured';
    else {
      const { open, resetsAt: until } = await openSlots();
      if (!open.length) {
        reason = 'quota_exhausted';
        resetsAt = until?.toISOString() ?? null;
      } else {
        current = open[0]!.provider;
        if (circuit.isOpen()) reason = 'provider_down';
      }
    }
    const usedToday = await userLimits.usedToday(viewer.id, now()).catch(() => 0);
    const body: AssistantStatus = {
      available: reason === 'ok',
      reason,
      provider: current?.name ?? null,
      model: current?.model || null,
      resetsAt,
      limits: { perMinute: userLimits.cfg.perMinute, perDay: userLimits.cfg.perDay, usedToday },
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  api.post('/chat', express.json({ limit: config.maxBodyBytes }), async (req, res) => {
    const viewer = viewerOf(res);
    const reqId = res.locals.reqId as string;
    const parsed = assistantChatRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', message: 'invalid chat request', details: z.treeifyError(parsed.error) });
      return;
    }
    const request = parsed.data;

    const minute = await userLimits.minute(viewer.id).catch(() => ({ allowed: true, retryAfterMs: 0 }));
    if (!minute.allowed) {
      retryAfter(res, minute.retryAfterMs);
      res.status(429).json({ error: 'rate_limited', retryAfterMs: minute.retryAfterMs });
      return;
    }
    if (streams.shuttingDown || streams.active.size >= config.maxStreams) {
      res.set('Retry-After', '2').status(503).json({ error: 'busy', retryAfterMs: 2000 });
      return;
    }
    const slot = await userLimits.openStream(viewer.id).catch(() => ({ allowed: true, release: async () => {} }));
    if (!slot.allowed) {
      res.set('Retry-After', '2').status(429).json({ error: 'rate_limited', retryAfterMs: 2000 });
      return;
    }

    const abort = new AbortController();
    streams.active.add(abort);
    res.on('close', () => {
      if (!res.writableFinished) abort.abort(new Error('client closed the stream'));
    });
    const query = deps.queryFor(reqId);
    const t0 = performance.now();
    let result: EngineResult | null = null;
    let errorCode: string | undefined;
    let answeredBy: LlmProvider | null = provider;
    try {
      let leadContext: LeadAiContext | null = null;
      const leadId = request.context.leadId;
      if (leadId !== undefined) {
        if (!isUuid(leadId)) {
          res.status(404).json({ error: 'lead_not_found' });
          return;
        }
        try {
          leadContext = await query.aiContext(viewer, leadId.toLowerCase(), abort.signal);
        } catch (err) {
          if (abort.signal.aborted) return;
          log.warn({ reqId, err: (err as Error)?.message }, 'lead context unavailable');
          res.set('Retry-After', '2').status(503).json({ error: 'busy', retryAfterMs: 2000 });
          return;
        }
        if (!leadContext) {
          res.status(404).json({ error: 'lead_not_found' });
          return;
        }
      }

      const sse = new SseWriter(res, config.pingMs);
      sse.open();
      const at = now();
      const day = await userLimits.countRequest(viewer.id, at).catch(() => ({ requests: 0, over: false }));
      if (day.over) {
        errorCode = 'user_daily_limit';
        sse.event({ type: 'error', ...errorPayload('user_daily_limit', { dailyLimit: userLimits.cfg.perDay }) });
      } else {
        // The first model with quota left; the next one when its day runs out before anything was shown.
        const { open } = await openSlots();
        const candidates: (ModelSlot | null)[] = open.length ? open : [provider ? { provider, budget } : null];
        const usage = { inputTokens: 0, outputTokens: 0 };
        let llmCalls = 0;
        for (const [i, slot] of candidates.entries()) {
          const more = i < candidates.length - 1;
          let shown = false;
          let swallowed = false;
          const emit = (e: AssistantEvent) => {
            if (e.type === 'token' || e.type === 'tool' || e.type === 'citation') shown = true;
            if (e.type === 'error' && e.code === 'ai_quota_exhausted' && more && !shown) {
              swallowed = true;
              return;
            }
            sse.event(e);
          };
          answeredBy = slot?.provider ?? null;
          result = await runAssistant({ request, viewer, leadContext }, {
            provider: slot?.provider ?? null,
            query,
            now: deps.now,
            budget: userLimits.callBudget(viewer.id, slot?.budget ?? null, now),
            circuit,
            log: log.child({ reqId }),
            limits: {
              maxToolRounds: config.maxToolRounds, maxOutputTokens: config.maxOutputTokens,
              providerTimeoutMs: config.providerTimeoutMs, requestTimeoutMs: config.requestTimeoutMs,
            },
          }, emit, abort.signal);
          usage.inputTokens += result.usage.inputTokens;
          usage.outputTokens += result.usage.outputTokens;
          llmCalls += result.llmCalls;
          if (!swallowed) break;
          log.info({ reqId, model: slot?.provider.model, next: candidates[i + 1]?.provider.model }, 'model quota spent; trying the next model');
        }
        if (result) Object.assign(result, { usage, llmCalls });
        errorCode = result?.errorCode;
      }
      if (!sse.terminated) sse.event({ type: 'error', ...errorPayload('internal_error') });
      sse.close();
      if (result) {
        await userLimits.addTokens(viewer.id, result.usage.inputTokens + result.usage.outputTokens, at).catch(() => {});
      }
    } finally {
      streams.active.delete(abort);
      await slot.release();
      log.info({
        reqId,
        userId: viewer.id,
        role: viewer.role,
        page: request.context.page,
        hasLead: request.context.leadId !== undefined,
        promptVersion: ASSISTANT_PROMPT_VERSION,
        provider: answeredBy?.name ?? null,
        model: answeredBy?.model ?? null,
        llmCalls: result?.llmCalls ?? 0,
        tools: (result?.toolCalls ?? []).map((t) => `${t.name}:${t.ok ? 'ok' : 'error'}`),
        inputTokens: result?.usage.inputTokens ?? 0,
        outputTokens: result?.usage.outputTokens ?? 0,
        ms: Math.round(performance.now() - t0),
        status: res.statusCode,
        outcome: result?.outcome ?? (errorCode ? 'error' : res.statusCode === 200 ? 'aborted' : 'rejected'),
        errorCode,
      }, 'assistant request');
    }
  });

  app.use('/api/assistant', api);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err.type === 'entity.too.large' || err.status === 413) return void res.status(413).json({ error: 'payload_too_large' });
    if (err.type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid_request', message: 'the body is not valid JSON' });
    if (err.status && err.status >= 400 && err.status < 500) return void res.status(err.status).json({ error: err.type ?? 'bad_request' });
    log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
