// Fixtures for the assistant tests: viewers, a lead context, a vocabulary, an in-memory QueryClient that applies a
// toy visibility rule and records every call, and helpers to run the engine and read SSE bodies.
import type {
  AssistantChatRequest, AssistantEvent, FilterVocabulary, LeadAiContext, LeadFilter, LeadSearchResult, LeadSummary, Viewer,
} from '@leadmaker/shared';
import type { QueryClient } from '../src/query-client.ts';

export const REP1: Viewer = { id: '11111111-1111-4111-8111-111111111111', role: 'rep' };
export const REP2: Viewer = { id: '22222222-2222-4222-8222-222222222222', role: 'rep' };
export const MANAGER: Viewer = { id: '33333333-3333-4333-8333-333333333333', role: 'manager' };

export const LEAD_OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const LEAD_POOL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const LEAD_THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Pinned like the evals: Monday 2026-10-19, 3 PM ET. */
export const NOW = new Date('2026-10-19T15:00:00-04:00');

export function leadContext(over: Partial<LeadAiContext> = {}): LeadAiContext {
  return {
    id: LEAD_OWN,
    businessName: 'Carework Construction LLC',
    city: 'Lyndhurst', state: 'NJ', postalCode: '07071', countyFips: '34003', countyName: 'Bergen County, NJ',
    websiteUrl: 'https://carework.example',
    gaf: {
      tier: 'master_elite', certifications: ['GAF Master Elite'], rating: 4.8, reviewCount: 132, yearsInBusiness: 17,
      employeesRange: '10-19', specialties: ['Residential'], distinctions: [], presidentsClubStars: 0,
      description: 'Family-owned roofing contractor.',
    },
    size: 'medium', segment: 'strategic', priorityScore: 51, priorityDrivers: ['Master Elite'],
    accountStatus: 'lapsed_customer', salesStage: 'interested', stageChangedAt: '2026-10-07T14:00:00Z',
    lastContactedAt: '2026-10-12T15:00:00Z',
    assignedRep: { id: REP1.id, name: 'Jordan Lee' }, canWrite: true,
    tags: [{ key: 'service:storm_damage', label: 'Storm / emergency repair', category: 'services' }],
    customTags: ['Bulk buyer'],
    customFields: { annual_volume_squares: 2400 },
    targetContact: { label: 'Owner', reason: 'signs off on supplier changes', name: 'Jose Sucuzhanay Sr.', title: 'Owner' },
    contacts: [{ name: 'Maria Lopez', title: 'Office Manager', hasEmail: true, hasPhone: false, doNotContact: false, source: 'website' }],
    insights: {
      businessSummary: 'Carework Construction is a Master Elite replacement roofer in Lyndhurst.',
      salesRecommendation: 'Lead with bulk architectural shingle pricing for a high-volume Master Elite shop.',
      talkingPoints: ['Ask how the 4.8 rating is holding up.', 'Follow up on late deliveries.'],
      targetContact: { name: 'Jose Sucuzhanay Sr.', title: 'Owner', why: 'signs off on supplier changes' },
      productFocus: ['architectural_shingles'], citedFacts: [{ id: 'F3', text: 'gaf_tier: GAF Master Elite' }],
      model: 'fake:fake-1', promptVersion: 'insights/v1', generatedAt: '2026-10-19T12:00:00Z',
    },
    timing: [{ key: 'storm_response', label: 'Storm response', reason: 'Severe Thunderstorm Warning in Bergen County until 8 PM', source: 'nws', severity: 'high' }],
    notes: [{ author: 'Jordan L.', at: '2026-10-07T14:00:00Z', text: 'Unhappy with late deliveries from their current supplier.' }],
    activity: [{ type: 'call', outcome: 'connected', author: 'Jordan L.', at: '2026-10-12T15:00:00Z', text: 'Asked for a quote.' }],
    openTasks: [],
    website: [{ url: 'https://carework.example/about', title: 'About Us', text: 'We replace roofs across Bergen County.' }],
    websiteSummary: 'Residential roof replacement and repair.',
    generatedAt: '2026-10-19T15:00:00Z',
    ...over,
  };
}

export const VOCAB: FilterVocabulary = {
  counties: [
    { fips: '34003', name: 'Bergen County, NJ', leadCount: 61 },
    { fips: '34017', name: 'Hudson County, NJ', leadCount: 44 },
    { fips: '36047', name: 'Kings County, NY', leadCount: 12 },
  ],
  customTags: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Bulk buyer', leadCount: 12 }],
  customFieldKeys: [{ key: 'annual_volume_squares', valueType: 'number' }],
  reps: [],
  generatedAt: '2026-10-19T15:00:00Z',
};

export const MANAGER_VOCAB: FilterVocabulary = {
  ...VOCAB,
  reps: [{ id: REP1.id, name: 'Jordan Lee' }, { id: REP2.id, name: 'Priya Shah' }],
};

