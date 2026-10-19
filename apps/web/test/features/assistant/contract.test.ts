// The web keeps its own copy of the assistant's wire types (packages/shared is type-only here, and the client
// decodes untrusted events itself). These type-level checks fail the typecheck when packages/shared/src/assistant.ts
// and the client drift apart: every event the server may send is one the client can represent, the client's request
// is one the server accepts, and the client's history limits are the server's.
import { describe, expectTypeOf, it } from 'vitest';
import type * as Shared from '@shared/assistant.ts';
import type {
  AssistantChatRequest, AssistantEvent, AssistantStatusReason, AssistantUsage, LeadSort,
} from '@/features/assistant/api';
import type { HISTORY_LIMITS } from '@/features/assistant/state';

type Extends<A, B> = [A] extends [B] ? true : false;
type Limits = typeof Shared.ASSISTANT_LIMITS;

describe('assistant wire contract (packages/shared/src/assistant.ts)', () => {
  it('every server event fits the client’s event type', () => {
    expectTypeOf<Extends<Shared.AssistantEvent, AssistantEvent>>().toEqualTypeOf<true>();
    expectTypeOf<Extends<Shared.ApplyFilterTool & { type: 'tool' }, AssistantEvent>>().toEqualTypeOf<true>();
    expectTypeOf<Extends<Shared.AssistantUsage, AssistantUsage>>().toEqualTypeOf<true>();
    expectTypeOf<Extends<Shared.LeadSort, LeadSort>>().toEqualTypeOf<true>();
  });

  it('the client’s request is one the server’s schema type accepts', () => {
    expectTypeOf<Extends<AssistantChatRequest, Shared.AssistantChatRequest>>().toEqualTypeOf<true>();
    expectTypeOf<Extends<Shared.AssistantPage, AssistantChatRequest['context']['page']>>().toEqualTypeOf<true>();
  });

  it('the status reasons are the server’s plus the client’s own offline', () => {
    expectTypeOf<Extends<Shared.AssistantStatusReason, AssistantStatusReason>>().toEqualTypeOf<true>();
    expectTypeOf<Exclude<AssistantStatusReason, Shared.AssistantStatusReason>>().toEqualTypeOf<'offline'>();
  });

  it('the history limits match the server’s', () => {
    expectTypeOf<(typeof HISTORY_LIMITS)['maxMessages']>().toEqualTypeOf<Limits['maxMessages']>();
    expectTypeOf<(typeof HISTORY_LIMITS)['maxTotalChars']>().toEqualTypeOf<Limits['maxTotalChars']>();
    expectTypeOf<(typeof HISTORY_LIMITS)['keptAssistantChars']>().toEqualTypeOf<Limits['keptAssistantChars']>();
  });
});
