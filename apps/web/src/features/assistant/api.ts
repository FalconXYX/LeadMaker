// The assistant's API contract and its typed client. The On-Demand AI Service (Section 4) implements the
// server side of exactly this; nothing here is mocked.
//
//   POST /api/assistant/chat
//   Authorization: Bearer <session JWT>          (the gateway authenticates, like every /api route)
//   Accept: text/event-stream
//   Content-Type: application/json
//   body: AssistantChatRequest
//
//   200 Content-Type: text/event-stream, one event per block:
//     event: status    data: {"text":"Searching your leads…"}       (progress while nothing streams yet)
//     event: token     data: {"text":"Acme is a "}                   (append to the answer)
//     event: tool      data: {"name":"apply_filter","filter":{...},"sort":{"by":"rating","dir":"desc"},"explanation":"...",
//                             "matchCount":37,"matchCountCapped":false}
//     event: tool      data: {"name":"open_lead","leadId":"<uuid>"}
//     event: citation  data: {"leadId":"<uuid>","field":"notes","leadName":"Acme Roofing"}
//     event: done      data: {"usage":{...},"promptVersion":"assistant/v2"}  (the answer is complete; usage is ignored)
//     event: error     data: {"message":"...","code":"...","retryable":false,"resetsAt":"<iso>"}  (failed mid-stream;
//                             the message is server-written copy, shown as is; retryable:false hides "Try again")
//   `: ping` comment lines may be sent as keep-alives. Unknown event names are ignored (forward compatible).
//   Send `Cache-Control: no-cache` and `X-Accel-Buffering: no`: the web nginx proxies /api/ with buffering on
//   (only /api/events is special-cased), and a buffered stream arrives all at once. The client stops reading
//   after `done` or `error`; it treats a stream that ends without either as cut off.
//
//   Errors before the stream starts are JSON {error, message?} with the usual statuses:
//     400 invalid_request, 401 (logs out), 404 lead_not_found (context.leadId missing or not visible),
//     429 rate_limited (+ Retry-After), 503 busy. A 404 for the route itself (`not_found`), 501 or 502 means
//     the AI service is not running: the widget says it is offline instead of showing an error.
//
//   GET /api/assistant/status -> AssistantStatus {available, reason, provider, model, resetsAt, limits}, computed
//   without calling the model; the panel's status line reads it (404 / 501 / 502 / no network -> "offline").
//
// Rules for the server (SystemDesign §5 / §7):
//   - It runs with the caller's permissions: lead Q&A reads context.leadId through the Query service (which
//     rejects leads the user cannot view), and apply_filter results are listed through the same visibility rule.
//   - apply_filter.filter is a complete LeadFilter validated with leadFilterSchema (packages/shared/src/filter.ts);
//     the client replaces the list's filter with it (it does not merge). `sort`, when present, wins over filter.sort.
//     It travels through the list URL (lib/filterUrl), so: an omitted scope means the list's default view
//     (reps: My leads, managers: All), send scope "all" for a rep's mine + unallocated; updatedInLastPoll: true
//     travels as ?new=1 (false has no list form); cursor and limit are dropped. context.filter arrives in that same URL form.
//   - Model output is untrusted: the client renders text as plain text with a markdown-lite subset (bold,
//     lists, `code`, and links to /leads/:id only), never as HTML.
import { ApiError, api, buildUrl } from '@/api/client';
import { NetworkError, UnauthorizedError, isRecord, toApiError } from '@/api/errors';
import type { LeadFilter } from '@/api/types';
import { sessionStore } from '@/auth/session';
import { readSse, type SseMessage } from './sse';

export const ASSISTANT_CHAT_PATH = '/api/assistant/chat';

// ---- request -----------------------------------------------------------------------------------

/** Where the user is asking from. */
export type AssistantPage = 'dashboard' | 'leads' | 'profile' | 'allocation';

export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantRequestContext {
  page: AssistantPage;
  /** The open lead profile (page 'profile'): Q&A is scoped to this lead. */
  leadId?: string;
  /** The list's current filter (page 'leads'), so "only the ones in Bergen" can refine it. */
  filter?: LeadFilter;
}

export interface AssistantChatRequest {
  /** The conversation so far, oldest first, alternating and ending with the new user message. */
  messages: AssistantChatMessage[];
  context: AssistantRequestContext;
}

// ---- stream events ---------------------------------------------------------------------------------

export type LeadSort = NonNullable<LeadFilter['sort']>;

