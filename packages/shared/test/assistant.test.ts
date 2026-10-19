// Section 4 contracts: the assistant chat request, the AI filter tool schema and its committed JSON export.
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AI_CONTEXT_LIMITS, ASSISTANT_LIMITS, ASSISTANT_PROMPT_VERSION, assistantChatRequestSchema, CITATION_FIELDS,
  leadFilterJsonSchema, leadFilterObject, leadFilterSchema, leadFilterToolJsonSchema, leadFilterToolSchema,
  type AssistantEvent, type LeadFilter, type LeadFilterTool, type LeadInsight,
} from '../src/index.ts';

const REP2 = 'e1817cb3-f647-416d-9c20-084a9ab62324';
const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });

describe('assistantChatRequestSchema', () => {
  it('accepts a profile question and strips unknown keys', () => {
    const r = assistantChatRequestSchema.parse({
      messages: [user('Summarize this contractor')],
      context: { page: 'profile', leadId: '8c1e0000-0000-4000-8000-000000000000', extra: 1 },
      junk: true,
    });
    expect(r).toEqual({
      messages: [{ role: 'user', content: 'Summarize this contractor' }],
      context: { page: 'profile', leadId: '8c1e0000-0000-4000-8000-000000000000' },
    });
  });

  it('keeps context.filter as unknown (the server validates it leniently)', () => {
    const r = assistantChatRequestSchema.parse({
      messages: [user('only Bergen')], context: { page: 'leads', filter: { minRating: 'not a number' } },
    });
    expect(r.context.filter).toEqual({ minRating: 'not a number' });
  });

  it('trims messages and accepts a multi-turn history ending with the user', () => {
    const r = assistantChatRequestSchema.parse({
      messages: [user('  hi  '), assistant('Hello.'), user('Master Elite near 10013')], context: { page: 'dashboard' },
    });
    expect(r.messages[0]!.content).toBe('hi');
    expect(r.messages).toHaveLength(3);
  });

  it.each([
    ['no messages', { messages: [], context: { page: 'leads' } }],
    ['last message from the assistant', { messages: [user('a'), assistant('b')], context: { page: 'leads' } }],
    ['unknown role', { messages: [{ role: 'system', content: 'x' }], context: { page: 'leads' } }],
    ['empty after trim', { messages: [user('   ')], context: { page: 'leads' } }],
    ['unknown page', { messages: [user('x')], context: { page: 'settings' } }],
    ['missing context', { messages: [user('x')] }],
    ['leadId too long', { messages: [user('x')], context: { page: 'profile', leadId: 'x'.repeat(65) } }],
    ['too many messages', {
      messages: Array.from({ length: ASSISTANT_LIMITS.maxMessages + 1 }, (_, i) => (i % 2 ? assistant('a') : user('q'))),
      context: { page: 'leads' },
    }],
    ['question too long', { messages: [user('q'.repeat(ASSISTANT_LIMITS.maxQuestionChars + 1))], context: { page: 'leads' } }],
    ['message too long', {
      messages: [assistant('a'.repeat(ASSISTANT_LIMITS.maxMessageChars + 1)), user('q')], context: { page: 'leads' },
    }],
    ['conversation too long', {
      messages: [user('q'.repeat(4000)), ...Array.from({ length: 6 }, () => [assistant('a'.repeat(3000)), user('q'.repeat(1000))]).flat()],
      context: { page: 'leads' },
    }],
  ])('rejects %s', (_name, body) => {
    expect(assistantChatRequestSchema.safeParse(body).success).toBe(false);
  });

  it('reports the documented messages', () => {
    const r = assistantChatRequestSchema.safeParse({ messages: [user('a'), assistant('b')], context: { page: 'leads' } });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toContain("the last message must be the user's");
  });

  it('pins the contract constants', () => {
    expect(ASSISTANT_PROMPT_VERSION).toBe('assistant/v2');
    expect(CITATION_FIELDS.tags).toBe('systemTags');
    expect(AI_CONTEXT_LIMITS.websiteChars).toBe(6000);
    expectTypeOf<Extract<AssistantEvent, { type: 'tool' }>>().toHaveProperty('name');
    expectTypeOf<LeadInsight['targetContact']>().toEqualTypeOf<{ name: string; title: string; why: string } | null>();
  });
});

describe('leadFilterToolSchema', () => {
  it('accepts repId and the plain scope enum', () => {
    expect(leadFilterToolSchema.parse({ repId: REP2, followUp: 'overdue' })).toEqual({ repId: REP2, followUp: 'overdue' });
    expect(leadFilterToolSchema.parse({ scope: 'unallocated', updatedInLastPoll: true })).toEqual({
      scope: 'unallocated', updatedInLastPoll: true,
    });
  });

  it.each([
    ['cursor', { cursor: 'abc' }],
    ['limit', { limit: 5 }],
    ['object scope', { scope: { repId: REP2 } }],
    ['unknown key', { notAKey: 1 }],
    ['bad repId', { repId: 'rep2' }],
  ])('rejects %s', (_name, f) => {
    expect(leadFilterToolSchema.safeParse(f).success).toBe(false);
  });

  it('keeps every LeadFilter facet except paging and the object scope', () => {
    const facets = Object.keys(leadFilterObject.shape).filter((k) => !['cursor', 'limit'].includes(k)).sort();
    expect(Object.keys(leadFilterToolSchema.shape).filter((k) => k !== 'repId').sort()).toEqual(facets);
  });

  it('tool output minus repId is a valid LeadFilter (refinements stay on leadFilterSchema)', () => {
    const tool: LeadFilterTool = { scope: 'mine', certifications: ['gaf:master_elite'], near: { zip: '10013', radiusMiles: 10 } };
    const { repId: _repId, ...rest } = tool;
    const f: LeadFilter = rest;
    expect(leadFilterSchema.parse(f)).toEqual(f);
    // sort by distance without near passes the tool schema but not the list schema (the assistant drops the sort).
    const bad = { sort: { by: 'distance', dir: 'asc' } };
    expect(leadFilterToolSchema.safeParse(bad).success).toBe(true);
    expect(leadFilterSchema.safeParse(bad).success).toBe(false);
  });

  it('exports JSON Schema without anyOf for scope and a top-level description', () => {
    const s = leadFilterToolJsonSchema() as { properties: Record<string, Record<string, unknown>>; additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.scope).toMatchObject({ type: 'string', enum: ['mine', 'unallocated', 'all'] });
    expect(s.properties.scope!.anyOf).toBeUndefined();
    expect(s.properties.repId).toMatchObject({ type: 'string', format: 'uuid' });
    expect(s.properties.cursor).toBeUndefined();
    expect(s.properties.limit).toBeUndefined();
  });
});

describe('committed JSON Schema files (drift check: run npm run export-schema -w @leadmaker/shared)', () => {
  it.each([
    ['lead-filter.schema.json', leadFilterJsonSchema],
    ['lead-filter.tool.schema.json', leadFilterToolJsonSchema],
  ])('%s matches the generator', (file, gen) => {
    const text = readFileSync(new URL(`../schema/${file}`, import.meta.url), 'utf8');
    expect(text).toBe(`${JSON.stringify(gen(), null, 2)}\n`);
  });

  it('is exported from the package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./lead-filter.tool.schema.json']).toBe('./schema/lead-filter.tool.schema.json');
  });
});
