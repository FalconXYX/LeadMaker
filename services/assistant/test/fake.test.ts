// The deterministic fake: parseFilterRules (rules mode, the evals' baseline parser), the lead Q&A templates and
// script mode. Every filter it emits must survive normalizeToolFilter for the same viewer.
import { leadFilterSchema } from '@leadmaker/shared';
import { describe, expect, it } from 'vitest';
import { parseFilterRules } from '../src/engine.ts';
import { FakeProvider } from '../src/llm/fake.ts';
import type { ChatDelta, ChatRequest } from '../src/llm/types.ts';
import { buildTurn } from '../src/prompt.ts';
import { normalizeToolFilter } from '../src/tools.ts';
import { LEAD_OWN, MANAGER, MANAGER_VOCAB, NOW, REP1, VOCAB, chat, leadContext, script } from './helpers.ts';

const TODAY = '2026-10-19';

describe('parseFilterRules', () => {
  it.each([
    ["Master Elite contractors doing metal roofs near 10013 that I haven't checked yet",
      { certifications: ['gaf:master_elite'], materials: ['metal_roofing'], unchecked: 'me', near: { zip: '10013', radiusMiles: 10 } }],
    ['Show me Master Elite roofers', { certifications: ['gaf:master_elite'] }],
    ["Storm restoration contractors I haven't contacted", { services: ['storm_damage'], unserviced: 'me' }],
    ['Commercial flat-roof contractors in Bergen County with 4.5+ rating',
      { materials: ['flat_roofing'], services: ['commercial_roofing'], counties: ['34003'], minRating: 4.5 }],
    ['Contractors that are not Master Elite', { certifications: ['gaf:certified_plus', 'gaf:certified', 'gaf:none'] }],
    ['Leads nobody on the team has contacted', { unserviced: 'team' }],
    ["Leads I haven't contacted in two weeks", { notContactedSince: '2026-10-05' }],
    ['Leads with an overdue follow-up', { followUp: 'overdue' }],
    ['Follow-ups due today', { followUp: 'today' }],
    ['Leads in quoting or interested', { stages: ['interested', 'quoting'] }],
    ['Unallocated leads updated in the last poll', { scope: 'unallocated', updatedInLastPoll: true }],
    ['TPO installers within 15 miles of 07030', { materials: ['tpo_roofing'], near: { zip: '07030', radiusMiles: 15 } }],
    ['Leads closest to 10013', { near: { zip: '10013', radiusMiles: 10 }, sort: { by: 'distance', dir: 'asc' } }],
    ['Lapsed customers to win back', { accountStatus: ['lapsed_customer'] }],
    ["Strategic leads I haven't checked", { segment: ['strategic'], unchecked: 'me' }],
    ['Everything I can see', { scope: 'all' }],
    ['Leads in the pool within 5 miles of 07601', { scope: 'unallocated', near: { zip: '07601', radiusMiles: 5 } }],
    ['Contractors without a GAF certification', { certifications: ['gaf:none'] }],
    ['Contractors named Acme', { text: 'Acme' }],
    ['Leads with no follow-up scheduled', { followUp: 'none' }],
    ['Not a fit leads', { stages: ['lost'] }],
    ['Roofers in Brooklyn', { counties: ['36047'] }],
    ['Leads tagged Bulk buyer', { customTags: ['Bulk buyer'] }],
    ['Leads with annual volume of at least 1000 squares', { customFields: [{ key: 'annual_volume_squares', op: 'gte', value: 1000 }] }],
    ['Contractors that do both gutters and siding', { tagsAll: ['service:gutters', 'service:siding'] }],
    ['Large contractors, sorted by rating', { size: ['large'], sort: { by: 'rating', dir: 'desc' } }],
    ['Highest priority leads first', { sort: { by: 'priority_score', dir: 'desc' } }],
    ['High-priority leads changed since October 1', { minPriority: 70, updatedSince: '2026-10-01' }],
    ['Contractors in business over 20 years with at least 50 reviews', { minYearsInBusiness: 20 }],
  ])('%s', (utterance, expected) => {
    const r = parseFilterRules(utterance, VOCAB, TODAY, 'rep');
    expect(r).not.toBeNull();
    expect(r!.tool).toBe('applyListFilters');
    expect(r!.filter).toEqual(expected);
    expect(r!.explanation.length).toBeLessThanOrEqual(100);
    const n = normalizeToolFilter(r!.filter, REP1, VOCAB);
    expect(n.ok).toBe(true);
    if (n.ok) expect(leadFilterSchema.safeParse({ ...n.filter, ...(n.sort ? { sort: n.sort } : {}) }).success).toBe(true);
  });

  it('uses findLeads for questions and maps a manager\'s "<Name>\'s leads" to repId', () => {
    expect(parseFilterRules('Which of my leads should I call first today, and why?', VOCAB, TODAY, 'rep'))
      .toMatchObject({ tool: 'findLeads', filter: { scope: 'mine' } });
    expect(parseFilterRules("Priya's leads with overdue follow-ups", MANAGER_VOCAB, TODAY, 'manager'))
      .toMatchObject({ tool: 'applyListFilters', filter: { repId: MANAGER_VOCAB.reps[1]!.id, followUp: 'overdue' } });
  });

  it('reports what it cannot exclude and returns null when nothing maps', () => {
    const r = parseFilterRules('Metal roofers excluding storm work', VOCAB, TODAY, 'rep')!;
    expect(r.filter).toEqual({ materials: ['metal_roofing'] });
    expect(r.explanation).toMatch(/can't exclude storm/);
    expect(parseFilterRules("What's the weather tomorrow?", VOCAB, TODAY, 'rep')).toBeNull();
  });
});

async function reply(question: string, opts: { lead?: boolean; viewer?: typeof REP1 } = {}) {
  const provider = new FakeProvider();
  const request = chat(question, opts.lead ? { page: 'profile', leadId: LEAD_OWN } : { page: 'leads' });
  const content = buildTurn({ request, viewer: opts.viewer ?? REP1, vocabulary: opts.viewer === MANAGER ? MANAGER_VOCAB : VOCAB, leadContext: opts.lead ? leadContext() : null, now: NOW });
  const req: ChatRequest = { system: 's', messages: [{ role: 'user', content }], tools: [], toolChoice: 'auto', maxOutputTokens: 100 };
  const out: ChatDelta[] = [];
  for await (const d of provider.stream(req, new AbortController().signal)) out.push(d);
  return {
    text: out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join(''),
    calls: out.filter((d) => d.type === 'tool_call').map((d) => (d as Extract<ChatDelta, { type: 'tool_call' }>).call),
    chunks: out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text),
  };
}

