import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { coerceFilter, describeFilter, sameFilter } from '@/features/assistant/filters';
import { Markdown, isLeadHref } from '@/features/assistant/markdown';
import { buildHistory, type ChatMessage } from '@/features/assistant/state';

const LEAD = 'c0ffee00-0000-4000-8000-000000000001';

function md(text: string) {
  return render(<MemoryRouter><Markdown text={text} /></MemoryRouter>).container;
}

describe('Markdown (untrusted model output)', () => {
  it('renders bold, italic, code, bullet and numbered lists', () => {
    const c = md('**Acme** is *busy*. Tag `service:metal_roofing`.\n\n- one\n- two\n\n1. first\n2. second');
    expect(screen.getByText('Acme').tagName).toBe('STRONG');
    expect(screen.getByText('busy').tagName).toBe('EM');
    expect(screen.getByText('service:metal_roofing').tagName).toBe('CODE');
    expect(c.querySelectorAll('ul > li')).toHaveLength(2);
    expect(c.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('shows HTML literally instead of parsing it', () => {
    const c = md('<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>');
    expect(c.querySelector('script, img, a')).toBeNull();
    expect(c.textContent).toContain('<script>alert(1)</script>');
  });

  it('links only to lead profiles; other links keep their text and lose the URL', () => {
    const c = md(`[Acme](/leads/${LEAD}) [Contacts](/leads/${LEAD}?tab=contacts) [bad](javascript:alert(1)) [ext](https://evil.example) [rel](/allocation) [proto](//evil.example/leads/x)`);
    const links = [...c.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/leads/${LEAD}`, `/leads/${LEAD}?tab=contacts`]);
    expect(c.textContent).toContain('bad');
    expect(c.textContent).not.toContain('evil.example');
    expect(isLeadHref('/leads/../admin')).toBe(false);
  });

  it('leaves unclosed markers (mid-stream) as plain text', () => {
    const c = md('**half bold and [half link](/lea');
    expect(c.querySelector('strong, a')).toBeNull();
    expect(c.textContent).toBe('**half bold and [half link](/lea');
  });
});

describe('filters', () => {
  it('coerceFilter keeps valid facets, drops junk, and lets a separate sort win', () => {
    expect(coerceFilter({
      services: ['storm_damage', 5], minRating: 'high', segment: ['strategic', 'nope'], near: { zip: '07601', radiusMiles: 10 },
      sort: { by: 'priority_score', dir: 'desc' }, evil: '<script>', updatedInLastPoll: true,
    }, { by: 'distance', dir: 'asc' })).toEqual({
      services: ['storm_damage'], segment: ['strategic'], near: { zip: '07601', radiusMiles: 10 }, sort: { by: 'distance', dir: 'asc' },
      updatedInLastPoll: true, // the list URL carries it now (?new=1)
    });
    expect(coerceFilter('nope')).toBeNull();
    expect(coerceFilter({ sort: { by: 'distance', dir: 'asc' } })).toEqual({}); // distance needs near
  });

  it('describeFilter names every applied value, including view and sort', () => {
    const chips = describeFilter({ scope: 'unallocated', services: ['storm_damage'], minRating: 4.5, unserviced: 'me', sort: { by: 'rating', dir: 'desc' } });
    expect(chips.map((c) => `${c.facet}: ${c.label}`)).toEqual([
      'View: Unallocated', 'Service: Storm damage', 'Rating: 4.5+ ★', 'Never contacted: by me', 'Sort: Rating ↓',
    ]);
  });

  it('sameFilter ignores value order', () => {
    expect(sameFilter({ services: ['a', 'b'], minRating: 4 }, { minRating: 4, services: ['b', 'a'] })).toBe(true);
    expect(sameFilter({ services: ['a'], minRating: 4 }, { services: ['a'], minRating: 4.5 })).toBe(false);
  });
});

describe('buildHistory', () => {
  it('sends completed exchanges only, so roles alternate', () => {
    const msgs: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'q1', context: { page: 'dashboard' }, contextLabel: null },
      { id: 'a1', role: 'assistant', parts: [{ kind: 'text', id: 't', text: 'a1' }], citations: [], status: 'done' },
      { id: 'u2', role: 'user', content: 'q2', context: { page: 'dashboard' }, contextLabel: null },
      { id: 'a2', role: 'assistant', parts: [], citations: [], status: 'unavailable' },
    ];
    expect(buildHistory(msgs, 'q3')).toEqual([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q3' },
    ]);
  });
});
