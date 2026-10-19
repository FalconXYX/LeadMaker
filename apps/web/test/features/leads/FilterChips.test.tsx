import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterChips, clearFacets, filterChips } from '@/features/leads/components/FilterChips';
import { renderLeads, stubFetch } from './testUtils';
import { useLeadsUrlState } from '@/features/leads/useLeadsUrl';

function Harness() {
  const { filter, setFilter, alertOnly } = useLeadsUrlState();
  return <FilterChips filter={filter} setFilter={setFilter} alertOnly={alertOnly} />;
}

const params = (search: string) => new URLSearchParams(search);

beforeEach(() => stubFetch({}));
afterEach(() => vi.unstubAllGlobals());

describe('active filter chips', () => {
  it('removes one value at a time and keeps the rest of the URL', async () => {
    const user = userEvent.setup();
    const { search } = renderLeads(
      <Harness />,
      '/leads?scope=unallocated&segment=strategic&segment=growth&minRating=4&tag=work_type%3Astorm_emergency&zip=07026&radius=10&sort=distance%3Aasc&alert=1',
    );

    await user.click(screen.getByRole('button', { name: 'Remove filter Segment: Strategic' }));
    let p = params(search());
    expect(p.getAll('segment')).toEqual(['growth']);
    expect(p.get('minRating')).toBe('4');
    expect(p.get('scope')).toBe('unallocated');
    expect(p.get('alert')).toBe('1');

    await user.click(screen.getByRole('button', { name: 'Remove filter Tag: Storm / emergency repair' }));
    expect(params(search()).has('tag')).toBe(false);

    // Removing the location also drops the distance sort it enabled.
    await user.click(screen.getByRole('button', { name: 'Remove filter Near: 07026 · 10 mi' }));
    p = params(search());
    expect(p.has('zip')).toBe(false);
    expect(p.has('sort')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Remove filter Weather: storm alert nearby' }));
    expect(params(search()).has('alert')).toBe(false);
    expect(params(search()).getAll('segment')).toEqual(['growth']);
  });

  it('shows and removes the sales facets, naming 7 / 30 days back by their length', async () => {
    const user = userEvent.setup();
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const thirty = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const { search } = renderLeads(<Harness />, `/leads?stage=interested&stage=quoting&followUp=today&notContactedSince=${thirty}&sort=next_follow_up%3Aasc`);

    expect(screen.getByRole('button', { name: 'Remove filter Not contacted: 30+ days' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove filter Stage: Interested' }));
    expect(params(search()).getAll('stage')).toEqual(['quoting']);
    await user.click(screen.getByRole('button', { name: 'Remove filter Follow-up: today' }));
    const p = params(search());
    expect(p.has('followUp')).toBe(false);
    expect(p.get('notContactedSince')).toBe(thirty);
    expect(p.get('sort')).toBe('next_follow_up:asc');
  });

  it('"Clear all" clears every facet but keeps the view and the sort', async () => {
    const user = userEvent.setup();
    const { search } = renderLeads(<Harness />, '/leads?scope=mine&q=roof&cert=gaf%3Acertified&unchecked=me&sort=rating%3Adesc&alert=1');
    expect(screen.getByRole('group', { name: 'Active filters' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    const p = params(search());
    expect([...p.keys()].sort()).toEqual(['scope', 'sort']);
    expect(p.get('scope')).toBe('mine');
    expect(p.get('sort')).toBe('rating:desc');
    expect(screen.queryByRole('group', { name: 'Active filters' })).toBeNull();
  });

  it('labels every facet, the sales ones first', () => {
    const chips = filterChips({
      text: 'acme', segment: ['long_tail'], certifications: ['gaf:none'], size: ['small'], materials: ['metal_roofing'],
      services: ['storm_damage'], tagsAny: ['service:emergency_service'], customTags: ['Follow up'], accountStatus: ['existing_customer'],
      customFields: [{ key: 'credit_limit', op: 'gte', value: 5000 }], unchecked: 'team', unserviced: 'me',
      updatedInLastPoll: true, updatedSince: '2026-10-01', minRating: 4.5, minYearsInBusiness: 10, near: { zip: '11201', radiusMiles: 25 },
      stages: ['quoting', 'lost'], followUp: 'overdue', notContactedSince: '2026-09-01',
    });
    expect(chips.map((c) => `${c.facet}: ${c.label}`)).toEqual([
      'Name: “acme”', 'Stage: Quoting', 'Stage: Not a fit', 'Follow-up: overdue', 'Not contacted: since Sep 1, 2026',
      'Never contacted: by me', 'Status: Customer', 'Segment: Long tail', 'GAF: Not GAF certified', 'Size: Small', 'Material: Metal',
      'Service: Storm damage', 'Any tag: Emergency service', 'Custom tag: Follow up', 'Field: credit_limit is at least 5000',
      'Unchecked: by team', 'Updated: in last poll', 'Changed since: Oct 1, 2026', 'Rating: 4.5+ ★', 'In business: 10+ yrs', 'Near: 11201 · 25 mi',
    ]);
    expect(clearFacets({ scope: { repId: 'x' }, segment: ['growth'], sort: { by: 'rating', dir: 'asc' } }))
      .toEqual({ scope: { repId: 'x' }, sort: { by: 'rating', dir: 'asc' } });
  });
});
