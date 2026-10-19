import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import { Briefing, COLLAPSED_ROWS, MAX_ROWS } from '@/features/dashboard/Briefing';
import type { BriefingRow } from '@/features/dashboard/callList';
import { json, makeLead } from './fixtures';

vi.mock('@/features/tasks', () => ({ LogActivityDialog: () => null }));

const LONG = 'The Great American Roofing and Sheet Metal Company of Northern New Jersey LLC';

function rowsOf(count: number): BriefingRow[] {
  return Array.from({ length: count }, (_, i) => {
    const lead = makeLead({ businessName: i === 0 ? LONG : `Roofer ${i + 1}`, salesStage: 'interested' });
    return { key: `lead:${lead.id}`, kind: 'interested', leadId: lead.id, leadName: lead.businessName, task: null, lead, why: 'Interested, no contact in 9 days', detail: 'GAF Master Elite · 300+ reviews' };
  });
}

function renderBriefing(rows: BriefingRow[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Briefing scope="mine" rows={rows} isLoading={false} isFetchingMore={false} error={null} partialError={false} onRetry={() => {}} showOwner={false} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const items = () => within(screen.getByRole('list', { name: 'Today’s call list' })).getAllByRole('listitem');
const names = () => items().map((li) => within(li).getAllByRole('link')[0]!.textContent);

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'not_found' }, 404))));
afterEach(() => vi.unstubAllGlobals());

describe('Briefing: three leads first, the rest one click away', () => {
  it('shows 3 of 30 and opens up to 24 in place, keeping the order, then closes again', async () => {
    const rows = rowsOf(30);
    const user = userEvent.setup();
    renderBriefing(rows);
    expect(COLLAPSED_ROWS).toBe(3);
    expect(names()).toEqual(rows.slice(0, 3).map((r) => r.leadName));
    expect(screen.queryByRole('link', { name: /See every follow-up/ })).toBeNull();

    const more = screen.getByRole('button', { name: `Show ${MAX_ROWS - 3} more` });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(names()).toEqual(rows.slice(0, MAX_ROWS).map((r) => r.leadName));
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less).toBe(more);
    expect(less).toHaveAttribute('aria-expanded', 'true');
    // Past the cap, the full list lives on the follow-ups page.
    expect(screen.getByRole('link', { name: /See every follow-up/ })).toHaveAttribute('href', '/tasks');

    await user.click(less);
    expect(items()).toHaveLength(3);
    expect(screen.getByRole('button', { name: `Show ${MAX_ROWS - 3} more` })).toHaveAttribute('aria-expanded', 'false');
  });

  it('works from the keyboard', async () => {
    const user = userEvent.setup();
    renderBriefing(rowsOf(5));
    const toggle = screen.getByRole('button', { name: 'Show 2 more' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(items()).toHaveLength(5);
    expect(toggle).toHaveAccessibleName('Show less');
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(items()).toHaveLength(3);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('has no toggle when three or fewer leads are on the list', () => {
    renderBriefing(rowsOf(3));
    expect(items()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Show / })).toBeNull();
  });

  it('cuts long text with an ellipsis and keeps it in a tooltip', async () => {
    renderBriefing(rowsOf(4));
    const name = within(items()[0]!).getByRole('link', { name: LONG });
    expect(name).toHaveClass('truncate');
    expect(name).toHaveAttribute('title', LONG);
    const detail = within(items()[0]!).getByText('GAF Master Elite · 300+ reviews');
    expect(detail).toHaveClass('truncate');
    expect(detail).toHaveAttribute('title', 'GAF Master Elite · 300+ reviews');
    await waitFor(() => expect(within(items()[0]!).getByText('Hackensack, NJ').closest('p')).toHaveAttribute('title', 'Hackensack, NJ'));
  });
});