describe('rules mode replies', () => {
  it.each([
    ['Summarize this contractor', /^Carework Construction LLC is a GAF Master Elite roofing contractor in Lyndhurst\. \[src:details\] Carework .* \[src:insights\]$/],
    ['Who should I contact and why?', /^Ask for Jose Sucuzhanay Sr\., Owner\. signs off on supplier changes \[src:contacts\]$/],
    ['What should I pitch before the storm?', /architectural shingle.*\[src:insights\] Timing: Storm response\. \[src:timing\]$/],
    ["What's their annual revenue?", /don't know.*Contacts tab/],
    ["What's the owner's email?", /Contacts tab/],
    ['Tell me about Bergen Roofing Co', /^I can only answer about Carework Construction LLC, the lead that's open\.$/],
    ['Are they Master Elite?', /Their listed GAF tier is GAF Master Elite/],
    ['What did we hear on the last call?', /latest note: 2026-10-07 Jordan L\.: Unhappy with late deliveries.*\[src:notes\]/],
    ['Is this a customer?', /lapsed customer/],
    ['When was this lead last contacted?', /2026-10-12/],
  ])('lead Q&A: %s', async (q, re) => {
    expect((await reply(q, { lead: true })).text).toMatch(re);
  });

  it('streams in chunks of at most 16 characters', async () => {
    const { chunks } = await reply('Summarize this contractor', { lead: true });
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(16);
  });

  it('refuses writes and other reps, and calls tools for list requests', async () => {
    expect((await reply('Delete all my leads')).text).toMatch(/can't change data/);
    expect((await reply("Show Priya's leads")).text).toMatch(/can only see your own leads/);
    expect((await reply('Show me Master Elite roofers')).calls[0]).toMatchObject({ name: 'applyListFilters', arguments: { filter: { certifications: ['gaf:master_elite'] } } });
    expect((await reply('Open Pool Roofing Co')).calls[0]).toMatchObject({ name: 'openLead', arguments: { name: 'Pool Roofing Co' } });
    expect((await reply("What's the weather tomorrow?")).text).toBe('I can answer questions about the open lead or filter your lead list.');
  });
});

describe('script mode', () => {
  async function drive(steps: unknown[], extra: ChatRequest['messages'] = []) {
    const provider = new FakeProvider();
    const content = `<user_message>\n${script(...steps)}\n</user_message>`;
    const req: ChatRequest = { system: 's', messages: [{ role: 'user', content }, ...extra], tools: [], toolChoice: 'auto', maxOutputTokens: 100 };
    const out: ChatDelta[] = [];
    for await (const d of provider.stream(req, new AbortController().signal)) out.push(d);
    return out;
  }

  it('consumes one step per call, skipping delays', async () => {
    const steps = [{ delayMs: 5 }, { tool: 'findLeads', args: { filter: {} } }, { text: 'second' }];
    const first = await drive(steps);
    expect(first.find((d) => d.type === 'tool_call')).toMatchObject({ call: { name: 'findLeads', id: 'fake-call-0-0' } });
    const second = await drive(steps, [{ role: 'assistant', content: '' }, { role: 'tool', content: '{"ok":true,"leads":[]}', name: 'findLeads' }]);
    expect(second.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')).toBe('second');
    const third = await drive(steps, [{ role: 'assistant', content: '' }, { role: 'user', content: 'x' }, { role: 'assistant', content: '' }]);
    expect(third.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')).toBe('(end of script)');
  });

  it('throws scripted errors', async () => {
    await expect(drive([{ error: 'quota' }])).rejects.toMatchObject({ name: 'LlmQuotaExceeded' });
    await expect(drive([{ error: 'blocked' }])).rejects.toMatchObject({ name: 'LlmOutputError' });
  });

  it('answers a tool error after the script ends', async () => {
    const out = await drive([{ tool: 'applyListFilters', args: {} }], [
      { role: 'assistant', content: '' }, { role: 'tool', content: '{"ok":false,"errors":["reps can only filter their own leads or the pool"]}', name: 'applyListFilters', isError: true },
    ]);
    expect(out.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')).toBe("I couldn't apply that: reps can only filter their own leads or the pool.");
  });
});

describe('rules mode with an open lead', () => {
  it('turns "similar contractors" into a filter like the open lead', async () => {
    const r = await reply('Show me similar contractors near here', { lead: true });
    expect(r.calls[0]).toMatchObject({ name: 'applyListFilters', arguments: { filter: { counties: ['34003'], certifications: ['gaf:master_elite'] } } });
  });

  it('answers weather questions only from the timing section', async () => {
    expect((await reply('Is there any weather impact right now?', { lead: true })).text).toMatch(/^Timing: Storm response \(high\)/);
  });
});
