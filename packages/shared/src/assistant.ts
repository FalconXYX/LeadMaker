// The assistant's wire contract (services/assistant <-> apps/web/src/features/assistant). SystemDesign §7.
import { z } from 'zod';
import type { LeadFilter } from './filter.ts';

export const ASSISTANT_PROMPT_VERSION = 'assistant/v2';
export const ASSISTANT_PAGES = ['dashboard', 'leads', 'profile', 'allocation'] as const;
export type AssistantPage = (typeof ASSISTANT_PAGES)[number];
export const ASSISTANT_LIMITS = {
  maxMessages: 20, maxMessageChars: 8000, maxQuestionChars: 4000, maxTotalChars: 24000,
  keptMessages: 12, keptAssistantChars: 2000, maxBodyBytes: 65536,
} as const;

/** Unknown keys are stripped (forward compatible). context.filter is validated by the server with leadFilterSchema
 *  and dropped (not rejected) when invalid, since it comes from the lenient list URL. */
export const assistantChatRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().trim().min(1).max(ASSISTANT_LIMITS.maxMessageChars),
  })).min(1).max(ASSISTANT_LIMITS.maxMessages),
  context: z.object({
    page: z.enum(ASSISTANT_PAGES),
    leadId: z.string().max(64).optional(),
    filter: z.unknown().optional(),
  }),
}).superRefine((r, ctx) => {
  const last = r.messages.at(-1);
  if (last?.role !== 'user') ctx.addIssue({ code: 'custom', path: ['messages'], message: "the last message must be the user's" });
  else if (last.content.length > ASSISTANT_LIMITS.maxQuestionChars) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'question too long' });
  if (r.messages.reduce((n, m) => n + m.content.length, 0) > ASSISTANT_LIMITS.maxTotalChars)
    ctx.addIssue({ code: 'custom', path: ['messages'], message: 'conversation too long' });
});
export type AssistantChatRequest = z.infer<typeof assistantChatRequestSchema>;

export type LeadSort = NonNullable<LeadFilter['sort']>;
export interface ApplyFilterTool {
  name: 'apply_filter'; filter: LeadFilter; sort?: LeadSort; explanation: string;
  /** Leads the filter matches for this user (POST /leads/search total); capped at 1,000. */
  matchCount?: number; matchCountCapped?: boolean;
}
export interface OpenLeadTool { name: 'open_lead'; leadId: string }
export type AssistantToolCall = ApplyFilterTool | OpenLeadTool;

export const ASSISTANT_ERROR_CODES = [
  'ai_not_configured', 'ai_quota_exhausted', 'user_daily_limit', 'ai_rate_limited', 'ai_provider_error',
  'ai_provider_down', 'ai_timeout', 'ai_output_blocked', 'internal_error',
] as const;
export type AssistantErrorCode = (typeof ASSISTANT_ERROR_CODES)[number];

export interface AssistantUsage { llmCalls: number; inputTokens: number; outputTokens: number; ms: number }
export interface AssistantEventPayloads {
  token: { text: string };
  /** Progress while nothing is streaming yet ("Searching your leads…"); replaced by the next status or by text. */
  status: { text: string };
  tool: AssistantToolCall;
  /** field: a LeadProfile path the web labels (CITATION_FIELDS values). */
  citation: { leadId: string; field: string; leadName?: string };
  done: { usage?: AssistantUsage; promptVersion?: string };
  error: { message: string; code?: AssistantErrorCode | string; retryable?: boolean; resetsAt?: string };
}
export type AssistantEventType = keyof AssistantEventPayloads;
export type AssistantEvent = { [K in AssistantEventType]: { type: K } & AssistantEventPayloads[K] }[AssistantEventType];

/** [src:<key>] tags the model writes -> citation.field. */
export const CITATION_FIELDS = {
  details: 'details', contacts: 'contacts', notes: 'notes', activity: 'activity', insights: 'insights',
  tags: 'systemTags', customFields: 'customFields', timing: 'timing', website: 'website',
} as const;

export type AssistantStatusReason = 'ok' | 'not_configured' | 'quota_exhausted' | 'provider_down';
/** GET /api/assistant/status */
export interface AssistantStatus {
  available: boolean;
  reason: AssistantStatusReason;
  provider: string | null;
  model: string | null;
  resetsAt: string | null;
  limits: { perMinute: number; perDay: number; usedToday: number };
}
