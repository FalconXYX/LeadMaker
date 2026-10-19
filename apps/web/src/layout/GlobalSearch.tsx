import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Building2, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import * as ep from '@/api/endpoints';
import { qk } from '@/api/queries';
import type { LeadSummary } from '@/api/types';
import { SegmentBadge, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { leadsHref, searchParamsToFilter } from '@/lib/filterUrl';

const MIN_CHARS = 2;
const SUGGESTIONS = 6;

/**
 * Top-bar lead search: suggestions as you type (arrow keys + Enter open a lead), Enter on its own opens
 * Leads filtered by business name. "/" focuses it from anywhere. Below lg it folds into a search button that
 * opens the field over the top bar.
 */
export function GlobalSearch() {
  const navigate = useNavigate();
  const location = useLocation();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLFormElement>(null);
  const listId = useId();
  const onLeads = location.pathname === '/leads';
  const urlText = onLeads ? (new URLSearchParams(location.search).get('q') ?? '') : '';
  const [text, setText] = useState(urlText);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [debounced, setDebounced] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => setText(urlText), [urlText]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 200);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setExpanded(true);
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        if (!input.current?.value) setExpanded(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const query = debounced.length >= MIN_CHARS ? debounced : '';
  const suggestions = useQuery({
    queryKey: [...qk.leads.lists, 'typeahead', query],
    queryFn: ({ signal }) => ep.searchLeads({ text: query, limit: SUGGESTIONS }, { signal }),
    enabled: open && !!query,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const items: LeadSummary[] = query && Array.isArray(suggestions.data?.items) ? suggestions.data.items.slice(0, SUGGESTIONS) : [];
  const total = typeof suggestions.data?.total === 'number' ? suggestions.data.total : null;
  const showList = open && text.trim().length >= MIN_CHARS;
  // Options: the leads, then "See all results" (index items.length).
  const optionCount = items.length + 1;

  useEffect(() => setActive(-1), [query]);

  const searchAll = () => {
    const q = text.trim();
    // Keep the other list filters when already on Leads; start fresh from elsewhere.
    const base = onLeads ? searchParamsToFilter(new URLSearchParams(location.search)) : {};
    setOpen(false);
    setExpanded(false);
    navigate(leadsHref({ ...base, text: q || undefined }));
  };

  const openLead = (lead: LeadSummary) => {
    setOpen(false);
    setExpanded(false);
    setText('');
    input.current?.blur();
    navigate(`/leads/${encodeURIComponent(lead.id)}`);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (showList && active >= 0 && active < items.length) openLead(items[active]!);
    else searchAll();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (showList) {
        e.preventDefault();
        setOpen(false);
      } else {
        e.currentTarget.blur();
        setExpanded(false);
      }
    } else if (e.key === 'ArrowDown' && text.trim().length >= MIN_CHARS) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % optionCount);
    } else if (e.key === 'ArrowUp' && showList) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? optionCount - 1 : a - 1));
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const loading = showList && (suggestions.isFetching || debounced !== text.trim()) && !items.length;

  const expand = () => {
    setExpanded(true);
    requestAnimationFrame(() => input.current?.focus());
  };

  return (
    <>
      <button
        type="button"
        onClick={expand}
        aria-label="Search leads"
        className="inline-flex size-10 items-center justify-center rounded-lg text-topbar-muted hover:bg-topbar-hover hover:text-topbar-fg lg:hidden"
      >
        <Search className="size-[18px]" aria-hidden />
      </button>
      <form
        ref={root}
        role="search"
        onSubmit={submit}
        className={cn(
          'lg:relative lg:block lg:w-64 xl:w-80',
          expanded
            ? 'max-lg:absolute max-lg:inset-x-0 max-lg:top-0 max-lg:z-10 max-lg:flex max-lg:h-14 max-lg:items-center max-lg:gap-1 max-lg:bg-topbar max-lg:px-3 sm:max-lg:px-5'
            : 'max-lg:hidden',
        )}
      >
        {expanded && (
          <button
            type="button"
            aria-label="Close search"
            onClick={() => {
              setOpen(false);
              setExpanded(false);
            }}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-topbar-fg hover:bg-topbar-hover lg:hidden"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </button>
        )}
        <div className="relative min-w-0 flex-1">
          <label htmlFor="global-search" className="sr-only">Search leads by business name</label>
          <input
            id="global-search"
            ref={input}
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Search leads…"
            autoComplete="off"
            spellCheck={false}
            className={cn(
              'peer h-10 w-full rounded-lg border border-topbar-border bg-topbar-field pr-10 pl-9 text-sm text-topbar-fg transition-colors lg:h-9',
              'placeholder:text-topbar-muted hover:border-topbar-muted',
              'focus:border-accent focus:bg-surface focus:text-fg focus:ring-2 focus:ring-accent/50 focus:outline-none focus:placeholder:text-subtle',
              '[&::-webkit-search-cancel-button]:hidden',
            )}
          />
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-topbar-muted peer-focus:text-muted" aria-hidden />
          <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border border-topbar-border px-1.5 text-[11px] text-topbar-muted peer-focus:border-border peer-focus:text-subtle lg:block">/</kbd>

          {showList && (
            <div className="absolute inset-x-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-lg animate-[lm-pop-in_120ms_ease-out] max-lg:fixed max-lg:inset-x-3 max-lg:top-[3.75rem] lg:left-auto lg:w-[max(100%,400px)]">
              <ul id={listId} role="listbox" aria-label="Matching leads" className="max-h-[min(420px,60vh)] overflow-y-auto py-1.5">
                {loading && (
                  <li role="presentation" className="flex items-center gap-2 px-3.5 py-3 text-sm text-muted">
                    <Spinner size={14} label="Searching" /> Searching…
                  </li>
                )}
                {!loading && query && items.length === 0 && !suggestions.isError && (
                  <li role="presentation" className="px-3.5 py-3 text-sm text-muted">No business names match “{text.trim()}”.</li>
                )}
                {items.map((lead, i) => (
                  <li
                    key={lead.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={active === i}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => openLead(lead)}
                    className={cn('flex cursor-pointer items-center gap-3 px-3.5 py-2.5', active === i && 'bg-hover')}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden>
                      <Building2 className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">{lead.businessName}</span>
                      <span className="block truncate text-xs text-muted">
                        {[lead.city, lead.state].filter(Boolean).join(', ') || 'Location unknown'}
                        {' · '}{lead.assignedRep ? lead.assignedRep.name : 'Unallocated'}
                      </span>
                    </span>
                    <SegmentBadge segment={lead.segment} className="shrink-0" />
                  </li>
                ))}
                <li
                  id={optionId(items.length)}
                  role="option"
                  aria-selected={active === items.length}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(items.length)}
                  onClick={searchAll}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 border-t border-divider px-3.5 py-3 text-sm font-medium text-accent',
                    items.length === 0 && !loading && !query && 'border-t-0',
                    active === items.length && 'bg-hover',
                  )}
                >
                  <Search className="size-3.5" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    See all {total !== null && query ? `${total.toLocaleString('en-US')}${suggestions.data?.totalCapped ? '+' : ''} ` : ''}results for “{text.trim()}”
                  </span>
                  <ArrowRight className="size-3.5" aria-hidden />
                </li>
              </ul>
            </div>
          )}
        </div>
      </form>
    </>
  );
}
