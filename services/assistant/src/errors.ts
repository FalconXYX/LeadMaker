// User-facing copy for every assistant error code (§10). The drawer shows `message` verbatim and hides "Try again"
// when retryable is false. Provider error text never reaches a client: only this copy does.
import type { AssistantErrorCode, AssistantEventPayloads } from '@leadmaker/shared';
import { SALES_TZ, clockTime, dayWord } from './time.ts';

export type ErrorPayload = AssistantEventPayloads['error'] & { code: AssistantErrorCode; retryable: boolean };

export interface ErrorCopyOptions { resetsAt?: Date | null; dailyLimit?: number; now?: Date }

export function errorPayload(code: AssistantErrorCode, opts: ErrorCopyOptions = {}): ErrorPayload {
  switch (code) {
    case 'ai_not_configured':
      return { code, retryable: false, message: "AI isn't set up on this server yet, so the assistant can't answer. Lists, filters and profiles work as usual." };
    case 'ai_quota_exhausted': {
      const at = opts.resetsAt ?? null;
      return {
        code, retryable: false,
        message: at
          ? `The AI's daily limit is used up. It resets ${dayWord(SALES_TZ, at, opts.now ?? new Date())} at ${clockTime(SALES_TZ, at)} ET. Lists, filters and profiles work as usual.`
          : "The AI's usage limit is used up for now. Lists, filters and profiles work as usual.",
        ...(at ? { resetsAt: at.toISOString() } : {}),
      };
    }
    case 'user_daily_limit':
      return {
        code, retryable: false,
        message: opts.dailyLimit
          ? `You've reached today's limit of ${opts.dailyLimit} assistant questions. It resets at midnight ET.`
          : "You've used today's share of the team's AI requests. It resets at midnight ET.",
      };
    case 'ai_rate_limited':
      return { code, retryable: true, message: 'The AI is busy right now. Try again in a few seconds.' };
    case 'ai_provider_error':
      return { code, retryable: true, message: "The AI service didn't respond. Try again in a moment." };
    case 'ai_provider_down':
      return { code, retryable: true, message: 'The AI service is having trouble. Try again in a minute.' };
    case 'ai_timeout':
      return { code, retryable: true, message: 'The answer took too long. Try again, or ask a shorter question.' };
    case 'ai_output_blocked':
      return { code, retryable: true, message: "The AI couldn't answer that one. Try rephrasing." };
    default:
      return { code: 'internal_error', retryable: true, message: 'Something went wrong on our side. Try again.' };
  }
}
