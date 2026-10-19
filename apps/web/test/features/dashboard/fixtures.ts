// Test data builders for the dashboard tests.
import type {
  LeadContact, LeadProfile, LeadSummary, RegionalSignal, SalesDashboard, SignalsResponse, Task, TerritoryBrief,
} from '@/api/types';

let n = 0;
export const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

export const REP = { id: uuid(9001), name: 'Jordan Lee', email: 'rep1@demo.local', role: 'rep' as const };
export const REP2 = { id: uuid(9003), name: 'Priya Shah', email: 'rep2@demo.local', role: 'rep' as const };
export const MANAGER = { id: uuid(9002), name: 'Alex Morgan', email: 'manager@demo.local', role: 'manager' as const };

const flags = (checked = false, serviced = false) => ({ checked, serviced, checkedAt: null, servicedAt: null });
export const daysAgo = (d: number, from = Date.now()) => new Date(from - d * 86_400_000).toISOString();

export function makeLead(over: Partial<LeadSummary> = {}): LeadSummary {
  const i = ++n;
  return {
    id: uuid(i),
    businessName: `Lead ${i}`,
    city: 'Hackensack',
    state: 'NJ',
    postalCode: '07601',
    phone: '(201) 555-0100',
    websiteUrl: null,
    latitude: 40.88,
    longitude: -74.04,
    countyFips: '34003',
    rating: 4.8,
    reviewCount: 40,
    tier: null,
    yearsInBusiness: 10,
    segment: 'growth',
    priorityScore: 50,
    priorityDrivers: ['GAF Master Elite', '300+ reviews'],
    accountStatus: 'prospect',
    assignedRep: { id: REP.id, name: REP.name },
    tags: [],
    customTags: [],
    updatedInLastPoll: false,
    lastChangeAt: '2026-10-18T06:00:00.000Z',
    mine: flags(),
    team: flags(),
    distanceMiles: null,
    canWrite: true,
    version: 1,
    salesStage: 'new',
    lastContactedAt: null,
    nextTask: null,
    ...over,
  };
}

export function makeTask(over: Partial<Task> & { companyId: string; companyName: string; dueAt: string }): Task {
  const i = ++n;
  return {
    id: `task-${i}`,
    title: 'Call about the underlayment quote',
    type: 'call',
    doneAt: null,
    note: null,
    assignee: { id: REP.id, name: REP.name },
    createdBy: { id: REP.id, name: REP.name },
    createdAt: daysAgo(5),
    updatedAt: daysAgo(1),
    version: 1,
    ...over,
  };
}

const ef = <T,>(value: T) => ({ value, scraped: value, overridden: false, sourceChangedSinceEdit: false, editedBy: null, editedAt: null });

export function makeContact(over: { id: string; name: string | null; title?: string | null; phone?: string | null; isTarget?: boolean; doNotContact?: boolean; confidence?: number }): LeadContact {
  return {
    id: over.id,
    name: ef(over.name),
    title: ef(over.title ?? null),
    email: ef(null),
    phone: ef(over.phone ?? null),
    doNotContact: ef(over.doNotContact ?? false),
    source: 'website',
    sourceUrl: null,
    confidence: over.confidence ?? 0.8,
    emailVerifiedAt: null,
    isTarget: over.isTarget ?? false,
    version: 1,
  };
}

/** Just the profile fields the dashboard reads. */
export function makeProfile(lead: LeadSummary, over: Partial<LeadProfile> = {}): LeadProfile {
  return {
    id: lead.id,
    version: 1,
    fields: {
      business_name: ef(lead.businessName), phone: ef(lead.phone), website_url: ef(null), address: ef(null), street: ef(null),
      city: ef(lead.city), state: ef(lead.state), postal_code: ef(lead.postalCode),
    },
    contacts: [],
    targetContact: null,
    timing: lead.timing ?? [],
    allocation: { current: null, history: [] },
    salesStage: lead.salesStage,
    stageChangedAt: null,
    lastContactedAt: lead.lastContactedAt,
    tasks: [],
    ...over,
  } as unknown as LeadProfile;
}

