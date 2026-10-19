// Conversation state: messages, the reducer that streams events into them, and the history sent upstream.
import type { LeadFilter } from '@/api/types';
import type { AssistantChatMessage, AssistantRequestContext } from './api';

export interface Citation {
  leadId: string;
  field: string;
  leadName?: string;
}

/** An apply_filter call, as shown in the conversation. */
export interface FilterPart {
  kind: 'filter';
  id: string;
  filter: LeadFilter;
  explanation: string;
  /** /leads?… for the filter. */
  href: string;
  /** Where the user was before it was applied (Undo goes back there). */
  prevHref: string;
  undone: boolean;
  /** How many leads it matched for this user when applied (absent when the server couldn't count). */
  matchCount?: number;
  /** The count hit the server's cap (1,000). */
  matchCountCapped?: boolean;
}

/** An apply_filter call whose filter had nothing usable. */
export interface InvalidFilterPart {
  kind: 'filter-invalid';
  id: string;
  explanation: string;
}

export interface OpenLeadPart {
  kind: 'open-lead';
  id: string;
  leadId: string;
  href: string;
}

export interface TextPart {
  kind: 'text';
  id: string;
  text: string;
}

export type Part = TextPart | FilterPart | InvalidFilterPart | OpenLeadPart;

export type ReplyStatus =
  | 'streaming'
  /** Finished with `done`. */
  | 'done'
  /** The user pressed Stop. */
  | 'stopped'
  /** The stream ended without `done` (connection dropped, or a reload mid-answer). */
  | 'interrupted'
  /** HTTP error, network error, or an `error` event. */
  | 'error'
  /** The AI service is offline (404 / 501 / 502, or not an event stream). */
  | 'unavailable';

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  context: AssistantRequestContext;
  /** "Acme Roofing" when asked from a profile: shown under the bubble once the user moves on. */
  contextLabel: string | null;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  parts: Part[];
  citations: Citation[];
  status: ReplyStatus;
  /** The server's latest progress line while streaming ("Searching your leads…"); dropped when it ends. */
  progress?: string;
  error?: string;
  /** The server's error code (ai_quota_exhausted, user_daily_limit, …) or the client's (rate_limited, …). */
  errorCode?: string;
  /** false when trying again can't help (no AI key, no AI requests left for now): no "Try again". */
  retryable?: boolean;
}

/** The one line for every state where the AI can't answer for now: no reasons or reset times, and what still works. */
export const UNAVAILABLE_MESSAGE = 'AI answers aren’t available right now. Filters and profiles work as usual.';

/** Server codes whose own copy names a usage limit or a reset time; the drawer shows UNAVAILABLE_MESSAGE instead. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['ai_quota_exhausted', 'user_daily_limit']);

/** What the drawer says for a failed reply (also for one saved in this browser before the copy changed). */
export function replyErrorText(code: string | undefined, message: string | undefined): string | undefined {
  return code && UNAVAILABLE_CODES.has(code) ? UNAVAILABLE_MESSAGE : message;
}