/** Replace the lead list's filter (and sort) and show it at /leads. */
export interface ApplyFilterTool {
  name: 'apply_filter';
  filter: LeadFilter;
  sort?: LeadSort;
  /** One line for the user: why these filters ("Commercial flat-roof work, 4.5+ stars, Bergen County ZIPs"). */
  explanation: string;
  /** Leads the filter matches for this user (capped at 1,000: then matchCountCapped is true). */
  matchCount?: number;
  matchCountCapped?: boolean;
}

/** Open a lead profile. */
export interface OpenLeadTool {
  name: 'open_lead';
  leadId: string;
}

export type AssistantToolCall = ApplyFilterTool | OpenLeadTool;

export interface AssistantEventPayloads {
  token: { text: string };
  /** What the assistant is doing while nothing streams yet ("Searching your leads…"). */
  status: { text: string };
  tool: AssistantToolCall;
  /** The answer used this lead field; `field` is a LeadProfile path such as "notes", "insights", "contacts". */
  citation: { leadId: string; field: string; leadName?: string };
  done: { usage?: AssistantUsage };
  /** `retryable: false` (no key, quota or a daily limit): trying again can't help, so no "Try again". */
  error: { message: string; code?: string; retryable?: boolean; resetsAt?: string };
}

/** Token accounting the server reports with `done`; the client ignores it. */
export interface AssistantUsage {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export type AssistantEventType = keyof AssistantEventPayloads;

export type AssistantEvent = {
  [K in AssistantEventType]: { type: K } & AssistantEventPayloads[K];
}[AssistantEventType];

// ---- errors --------------------------------------------------------------------------------------------

/** The AI service is not running (route 404, 501, 502) or answered with something that is not a stream. */
export class AssistantUnavailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('The assistant is offline right now.');
    this.name = 'AssistantUnavailableError';
    this.status = status;
  }
}

/** The server sent `event: error` mid-stream. */
export class AssistantStreamError extends Error {
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;

