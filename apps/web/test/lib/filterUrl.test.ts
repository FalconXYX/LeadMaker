import { describe, expect, it } from 'vitest';
import type { LeadFilter } from '@/api/types';
import { countActiveFilters, filterToSearchParams, leadsHref, searchParamsToFilter } from '@/lib/filterUrl';

describe('LeadFilter <-> URL', () => {
  it('round-trips every URL-backed facet', () => {
    const f: LeadFilter = {
      text: 'acme roofing',
      scope: { repId: '0b8f2a8e-5d1c-4a8e-9a3b-2f6c1d9e7a10' },
      tagsAll: ['service:metal_roofing', 'gaf_tier=master_elite'],
      tagsAny: ['work_type:storm_emergency'],
      customTags: ['Hot'],
      certifications: ['gaf:master_elite'],
      materials: ['metal_roofing'],
      services: ['storm_damage', 'roof_repair'],
      segment: ['strategic', 'growth'],
      size: ['large'],
      accountStatus: ['prospect'],
      customFields: [
        { key: 'crew size', op: 'gte', value: 10 },
        { key: 'notes', op: 'contains', value: 'a:b' },
        { key: 'fleet', op: 'exists' },
        { key: 'union', op: 'eq', value: true },
      ],
      minRating: 4.5,
      minYearsInBusiness: 10,
      near: { zip: '11201', radiusMiles: 15 },
      unchecked: 'me',
      unserviced: 'team',
      updatedSince: '2026-10-01',
      updatedInLastPoll: true,
      stages: ['interested', 'quoting'],
      followUp: 'overdue',
      notContactedSince: '2026-09-18',
      minPriority: 70,
      counties: ['36047', '34003'],
      sort: { by: 'distance', dir: 'asc' },
    };
    const qs = filterToSearchParams(f).toString();
    expect(searchParamsToFilter(new URLSearchParams(qs))).toEqual(f);
  });

  it('drops malformed or unknown values instead of throwing', () => {
    const f = searchParamsToFilter(new URLSearchParams(
      'scope=everyone&segment=huge&segment=growth&minRating=9&zip=abc&radius=5&sort=distance:asc&unchecked=x&cf=k:bogus:1&since=nope',
    ));
    expect(f).toEqual({ segment: ['growth'] });
  });

  it('links the sales views: stage, follow-ups, not contacted lately, sales sorts', () => {
    expect(leadsHref({ stages: ['quoting'], followUp: 'today', sort: { by: 'next_follow_up', dir: 'asc' } }))
      .toBe('/leads?stage=quoting&followUp=today&sort=next_follow_up%3Aasc');
    expect(searchParamsToFilter(new URLSearchParams('stage=won&stage=bogus&followUp=later&notContactedSince=x&sort=last_contacted:desc')))
      .toEqual({ stages: ['won'], sort: { by: 'last_contacted', dir: 'desc' } });
  });

  it('builds readable links and counts facets', () => {
    expect(leadsHref({})).toBe('/leads');
    expect(leadsHref({ unchecked: 'me', scope: 'mine' })).toBe('/leads?scope=mine&unchecked=me');
    expect(countActiveFilters({ text: 'x', scope: 'mine', segment: ['growth'], minRating: 4 })).toBe(2);
  });
});