export function summary(id: string, name: string, over: Partial<LeadSummary> = {}): LeadSummary {
  return {
    id, businessName: name, city: 'Lyndhurst', state: 'NJ', postalCode: '07071', phone: null, websiteUrl: null,
    latitude: 40.8, longitude: -74.1, countyFips: '34003', rating: 4.8, reviewCount: 132, tier: 'master_elite',
    yearsInBusiness: 17, segment: 'strategic', priorityScore: 51.4, priorityDrivers: ['Storm work'], accountStatus: 'prospect',
    assignedRep: null, tags: [], customTags: [], updatedInLastPoll: false, lastChangeAt: '2026-10-18T00:00:00Z',
    mine: { checked: false, serviced: false, checkedAt: null, servicedAt: null },
    team: { checked: false, serviced: false, checkedAt: null, servicedAt: null },
    distanceMiles: null, canWrite: false, version: 1, salesStage: 'new', lastContactedAt: null, nextTask: null,
    ...over,
  };
}

/** A QueryClient over a fixed lead set: reps see their own and the pool; managers everything. */
export class FakeQuery implements QueryClient {
  calls: { op: string; viewer: Viewer; arg: unknown }[] = [];
  leads: (LeadSummary & { owner: string | null })[] = [
    { ...summary(LEAD_OWN, 'Carework Construction LLC'), owner: REP1.id },
    { ...summary(LEAD_POOL, 'Pool Roofing Co'), owner: null },
    { ...summary(LEAD_THEIRS, 'Theirs Roofing Inc'), owner: REP2.id },
  ];
  contexts = new Map<string, LeadAiContext>([
    [LEAD_OWN, leadContext()],
    [LEAD_POOL, leadContext({ id: LEAD_POOL, businessName: 'Pool Roofing Co', assignedRep: null })],
    [LEAD_THEIRS, leadContext({ id: LEAD_THEIRS, businessName: 'Theirs Roofing Inc', assignedRep: { id: REP2.id, name: 'Priya Shah' } })],
  ]);
  vocab: FilterVocabulary | Error = VOCAB;
  searchError: Error | null = null;
  total: number | null = null;
  totalCapped = false;

  #visible(viewer: Viewer, owner: string | null) {
    return viewer.role === 'manager' || owner === null || owner === viewer.id;
  }

  async aiContext(viewer: Viewer, leadId: string): Promise<LeadAiContext | null> {
    this.calls.push({ op: 'aiContext', viewer, arg: leadId });
    const lead = this.leads.find((l) => l.id === leadId);
    if (!lead || !this.#visible(viewer, lead.owner)) return null;
    return this.contexts.get(leadId) ?? null;
  }

  async vocabulary(viewer: Viewer): Promise<FilterVocabulary> {
    this.calls.push({ op: 'vocabulary', viewer, arg: null });
    if (this.vocab instanceof Error) throw this.vocab;
    return this.vocab;
  }

  async search(viewer: Viewer, filter: LeadFilter): Promise<LeadSearchResult> {
    this.calls.push({ op: 'search', viewer, arg: filter });
    if (this.searchError) throw this.searchError;
    // Like query's scopeCondition: reps may not send "all" or another rep's {repId} (403).
    const scope = filter.scope;
    if (viewer.role !== 'manager' && (scope === 'all' || (typeof scope === 'object' && scope.repId !== viewer.id))) {
      throw new Error('query leads/search answered 403');
    }
    let items = this.leads.filter((l) => this.#visible(viewer, l.owner));
    if (filter.scope === 'mine') items = items.filter((l) => l.owner === viewer.id);
    if (filter.scope === 'unallocated') items = items.filter((l) => l.owner === null);
    if (filter.text) items = items.filter((l) => l.businessName.toLowerCase().includes(filter.text!.toLowerCase()));
    const total = this.total ?? items.length;
    return { items: items.slice(0, filter.limit ?? 50).map(({ owner: _o, ...l }) => l), nextCursor: null, total, totalCapped: this.totalCapped };
  }
}

export function chat(content: string, context: AssistantChatRequest['context'] = { page: 'leads' }, history: AssistantChatRequest['messages'] = []): AssistantChatRequest {
  return { messages: [...history, { role: 'user', content }], context };
}

/** `/fake {"steps":[...]}` as the question. */
export function script(...steps: unknown[]): string {
  return `/fake ${JSON.stringify({ steps })}`;
}

/** Parses an SSE body into [{event, data}] (comments skipped). */
export function parseSseBody(body: string): { event: string; data: Record<string, unknown> }[] {
  return body.split('\n\n').filter((b) => b.trim() && !b.startsWith(':')).map((block) => {
    const lines = block.split('\n').filter((l) => !l.startsWith(':'));
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message';
    const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    return { event, data: data ? JSON.parse(data) : {} };
  }).filter((e) => e.event !== 'message' || Object.keys(e.data).length);
}

export function collector() {
  const events: AssistantEvent[] = [];
  return { events, emit: (e: AssistantEvent) => events.push(e), types: () => events.map((e) => e.type) };
}