  constructor(message: string, code?: string, retryable?: boolean) {
    super(message);
    this.name = 'AssistantStreamError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isNotConnected(status: number, body: unknown): boolean {
  if (status === 501 || status === 502) return true;
  if (status !== 404) return false;
  const code = isRecord(body) && typeof body.error === 'string' ? body.error : undefined;
  return code !== 'lead_not_found';
}

// ---- client ------------------------------------------------------------------------------------------------

export interface StreamChatOptions {
  signal?: AbortSignal;
  /** Defaults to the signed-in session's token. */
  token?: string | null;
}

/**
 * POSTs the chat request and yields typed events as they arrive.
 *   for await (const ev of streamAssistantChat(req, { signal })) { ... }
 * Throws AssistantUnavailableError (not running), ApiError subclasses (4xx/5xx before the stream),
 * NetworkError (fetch failed), or the AbortError of `signal`.
 */
export async function* streamAssistantChat(req: AssistantChatRequest, opts: StreamChatOptions = {}): AsyncGenerator<AssistantEvent> {
  const token = opts.token === undefined ? sessionStore.get()?.token ?? null : opts.token;
  const headers: Record<string, string> = { Accept: 'text/event-stream', 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(buildUrl(ASSISTANT_CHAT_PATH), {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new NetworkError(err);
  }

  if (!res.ok) {
    const body = await readErrorBody(res);
    if (isNotConnected(res.status, body)) throw new AssistantUnavailableError(res.status);
    const err = toApiError(res.status, res.headers, body);
    if (err instanceof UnauthorizedError) sessionStore.set(null, 'expired');
    throw err;
  }
  // A 200 that is not an event stream (e.g. an SPA fallback page) means the service is not there.
  if (!(res.headers.get('Content-Type') ?? '').includes('text/event-stream') || !res.body) {
    void res.body?.cancel().catch(() => {});
    throw new AssistantUnavailableError(res.status);
  }

  for await (const msg of readSse(res.body, opts.signal)) {
    const ev = toAssistantEvent(msg);
    if (ev) yield ev;
  }
}

async function readErrorBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

// ---- event decoding (untrusted input) -----------------------------------------------------------------------

const str = (v: unknown): v is string => typeof v === 'string';

/** One SSE message to a typed event; null for unknown events or malformed payloads (they are skipped). */
export function toAssistantEvent(msg: SseMessage): AssistantEvent | null {
  let data: unknown = {};
  if (msg.data.trim() !== '') {
    try {
      data = JSON.parse(msg.data);
    } catch {
      return null;
    }
  }
  if (!isRecord(data)) return null;
  switch (msg.event) {
    case 'token':
      return str(data.text) ? { type: 'token', text: data.text } : null;
    case 'status':
      return str(data.text) && data.text.trim() ? { type: 'status', text: data.text.trim().slice(0, 80) } : null;
    case 'citation':
      if (!str(data.leadId) || !data.leadId || !str(data.field)) return null;
      return { type: 'citation', leadId: data.leadId, field: data.field, ...(str(data.leadName) && data.leadName ? { leadName: data.leadName } : {}) };
    case 'done': {
      const usage = toUsage(data.usage);
      return { type: 'done', ...(usage ? { usage } : {}) };
    }
    case 'error':
      return {
        type: 'error',
        message: str(data.message) && data.message.trim() ? data.message : 'The assistant ran into a problem.',
        ...(str(data.code) ? { code: data.code } : {}),
        ...(typeof data.retryable === 'boolean' ? { retryable: data.retryable } : {}),
        ...(str(data.resetsAt) && !Number.isNaN(Date.parse(data.resetsAt)) ? { resetsAt: data.resetsAt } : {}),
      };
    case 'tool':
      if (data.name === 'apply_filter' && isRecord(data.filter)) {
        const sort = isSort(data.sort) ? data.sort : undefined;
        return {
          type: 'tool',
          name: 'apply_filter',
          filter: data.filter as LeadFilter,
          ...(sort ? { sort } : {}),
          explanation: str(data.explanation) ? data.explanation : '',
          ...(count(data.matchCount) ? { matchCount: data.matchCount } : {}),
          ...(count(data.matchCount) && typeof data.matchCountCapped === 'boolean' ? { matchCountCapped: data.matchCountCapped } : {}),
        };
      }
      if (data.name === 'open_lead' && str(data.leadId) && data.leadId) return { type: 'tool', name: 'open_lead', leadId: data.leadId };
      return null;
    default:
      return null;
  }
}

function isSort(v: unknown): v is LeadSort {
  return isRecord(v) && str(v.by) && (v.dir === 'asc' || v.dir === 'desc');
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function toUsage(v: unknown): AssistantUsage | null {
  if (!isRecord(v)) return null;
  const n = (k: string) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? v[k] : 0);
  return { llmCalls: n('llmCalls'), inputTokens: n('inputTokens'), outputTokens: n('outputTokens'), ms: n('ms') };
}

// ---- status -----------------------------------------------------------------------------------------------

export const ASSISTANT_STATUS_PATH = '/api/assistant/status';

/** Why the assistant can or can't answer; 'offline' is the client's own (the service didn't answer). */
export type AssistantStatusReason = 'ok' | 'not_configured' | 'quota_exhausted' | 'provider_down' | 'offline';

export interface AssistantStatusView {
  available: boolean;
  reason: AssistantStatusReason;
  /** When the daily AI quota resets (quota_exhausted). */
  resetsAt: string | null;
  provider: string | null;
  model: string | null;
}

const OFFLINE: AssistantStatusView = { available: false, reason: 'offline', resetsAt: null, provider: null, model: null };
const REASONS = ['ok', 'not_configured', 'quota_exhausted', 'provider_down'] as const;

/**
 * GET /api/assistant/status. A missing route (404 other than lead_not_found, 501, 502, 504) or no network means
 * the service isn't there: `{available: false, reason: 'offline'}`. Other failures throw (401 logs out as usual).
 */
export async function getAssistantStatus(opts: { signal?: AbortSignal } = {}): Promise<AssistantStatusView> {
  try {
    return toAssistantStatus(await api.get<unknown>(ASSISTANT_STATUS_PATH, { signal: opts.signal, busyRetries: 0 }));
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (err instanceof NetworkError) return OFFLINE;
    if (err instanceof ApiError && (err.status === 504 || isNotConnected(err.status, err.body))) return OFFLINE;
    throw err;
  }
}

/** The status body (untrusted) to the view; anything unrecognisable reads as offline. */
export function toAssistantStatus(body: unknown): AssistantStatusView {
  if (!isRecord(body) || typeof body.available !== 'boolean') return OFFLINE;
  const reason = (REASONS as readonly unknown[]).includes(body.reason)
    ? body.reason as AssistantStatusReason
    : body.available ? 'ok' : 'not_configured';
  return {
    available: body.available,
    reason,
    resetsAt: str(body.resetsAt) && !Number.isNaN(Date.parse(body.resetsAt)) ? body.resetsAt : null,
    provider: str(body.provider) ? body.provider : null,
    model: str(body.model) ? body.model : null,
  };
}
