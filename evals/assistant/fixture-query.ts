// A QueryClient over the eval fixtures, with the real service's visibility rule (shared canView) and the same
// failure modes (403 for another rep's scope, 400 for an invalid filter, null for an invisible lead). Every call
// is recorded with the identity it carried, so the runner can check that the assistant only ever read as the
// requesting user. Search applies scope, visibility, text, counties, stages and follow-ups (enough for the match
// counts and the call-first order the evals assert); other facets are not applied.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canView, leadFilterSchema, type FilterVocabulary, type LeadAiContext, type LeadFilter, type LeadSearchResult,
  type LeadSummary, type Viewer,
} from '@leadmaker/shared';
import { QueryError, type QueryClient } from '../../services/assistant/src/query-client.ts';
import { EVALS_DIR, readJson } from '../lib/cases.ts';

export interface FixtureUser { id: string; name: string; email: string; role: 'rep' | 'manager' }
export type FixtureUsers = Record<'rep1' | 'rep2' | 'rep3' | 'manager', FixtureUser>;

export const USERS = readJson<FixtureUsers>(join(EVALS_DIR, 'fixtures', 'users.json'));
export const VOCABULARY = readJson<FilterVocabulary>(join(EVALS_DIR, 'fixtures', 'vocabulary.json'));

interface CompactLead {
  id: string; businessName: string; city: string; state: string; postalCode: string; countyFips: string;
  tier: string | null; rating: number | null; reviewCount: number; priorityScore: number | null; priorityDrivers: string[];
  assignedRepId: string | null; salesStage: LeadSummary['salesStage']; segment: string | null; size: string | null;
  certifications: string[]; nextTaskDue?: string; timing?: LeadSummary['timing'];
}

const QA_FIXTURE_DIR = join(EVALS_DIR, 'lead_qa', 'fixtures');
/** The evals' pinned day (Monday 2026-10-19, America/New_York). */
const EVAL_TODAY = '2026-10-19';

export function qaFixture(name: string): LeadAiContext {
  return readJson<LeadAiContext>(join(QA_FIXTURE_DIR, `${name}.json`));
}

export function qaFixtureNames(): string[] {
  return readdirSync(QA_FIXTURE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

const repName = (id: string | null) => Object.values(USERS).find((u) => u.id === id)?.name ?? 'Unknown rep';

function summary(l: CompactLead, viewer: Viewer): LeadSummary {
  const flags = { checked: false, serviced: false, checkedAt: null, servicedAt: null };
  return {
    id: l.id, businessName: l.businessName, city: l.city, state: l.state, postalCode: l.postalCode, phone: null,
    websiteUrl: null, latitude: 40.8, longitude: -74.1, countyFips: l.countyFips, rating: l.rating,
    reviewCount: l.reviewCount, tier: l.tier, yearsInBusiness: null, segment: l.segment, priorityScore: l.priorityScore,
    priorityDrivers: l.priorityDrivers, accountStatus: 'prospect',
    assignedRep: l.assignedRepId ? { id: l.assignedRepId, name: repName(l.assignedRepId) } : null,
    tags: [], customTags: [], updatedInLastPoll: false, lastChangeAt: '2026-10-18T22:10:00.000Z',
    mine: flags, team: flags, distanceMiles: null,
    canWrite: viewer.role === 'manager' || l.assignedRepId === viewer.id, version: 1,
    size: l.size, certifications: l.certifications, timing: l.timing ?? [], salesStage: l.salesStage,
    lastContactedAt: null,
    nextTask: l.nextTaskDue ? { id: `${l.id}-task`, title: 'Follow up', type: 'call', dueAt: l.nextTaskDue } : null,
  };
}

export type QueryCall =
  | { op: 'aiContext'; viewer: Viewer; leadId: string; found: boolean }
  | { op: 'vocabulary'; viewer: Viewer }
  | { op: 'search'; viewer: Viewer; filter: LeadFilter; error?: string; returned?: string[] };

export class FixtureQueryClient implements QueryClient {
  readonly calls: QueryCall[] = [];
  readonly #leads: CompactLead[];
  readonly #contexts: Map<string, LeadAiContext>;

  constructor(contexts: LeadAiContext[] = qaFixtureNames().map(qaFixture)) {
    this.#leads = readJson<{ leads: CompactLead[] }>(join(EVALS_DIR, 'fixtures', 'leads.json')).leads;
    this.#contexts = new Map(contexts.map((c) => [c.id, c]));
  }

  async aiContext(viewer: Viewer, leadId: string): Promise<LeadAiContext | null> {
    const c = this.#contexts.get(leadId);
    const visible = !!c && canView(viewer, c.assignedRep?.id ?? null);
    this.calls.push({ op: 'aiContext', viewer: { ...viewer }, leadId, found: visible });
    if (!c || !visible) return null;
    return { ...structuredClone(c), canWrite: viewer.role === 'manager' || c.assignedRep?.id === viewer.id };
  }

  async vocabulary(viewer: Viewer): Promise<FilterVocabulary> {
    this.calls.push({ op: 'vocabulary', viewer: { ...viewer } });
    const v = structuredClone(VOCABULARY);
    return viewer.role === 'manager' ? v : { ...v, reps: [] };
  }

  async search(viewer: Viewer, filter: LeadFilter): Promise<LeadSearchResult> {
    const call: QueryCall = { op: 'search', viewer: { ...viewer }, filter: structuredClone(filter) };
    this.calls.push(call);
    if (!leadFilterSchema.safeParse(filter).success) {
      call.error = 'invalid filter';
      throw new QueryError('query returned 400', 400);
    }
    const scope = filter.scope;
    if (scope && typeof scope === 'object' && viewer.role !== 'manager' && scope.repId !== viewer.id) {
      call.error = 'forbidden';
      throw new QueryError('query returned 403', 403);
    }
    const text = filter.text?.toLowerCase();
    const items = this.#leads
      .filter((l) => canView(viewer, l.assignedRepId))
      .filter((l) => {
        if (scope === 'mine') return l.assignedRepId === viewer.id;
        if (scope === 'unallocated') return l.assignedRepId === null;
        if (scope && typeof scope === 'object') return l.assignedRepId === scope.repId;
        return true;
      })
      .filter((l) => !text || l.businessName.toLowerCase().includes(text))
      .filter((l) => !filter.counties?.length || filter.counties.includes(l.countyFips))
      .filter((l) => !filter.stages?.length || filter.stages.includes(l.salesStage))
      .filter((l) => {
        if (!filter.followUp) return true;
        const due = l.nextTaskDue?.slice(0, 10);
        if (filter.followUp === 'none') return !due;
        if (!due) return false;
        return filter.followUp === 'overdue' ? due < EVAL_TODAY : filter.followUp === 'today' ? due === EVAL_TODAY : true;
      })
      .sort((a, b) => (b.priorityScore ?? -1) - (a.priorityScore ?? -1))
      .map((l) => summary(l, viewer));
    const page = items.slice(0, filter.limit ?? 50);
    call.returned = page.map((l) => l.id);
    return { items: page, nextCursor: null, total: items.length, totalCapped: false };
  }
}
