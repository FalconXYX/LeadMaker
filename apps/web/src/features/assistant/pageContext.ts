// What the assistant knows about where the user is: the page, the open lead, the list's filter, and the
// suggestions that fit there.
import { useMemo } from 'react';
import { matchPath, useLocation } from 'react-router';
import { useLead } from '@/api/queries';
import type { LeadFilter, TimingBadge } from '@/api/types';
import { searchParamsToFilter } from '@/lib/filterUrl';
import type { AssistantPage, AssistantRequestContext } from './api';
import { describeFilter } from './filters';

export type SuggestionIcon = 'summary' | 'contact' | 'storm' | 'search' | 'priority';

export interface Suggestion {
  prompt: string;
  icon: SuggestionIcon;
}

export interface PageContext {
  page: AssistantPage;
  leadId?: string;
  /** The open lead's name, once its profile has loaded. */
  leadName?: string | null;
  filter?: LeadFilter;
  /** Active filter values on the list, counted like its chips ("Filters 4"). */
  filterCount: number;
  /** Changes whenever the request context would. */
  key: string;
  /** Changes when the user moves to another page or lead (not when a filter changes). */
  placeKey: string;
  request: AssistantRequestContext;
  suggestionsTitle: string;
  suggestions: Suggestion[];
  placeholder: string;
}

const PROFILE_SUGGESTIONS: Suggestion[] = [
  { prompt: 'Summarize this contractor', icon: 'summary' },
  { prompt: 'Who should I contact and why?', icon: 'contact' },
];

const shortDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The pitch question, worded from the lead's own timing data: a storm framing only when the timing layer has one
 * (product review M4: "before the storm" was offered on every profile, storm or not, and the model went along).
 */
export function pitchSuggestion(timing: readonly TimingBadge[] | undefined): Suggestion {
  const active = timing?.find((b) => b.key === 'storm_response');
  if (active) {
    const event = /^(.+?(?:Warning|Watch|Advisory))\b/.exec(active.reason ?? '')?.[1];
    return { prompt: event ? `What should I pitch while the ${event} is on?` : 'What should I pitch for storm repairs right now?', icon: 'storm' };
  }
  const recent = timing?.find((b) => b.key === 'recent_storm');
  if (recent) {
    const day = /latest (\d{4}-\d{2}-\d{2})/.exec(recent.reason ?? '')?.[1];
    const when = day ? shortDay.format(new Date(`${day}T12:00:00Z`)) : null;
    return { prompt: when ? `What should I pitch after the ${when} storm reports?` : 'What should I pitch after the recent storms?', icon: 'storm' };
  }
  return { prompt: 'What should I pitch to them?', icon: 'priority' };
}

const LEADS_SUGGESTIONS: Suggestion[] = [
  { prompt: 'Commercial flat-roof contractors in Bergen County with 4.5+ rating', icon: 'search' },
  { prompt: 'Storm-restoration roofers I haven’t contacted', icon: 'search' },
  { prompt: 'Master Elite contractors doing metal roofs that I haven’t checked yet', icon: 'search' },
];

const DASHBOARD_SUGGESTIONS: Suggestion[] = [
  { prompt: 'Which of my leads should I call first today, and why?', icon: 'priority' },
  { prompt: 'Storm-restoration roofers I haven’t contacted', icon: 'search' },
  { prompt: 'Commercial flat-roof contractors in Bergen County with 4.5+ rating', icon: 'search' },
];

const ALLOCATION_SUGGESTIONS: Suggestion[] = [
  { prompt: 'Unallocated Master Elite contractors in Bergen County', icon: 'search' },
  { prompt: 'Unallocated storm-restoration roofers updated in the last poll', icon: 'search' },
];

export function pageOf(pathname: string): { page: AssistantPage; leadId?: string } {
  const lead = matchPath('/leads/:id', pathname);
  if (lead?.params.id) return { page: 'profile', leadId: lead.params.id };
  if (matchPath('/leads', pathname)) return { page: 'leads' };
  if (matchPath('/allocation', pathname)) return { page: 'allocation' };
  return { page: 'dashboard' };
}

export function placeKey(ctx: AssistantRequestContext): string {
  return `${ctx.page}:${ctx.leadId ?? ''}`;
}

export function usePageContext(open: boolean): PageContext {
  const { pathname, search } = useLocation();
  const { page, leadId } = pageOf(pathname);
  // Shares the profile page's query (same key), so this is a cache read on a profile.
  const lead = useLead(open && leadId ? leadId : undefined);
  const leadName = leadId ? lead.data?.fields.business_name.value ?? null : undefined;
  const timing = leadId ? lead.data?.timing : undefined;

  return useMemo<PageContext>(() => {
    const filter = page === 'leads' ? searchParamsToFilter(new URLSearchParams(search)) : undefined;
    const request: AssistantRequestContext = { page, ...(leadId ? { leadId } : {}), ...(filter ? { filter } : {}) };
    const filterCount = filter ? describeFilter(filter).filter((c) => c.id !== 'scope' && c.id !== 'sort').length : 0;
    const base = { page, leadId, leadName, filter, filterCount, request, key: JSON.stringify(request), placeKey: placeKey(request) };
    switch (page) {
      case 'profile':
        return {
          ...base,
          suggestionsTitle: leadName ? `Ask about ${leadName}` : 'Ask about this lead',
          suggestions: [...PROFILE_SUGGESTIONS, pitchSuggestion(timing)],
          placeholder: leadName ? `Ask about ${leadName}…` : 'Ask about this lead…',
        };
      case 'leads':
        return { ...base, suggestionsTitle: 'Find leads like…', suggestions: LEADS_SUGGESTIONS, placeholder: 'Describe the leads you want…' };
      case 'allocation':
        return { ...base, suggestionsTitle: 'Find leads to allocate', suggestions: ALLOCATION_SUGGESTIONS, placeholder: 'Describe the leads you want…' };
      default:
        return { ...base, suggestionsTitle: 'Try asking', suggestions: DASHBOARD_SUGGESTIONS, placeholder: 'Ask about your territory or find leads…' };
    }
  }, [page, leadId, leadName, timing, search]);
}