/** How a reply ended, when it failed. */
export interface ReplyError {
  message?: string;
  code?: string;
  retryable?: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

export type Action =
  | { type: 'send'; user: UserMessage; reply: AssistantMessage }
  | { type: 'retry'; replyId: string; reply: AssistantMessage }
  | { type: 'token'; id: string; text: string }
  | { type: 'progress'; id: string; text: string }
  | { type: 'part'; id: string; part: Exclude<Part, TextPart> }
  | { type: 'citation'; id: string; citation: Citation }
  | { type: 'finish'; id: string; status: Exclude<ReplyStatus, 'streaming'>; error?: ReplyError }
  | { type: 'update-filter'; partId: string; patch: Partial<Pick<FilterPart, 'undone' | 'prevHref'>> }
  | { type: 'reset' }
  | { type: 'load'; messages: ChatMessage[] };

let seq = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function reducer(state: ChatMessage[], action: Action): ChatMessage[] {
  switch (action.type) {
    case 'send':
      return [...state, action.user, action.reply];
    case 'retry':
      return state.map((m) => (m.id === action.replyId ? action.reply : m));
    case 'token':
      return mapReply(state, action.id, (m) => {
        const last = m.parts.at(-1);
        const parts = last?.kind === 'text'
          ? [...m.parts.slice(0, -1), { ...last, text: last.text + action.text }]
          : [...m.parts, { kind: 'text' as const, id: newId('t'), text: action.text }];
        return { ...m, parts };
      });
    case 'progress':
      return mapReply(state, action.id, (m) => (m.status === 'streaming' ? { ...m, progress: action.text } : m));
    case 'part':
      return mapReply(state, action.id, (m) => ({ ...m, parts: [...m.parts, action.part] }));
    case 'citation':
      return mapReply(state, action.id, (m) => (
        m.citations.some((c) => c.leadId === action.citation.leadId && c.field === action.citation.field)
          ? m
          : { ...m, citations: [...m.citations, action.citation] }
      ));
    case 'finish':
      return mapReply(state, action.id, (m) => {
        const { error: _e, errorCode: _c, retryable: _r, progress: _p, ...rest } = m;
        const e = action.error;
        return {
          ...rest,
          status: action.status,
          ...(e?.message ? { error: e.message } : {}),
          ...(e?.code ? { errorCode: e.code } : {}),
          ...(typeof e?.retryable === 'boolean' ? { retryable: e.retryable } : {}),
        };
      });
    case 'update-filter':
      return state.map((m) => {
        if (m.role !== 'assistant' || !m.parts.some((p) => p.id === action.partId)) return m;
        return { ...m, parts: m.parts.map((p) => (p.id === action.partId && p.kind === 'filter' ? { ...p, ...action.patch } : p)) };
      });
    case 'reset':
      return [];
    case 'load':
      return action.messages;
  }
}

function mapReply(state: ChatMessage[], id: string, fn: (m: AssistantMessage) => AssistantMessage): ChatMessage[] {
  return state.map((m) => (m.id === id && m.role === 'assistant' ? fn(m) : m));
}

export function replyText(m: AssistantMessage): string {
  return m.parts.filter((p): p is TextPart => p.kind === 'text').map((p) => p.text).join('');
}

export function emptyReply(): AssistantMessage {
  return { id: newId('a'), role: 'assistant', parts: [], citations: [], status: 'streaming' };
}

/**
 * The server's request limits (packages/shared ASSISTANT_LIMITS; a type test pins them): at most 20 messages and
 * 24,000 characters in all. It keeps only the first 2,000 characters of an earlier answer, so longer ones are cut here.
 */
export const HISTORY_LIMITS = { maxMessages: 20, maxTotalChars: 24000, keptAssistantChars: 2000 } as const;

/** Upstream history: completed exchanges only (so roles alternate), capped by count and size, then the new question. */
export function buildHistory(
  messages: ChatMessage[], question: string, maxMessages: number = HISTORY_LIMITS.maxMessages,
): AssistantChatMessage[] {
  const out: AssistantChatMessage[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const q = messages[i]!;
    const a = messages[i + 1]!;
    if (q.role !== 'user' || a.role !== 'assistant') continue;
    const text = replyText(a).trim();
    if (!text || (a.status !== 'done' && a.status !== 'stopped')) continue;
    out.push({ role: 'user', content: q.content }, { role: 'assistant', content: text.slice(0, HISTORY_LIMITS.keptAssistantChars) });
  }
  const keep = Math.floor((maxMessages - 1) / 2) * 2; // whole exchanges that fit before the question
  let recent = keep > 0 ? out.slice(-keep) : [];
  // Oldest exchanges go first until the whole conversation fits the server's size limit.
  const size = (ms: AssistantChatMessage[]) => ms.reduce((n, m) => n + m.content.length, question.length);
  while (recent.length > 0 && size(recent) > HISTORY_LIMITS.maxTotalChars) recent = recent.slice(2);
  return [...recent, { role: 'user', content: question }];
}