export function dashboardBody(over: Partial<SalesDashboard> = {}): SalesDashboard {
  return {
    scope: 'mine',
    pipeline: [
      { stage: 'new', count: 20 }, { stage: 'contacted', count: 12 }, { stage: 'interested', count: 8 },
      { stage: 'quoting', count: 4 }, { stage: 'won', count: 3 }, { stage: 'lost', count: 3 },
    ],
    followUps: { overdue: 2, today: 3, week: 7 },
    activity: {
      thisWeek: { calls: 9, emails: 5, visits: 2, notes: 4 },
      lastWeek: { calls: 8, emails: 4, visits: 2, notes: 1 },
      goalPerWeek: 25,
      daily: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(5 + i).padStart(2, '0')}`, calls: i % 3, emails: 1, visits: 0, notes: 0 })),
    },
    accounts: { prospect: 41, existing_customer: 6, lapsed_customer: 3, do_not_contact: 0 },
    coverage: { total: 50, withDecisionMaker: 28, withEmail: 19, withPhone: 50 },
    neverContacted: 20,
    notContacted30d: 9,
    newSinceLastPoll: 31,
    topTags: [{ key: 'service:gutters', label: 'Gutters', count: 37, kind: 'system' }, { key: 'tag-1', label: 'Hot lead', count: 4, kind: 'custom' }],
    segments: [{ segment: 'strategic', count: 23 }, { segment: 'growth', count: 27 }, { segment: 'emerging', count: 0 }, { segment: 'long_tail', count: 0 }],
    aiPicks: [],
    callPitches: {},
    generatedAt: '2026-10-18T20:00:00.000Z',
    ...over,
  };
}

export function alertSignal(over: Partial<RegionalSignal> & { event: string; severity?: string; url?: string }): RegionalSignal {
  const { event, severity = 'Severe', url = `https://api.weather.gov/alerts/${event.replace(/\s/g, '-')}`, ...rest } = over;
  return {
    id: `sig-${++n}`,
    countyFips: '36047',
    kind: 'active_alert',
    source: 'nws',
    payload: { event, severity, url, headline: `${event} issued`, onset: '2026-10-18T18:00:00Z' },
    validFrom: '2026-10-18T18:00:00.000Z',
    validTo: '2026-10-18T23:00:00.000Z',
    fetchedAt: '2026-10-18T18:05:00.000Z',
    active: true,
    expired: false,
    ...rest,
  };
}

export function stormHistorySignal(countyFips: string, recentEvents: Record<string, unknown>[]): RegionalSignal {
  return {
    id: `sig-${++n}`,
    countyFips,
    kind: 'storm_history',
    source: 'noaa_storm_events',
    payload: {
      events_12m: recentEvents.length,
      events_24m: recentEvents.length,
      counts_24m: { wind: recentEvents.length },
      last_event: recentEvents[0] ?? null,
      recent_events: recentEvents,
    },
    validFrom: null,
    validTo: null,
    fetchedAt: '2026-10-18T06:00:00.000Z',
    active: true,
    expired: false,
  };
}

export function signalsResponse(over: Partial<SignalsResponse> = {}): SignalsResponse {
  return {
    scope: 'mine',
    counties: [{ countyFips: '34003', leadCount: 3 }],
    alerts: [],
    stormHistory: [],
    news: [],
    generatedAt: '2026-10-18T20:00:00.000Z',
    ...over,
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A signed-looking JWT that the session store accepts (exp one hour out). */
export function testToken(): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

/** GET /api/territory-brief's brief: a digest-sourced, non-quiet, fresh one unless patched. */
export function makeBrief(patch: Partial<TerritoryBrief> = {}): TerritoryBrief {
  const now = new Date().toISOString();
  return {
    scope: 'rep:11111111-1111-4111-8111-111111111111',
    text: 'Since Saturday’s poll: 3 new leads in this territory.',
    source: 'digest',
    quiet: false,
    stale: false,
    digestText: 'Since Saturday’s poll: 3 new leads in this territory.',
    computedAt: now,
    generatedAt: null,
    model: null,
    promptVersion: null,
    pollFinishedAt: now,
    leads: [],
    ...patch,
  };
}
