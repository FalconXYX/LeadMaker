import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterPanel } from '@/features/leads/components/FilterPanel';
import { deriveTagOptions } from '@/features/leads/tags';
import { lead, renderLeads, stubFetch } from './testUtils';
import { useLeadsUrlState } from '@/features/leads/useLeadsUrl';

function Harness() {
  const { filter, setFilter, alertOnly } = useLeadsUrlState();
  return (
    <FilterPanel
      filter={filter}
      setFilter={setFilter}
      alertOnly={alertOnly}
      tagOptions={deriveTagOptions([lead({ tags: [
        { key: 'work_type:storm_emergency', label: 'Storm / emergency repair', value: true, category: 'work_type' },
        { key: 'reputation', label: '4.9★ (excellent)', value: 'excellent', category: 'reputation' },
      ] })])}
      facetFilter={filter}
    />
  );
}

const params = (search: string) => new URLSearchParams(search);

beforeEach(() => {
  stubFetch({
    'GET /api/custom-tags': { items: [{ id: 't1', name: 'Follow up', createdBy: { id: 'u', name: 'Jordan' }, createdAt: '2026-10-18T00:00:00Z', leadCount: 3 }] },
    'GET /api/custom-fields/keys': { items: [{ key: 'credit_limit', leadCount: 2, valueType: 'number' }] },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('FilterPanel -> URL params', () => {
  it('maps facet pills and segmented choices to their params, and toggles them off again', async () => {
    const user = userEvent.setup();
    const { search } = renderLeads(<Harness />, '/leads?scope=unallocated');

    await user.click(screen.getByRole('button', { name: /^Fit/ }));
    await user.click(screen.getByRole('button', { name: 'Strategic' }));
    await user.click(screen.getByRole('button', { name: 'Growth' }));
    await user.click(screen.getByRole('button', { name: 'Master Elite' }));
    await user.click(screen.getByRole('button', { name: 'Large' }));
    await user.click(screen.getByRole('button', { name: /Pipeline updates/ }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Unchecked' })).getByRole('radio', { name: 'By me' }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Last contacted' })).getByRole('radio', { name: 'Never' }));

    let p = params(search());
    expect(p.getAll('segment')).toEqual(['strategic', 'growth']);
    expect(p.getAll('cert')).toEqual(['gaf:master_elite']);
    expect(p.getAll('size')).toEqual(['large']);
    expect(p.get('unchecked')).toBe('me');
    expect(p.get('unserviced')).toBe('team'); // Last contacted: never
    expect(p.get('scope')).toBe('unallocated'); // the view is untouched

    await user.click(screen.getByRole('button', { name: 'Strategic' }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Unchecked' })).getByRole('radio', { name: 'Any' }));
    p = params(search());
    expect(p.getAll('segment')).toEqual(['growth']);
    expect(p.has('unchecked')).toBe(false);
  });

  it('maps materials, services, rating, years, location and account status', async () => {
    const user = userEvent.setup();
    const { search } = renderLeads(<Harness />);

    await user.click(screen.getByRole('button', { name: /Roof materials/ }));
    await user.click(screen.getByRole('button', { name: 'TPO' }));
    await user.click(screen.getByRole('button', { name: /^Services/ }));
    await user.click(screen.getByRole('button', { name: 'Commercial roofing' }));
    await user.click(screen.getByRole('button', { name: /Rating & experience/ }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Minimum rating' })).getByRole('radio', { name: '4+' }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Years in business' })).getByRole('radio', { name: '10+' }));
    await user.click(screen.getByRole('button', { name: /Location/ }));
    await user.type(screen.getByLabelText('Near ZIP'), '07026');
    await user.selectOptions(screen.getByLabelText('Within'), '10');
    // Account status sits with the sales filters, open from the start.
    await user.click(screen.getByRole('button', { name: 'Lapsed customer' }));

    const p = params(search());
    expect(p.getAll('material')).toEqual(['tpo_roofing']);
    expect(p.getAll('service')).toEqual(['commercial_roofing']);
    expect(p.get('minRating')).toBe('4');
    expect(p.get('minYears')).toBe('10');
    expect(p.get('zip')).toBe('07026');
    expect(p.get('radius')).toBe('10');
    expect(p.getAll('status')).toEqual(['lapsed_customer']);

    await user.click(screen.getByRole('button', { name: 'Sort nearest first' }));
    expect(params(search()).get('sort')).toBe('distance:asc');
    await user.click(screen.getByRole('button', { name: 'Clear location' }));
    expect(params(search()).has('zip')).toBe(false);
    expect(params(search()).has('sort')).toBe(false);
  });

  it('maps system tags (match all / any), custom tags and custom field conditions', async () => {
    const user = userEvent.setup();
    const { search } = renderLeads(<Harness />);

    await user.click(screen.getByRole('button', { name: /System tags/ }));
    await user.click(screen.getByRole('button', { name: 'Storm / emergency repair' }));
    await user.click(screen.getByRole('button', { name: '4.9★ (excellent)' }));
    expect(params(search()).getAll('tag')).toEqual(['work_type:storm_emergency', 'reputation=excellent']);

    await user.click(within(screen.getByRole('radiogroup', { name: 'Match system tags' })).getByRole('radio', { name: 'Any selected' }));
    expect(params(search()).getAll('tag')).toEqual([]);
    expect(params(search()).getAll('anyTag')).toEqual(['work_type:storm_emergency', 'reputation=excellent']);

    await user.click(screen.getByRole('button', { name: /Custom tags/ }));
    await user.click(await screen.findByRole('button', { name: /^Follow up/ }));
    expect(params(search()).getAll('ctag')).toEqual(['Follow up']);

    await user.click(screen.getByRole('button', { name: /Custom fields/ }));
    await user.selectOptions(await screen.findByLabelText('Custom field'), 'credit_limit');
    await user.selectOptions(screen.getByLabelText('Condition'), 'gte');
    await user.type(screen.getByLabelText('Value'), '5000');
    await user.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(params(search()).getAll('cf')).toEqual(['credit_limit:gte:5000']);
  });

  it('maps free text (debounced), new in last poll, changed-since and the storm alert flag (the last section)', async () => {
    const user = userEvent.setup();
    const { search } = renderLeads(<Harness />);

    await user.type(screen.getByLabelText('Business name'), 'acme');
    await waitFor(() => expect(params(search()).get('q')).toBe('acme'));

    await user.click(screen.getByRole('button', { name: /Pipeline updates/ }));
    await user.click(screen.getByRole('switch', { name: /New in last poll/ }));
    expect(params(search()).get('new')).toBe('1');
    await user.click(screen.getByRole('button', { name: '7 days' }));
    expect(params(search()).get('since')).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const sections = screen.getAllByRole('button', { expanded: false }).map((b) => b.textContent);
    expect(sections.at(-1)).toMatch(/^Weather/);
    await user.click(screen.getByRole('button', { name: /^Weather/ }));
    await user.click(screen.getByRole('switch', { name: /Storm alert nearby/ }));
    expect(params(search()).get('alert')).toBe('1');
    // Later filter changes keep the list-only flag.
    await user.click(screen.getByRole('button', { name: /^Fit/ }));
    await user.click(screen.getByRole('button', { name: 'Emerging' }));
    expect(params(search()).get('alert')).toBe('1');
    expect(params(search()).get('q')).toBe('acme');
  });

  it('puts the sales filters first: stage, follow-up, last contacted', async () => {
    stubFetch({
      'GET /api/custom-tags': { items: [] },
      'GET /api/custom-fields/keys': { items: [] },
      'POST /api/leads/facets': ({ body }: { body: unknown }) => ({
        total: 30,
        segment: [], size: [], certifications: [], services: [], materials: [], customTags: [], accountStatus: [],
        // Counted without the stage selection itself.
        stages: (body as { filter: { stages?: string[] } }).filter.stages
          ? [{ value: 'quoting', count: 2 }]
          : [{ value: 'new', count: 20 }, { value: 'contacted', count: 0 }, { value: 'interested', count: 6 }, { value: 'quoting', count: 4 }],
      }),
    });
    const user = userEvent.setup();
    const { search } = renderLeads(<Harness />);

    const first = screen.getAllByRole('button', { expanded: true })[0]!;
    expect(first).toHaveTextContent(/^Sales/);
    await user.click(await screen.findByRole('button', { name: /^Interested, 6 leads/ }));
    await user.click(screen.getByRole('button', { name: /^Quoting, 4 leads/ }));
    expect(screen.getByRole('button', { name: /^Contacted, 0 leads/ })).toBeDisabled();
    expect(params(search()).getAll('stage')).toEqual(['interested', 'quoting']);

    await user.click(within(screen.getByRole('radiogroup', { name: 'Follow-up' })).getByRole('radio', { name: 'Overdue' }));
    expect(params(search()).get('followUp')).toBe('overdue');

    const lastContacted = screen.getByRole('radiogroup', { name: 'Last contacted' });
    await user.click(within(lastContacted).getByRole('radio', { name: '30+ days' }));
    const d = new Date();
    d.setDate(d.getDate() - 30);
    expect(params(search()).get('notContactedSince')).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    expect(within(lastContacted).getByRole('radio', { name: '30+ days' })).toHaveAttribute('aria-checked', 'true');

    await user.click(within(lastContacted).getByRole('radio', { name: 'Never' }));
    expect(params(search()).get('unserviced')).toBe('team');
    expect(params(search()).has('notContactedSince')).toBe(false);
    await user.click(within(lastContacted).getByRole('radio', { name: 'Any' }));
    expect(params(search()).has('unserviced')).toBe(false);
  });

  it('shows facet counts, hides services nothing matches and leaves a selected facet’s own options open', async () => {
    const facetBodies: unknown[] = [];
    stubFetch({
      'GET /api/custom-tags': { items: [] },
      'GET /api/custom-fields/keys': { items: [] },
      'POST /api/leads/facets': ({ body }: { body: unknown }) => {
        const f = (body as { filter: { segment?: string[] } }).filter;
        facetBodies.push(f);
        return {
          total: f.segment ? 12 : 40,
          // With "growth" selected the other segments still count (the facet's own selection is left out).
          segment: [{ value: 'growth', count: 12 }, { value: 'strategic', count: 28 }],
          size: [{ value: 'small', count: 9 }],
          certifications: [{ value: 'gaf:master_elite', count: 5 }],
          services: [{ value: 'roof_repair', count: 7 }],
          materials: [],
          customTags: [],
          accountStatus: [{ value: 'prospect', count: 40 }],
        };
      },
    });
    const user = userEvent.setup();
    renderLeads(<Harness />, '/leads?segment=growth');
    expect(await screen.findByRole('button', { name: /^Strategic, 28 leads/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Growth, 12 leads/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Emerging, 0 leads/ })).toBeDisabled();
    expect(facetBodies).toContainEqual({});
    await user.click(screen.getByRole('button', { name: /^Services/ }));
    expect(screen.getByRole('button', { name: /^Roof repair, 7 leads/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Gutters/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Roof materials/ }));
    expect(screen.getByText('No roof materials listed for these leads.')).toBeInTheDocument();
  });
});

