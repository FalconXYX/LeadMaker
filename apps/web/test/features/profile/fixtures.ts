// Test fixtures for the lead profile (imported by tests only).
import type { ActivityEntry, EffectiveField, LeadContact, LeadProfile, Task } from '@/api/types';

export const LEAD_ID = '0a1b2c3d-0000-4000-8000-000000000001';
export const REP = { id: 'r1', name: 'Jordan Lee', email: 'rep1@demo.local', role: 'rep' as const };
export const MANAGER = { id: 'm1', name: 'Alex Morgan', email: 'manager@demo.local', role: 'manager' as const };

export function field<T>(value: T, patch: Partial<EffectiveField<T>> = {}): EffectiveField<T> {
  return { value, scraped: value, overridden: false, sourceChangedSinceEdit: false, editedBy: null, editedAt: null, ...patch };
}

export function contact(patch: Partial<LeadContact> & { id: string }): LeadContact {
  return {
    name: field<string | null>('Eileen Cawley'),
    title: field<string | null>('Buyer'),
    email: field<string | null>(null),
    phone: field<string | null>(null),
    doNotContact: field(false),
    source: 'bbb',
    sourceUrl: 'https://www.bbb.org/x',
    confidence: 0.89,
    emailVerifiedAt: null,
    isTarget: false,
    version: 1,
    ...patch,
  };
}

export function entry(patch: Partial<ActivityEntry> & { id: string; type: string }): ActivityEntry {
  return {
    actorType: 'user',
    user: { id: MANAGER.id, name: MANAGER.name },
    actorLabel: MANAGER.name,
    outcome: null,
    text: null,
    fieldDiff: null,
    createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    ...patch,
  };
}

const NOW = new Date().toISOString();

export function task(patch: Partial<Task> & { id: string }): Task {
  return {
    companyId: LEAD_ID,
    companyName: 'Homestead Roofing Company',
    title: 'Call Mike about the underlayment quote',
    type: 'call',
    dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    doneAt: null,
    note: null,
    assignee: { id: REP.id, name: REP.name },
    createdBy: { id: REP.id, name: REP.name },
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...patch,
  };
}

export function makeProfile(patch: Partial<LeadProfile> = {}): LeadProfile {
  return {
    id: LEAD_ID,
    version: 7,
    updatedAt: NOW,
    fields: {
      business_name: field<string | null>('Homestead Roofing Company'),
      phone: field<string | null>('(201) 444-2233'),
      website_url: field<string | null>('https://homesteadroofing.com'),
      address: field<string | null>('533 Goffle Rd Ridgewood, NJ 07450'),
      street: field<string | null>('533 Goffle Rd'),
      city: field<string | null>('Ridgewood'),
      state: field<string | null>('NJ'),
      postal_code: field<string | null>('07450'),
    },
    details: {
      industry: 'roofing',
      dba: null,
      legalName: 'Homestead Roofing Co Inc',
      contractorType: 'Residential',
      latitude: 40.98,
      longitude: -74.12,
      countyFips: '34003',
      rating: 4.7,
      reviewCount: 213,
      profileUrl: 'https://www.gaf.com/x',
      imageUrl: null,
      tier: 'master_elite',
      certifications: ['GAF Master Elite® - Certification'],
      specialties: [],
      distinctions: [],
      presidentsClubStars: 0,
      gafLeadsEnrolled: true,
      googlePlaceId: null,
      description: 'Since &quot;1930&quot; we must be doing something right.',
      inBusinessSince: 1930,
      yearsInBusiness: 96,
      employeesRange: null,
      websiteSource: 'website_discovery',
      segment: 'strategic',
      priorityScore: 78.3,
      accountStatus: 'prospect',
      updatedInLastPoll: true,
      lastMaterialChangeAt: NOW,
      firstSeenAt: NOW,
      sourceIds: [{ source: 'gaf', externalId: '1100174' }],
    },
    contacts: [contact({ id: 'c1', isTarget: true })],
    targetContact: { role: 'purchasing', label: 'Ask for: Eileen Cawley (Purchasing manager)', reason: 'size=large → purchasing', contactId: 'c1' },
    systemTags: [
      { key: 'size', value: 'large', label: 'Size: large', category: 'size', reason: '213 reviews', source: 'derived' },
      { key: 'priority_drivers', value: ['GAF tier', 'Review volume'], label: 'Why', category: 'priority', reason: 'GAF tier +25; Review volume +17', source: 'derived' },
      { key: 'work_type:storm_emergency', value: true, label: 'Storm / emergency repair', category: 'work_type', reason: 'storm_damage found', source: 'website' },
    ],
    customTags: [],
    customFields: {},
    insights: null,
    insightAttempt: null,
    timing: [
      { key: 'recent_storm', label: 'Recent storm activity', reason: '3 storm reports in 30 days.', source: 'noaa_storm_events', severity: 'medium' },
    ],
    notes: [],
    activity: [],
    activityNextCursor: null,
    allocation: {
      current: { rep: { id: REP.id, name: REP.name }, allocatedBy: { id: MANAGER.id, name: MANAGER.name }, allocatedAt: NOW, endedAt: null, endedBy: null },
      history: [],
    },
    state: {
      mine: { checked: false, serviced: false, checkedAt: null, servicedAt: null },
      team: { checked: false, serviced: false, checkedAt: null, servicedAt: null, byUser: [] },
    },
    permissions: { canWrite: true, canAllocate: false },
    salesStage: 'new',
    stageChangedAt: null,
    lastContactedAt: null,
    tasks: [],
    ...patch,
  };
}
