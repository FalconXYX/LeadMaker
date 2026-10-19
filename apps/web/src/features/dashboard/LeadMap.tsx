import { DomEvent, latLngBounds, type FitBoundsOptions, type LatLngTuple } from 'leaflet';
import { ArrowRight, ChevronDown, List, Map as MapIcon, Maximize2, MapPinOff } from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleMarker, Popup, useMap } from 'react-leaflet';
import { Link } from 'react-router';
import { errorMessage } from '@/api/errors';
import type { LeadSummary, TimingBadge as TimingBadgeData, UserRef } from '@/api/types';
import { BaseMap } from '@/components/map/BaseMap';
import {
  Badge, Card, EmptyState, ErrorState, SegmentBadge, Segmented, Spinner, TBody, TD, TH, THead, TR, Table, TimingBadge, Tooltip,
  buttonClasses,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { countyName } from '@/lib/counties';
import { formatNumber } from '@/lib/format';
import { SEGMENTS, SEGMENT_LABELS, TIMING_SEVERITY_LABELS, isSegment, readableWeatherText } from '@/lib/labels';
import { useStoredState } from './hooks';
import { actionableBadge } from './hazards';
import { useThemeColors, type ThemeColors } from './useThemeColors';
import './dashboard.css';

export type ColorBy = 'segment' | 'owner';
type View = 'map' | 'list';

/** One marker: a GET /api/leads/map point, with the owner's name and the full row when the page has it. */
export interface MapLead {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  segment: string | null;
  priorityScore: number | null;
  owner: UserRef | null;
  countyFips: string | null;
  /** The most severe timing badge's severity (the marker ring). */
  severity: TimingBadgeData['severity'] | null;
  /** The lead's list row, for the popup's place and timing reason. */
  summary?: LeadSummary;
}

export interface LeadMapProps {
  /** Every lead to plot: a rep's own (+ the pool when shown), or all leads for a manager. */
  leads: readonly MapLead[];
  variant: 'rep' | 'manager';
  isLoading: boolean;
  /** The pool layer is still loading (rep with the pool switched on). */
  poolLoading?: boolean;
  error: unknown;
  onRetry: () => void;
  /** Collapsed, only the header shows (and the parent can skip loading the points). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Extra header controls (a rep's pool switch). */
  controls?: ReactNode;
  /** Whose leads, for the summary: "your" or a rep's name with "'s". */
  whose?: string;
  /** "Open the full list" from the list view. */
  listHref: string;
  className?: string;
}

const LIST_LIMIT = 100;
const radiusFor = (priority: number | null) => 4 + Math.max(0, Math.min(100, priority ?? 0)) / 100 * 6;
const validPoint = (l: MapLead) =>
  Number.isFinite(l.latitude) && Number.isFinite(l.longitude) && !(l.latitude === 0 && l.longitude === 0);

interface Owner { id: string; name: string; color: string; count: number }

/** Owner colours follow the rep (sorted by name), never their count, so a filter never repaints them. */
function ownersOf(leads: readonly MapLead[], colors: ThemeColors): Map<string, Owner> {
  const reps = new Map<string, Owner>();
  for (const l of leads) {
    if (!l.owner) continue;
    const o = reps.get(l.owner.id);
    if (o) o.count++;
    else reps.set(l.owner.id, { id: l.owner.id, name: l.owner.name, color: '', count: 1 });
  }
  const sorted = [...reps.values()].sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach((o, i) => { o.color = colors.owners[i % colors.owners.length]!; });
  return new Map(sorted.map((o) => [o.id, o]));
}

/** The ring's severity: the calendar `info` badge never counts. */
const ringOf = (l: MapLead) => (l.severity && l.severity !== 'info' ? l.severity : null);

export function LeadMapCard({ leads, variant, isLoading, poolLoading, error, onRetry, open, onOpenChange, controls, whose = 'your', listHref, className }: LeadMapProps) {
  const bodyId = useId();
  const colors = useThemeColors();
  const [view, setView] = useState<View>('map');
  const [colorBy, setColorBy] = useStoredState<ColorBy>('leadmaker.dashboard.mapColorBy', 'owner');
  const effectiveColorBy: ColorBy = variant === 'manager' ? colorBy : 'segment';
  const showOwner = variant === 'manager';

  const points = useMemo(() => leads.filter(validPoint), [leads]);
  const owners = useMemo(() => ownersOf(points, colors), [points, colors]);
  const poolCount = useMemo(() => points.filter((l) => !l.owner).length, [points]);

  const colorOf = (l: MapLead): string => {
    if (effectiveColorBy === 'owner') return l.owner ? owners.get(l.owner.id)?.color ?? colors.subtle : colors.subtle;
    return isSegment(l.segment) ? colors[l.segment] : colors.subtle;
  };
  const isPool = (l: MapLead) => variant === 'rep' && !l.owner;

  const mine = points.length - poolCount;
  const summary = isLoading && !leads.length ? 'Loading leads…'
    : error && !leads.length ? 'Couldn’t load leads'
    : variant === 'manager'
      ? `${formatNumber(points.length)} leads · ${formatNumber(mine)} allocated · ${formatNumber(poolCount)} in the pool`
      : `${formatNumber(mine)} of ${whose} leads${poolCount ? ` + ${formatNumber(poolCount)} in the pool` : ''}`;

  // Pool first, then by priority, so your own and the highest-priority markers draw on top.
  const ordered = useMemo(() => {
    const layer = (l: MapLead) => (variant === 'rep' && !l.owner ? 0 : 1);
    return [...points].sort((a, b) => layer(a) - layer(b) || (a.priorityScore ?? 0) - (b.priorityScore ?? 0));
  }, [points, variant]);
  // Refit when the visible set changes (data, the pool layer) or the colour mode does; a live refetch with the
  // same leads keeps the viewer's view.
  const fitKey = `${variant}:${effectiveColorBy}:${points.length}:${poolCount}`;
  // The map opens on the leads (BaseMap passes it to MapContainer, read once at creation).
  const initialBounds = useMemo(() => (points.length ? boundsOf(points) : undefined), [points]);

  return (
    <Card className={cn('flex flex-col overflow-hidden', className)}>
      <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 py-3.5 sm:px-6 sm:py-4', open && 'border-b border-border')}>
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="group flex min-w-0 items-center gap-2.5 text-left"
        >
          <ChevronDown className={cn('size-4 shrink-0 text-muted transition-transform', !open && '-rotate-90')} aria-hidden />
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold text-fg group-hover:text-accent">Territory map</span>
            <span className="block truncate text-sm text-muted">{open ? summary : `Hidden. Open it to see where ${whose} leads are.`}</span>
          </span>
        </button>
        {open && (
          <div className="flex flex-wrap items-center gap-2.5">
            {controls}
            {variant === 'manager' && (
              <Segmented
                size="sm"
                className="h-8"
                label="Colour markers by"
                value={colorBy}
                onChange={setColorBy}
                options={[{ value: 'owner', label: 'By owner' }, { value: 'segment', label: 'By segment' }]}
              />
            )}
            <Segmented
              size="sm"
              className="h-8"
              label="Show leads as"
              value={view}
              onChange={setView}
              options={[
                { value: 'map', label: <><MapIcon aria-hidden />Map</> },
                { value: 'list', label: <><List aria-hidden />List</> },
              ]}
            />
          </div>
        )}
      </div>

      {open && (
        <div id={bodyId} className="relative flex h-[360px] flex-col">
          {!leads.length && isLoading ? (
            <div className="flex flex-1 items-center justify-center bg-surface-2/60" aria-busy="true">
              <span className="flex items-center gap-2 text-sm text-muted"><Spinner size={16} /> Loading map…</span>
            </div>
          ) : !leads.length && error ? (
            <ErrorState className="flex-1 justify-center" message={errorMessage(error)} onRetry={onRetry} />
          ) : !points.length ? (
            <EmptyState
              className="flex-1"
              icon={<MapPinOff />}
              title="No leads to map yet"
              description={variant === 'rep' ? 'Leads your manager assigns to you will appear here. Switch on the pool to see unallocated leads.' : 'Leads appear here after the first pipeline run.'}
            />
          ) : view === 'map' ? (
            <div className="lm-dash-map absolute inset-0 isolate">
              <BaseMap
                bounds={initialBounds}
                boundsOptions={FIT_OPTIONS}
                label={`Map of ${summary}. Use the List view for a keyboard-friendly table.`}
                className="h-full rounded-none border-0"
              >
                <FitToLeads points={points} fitKey={fitKey} />
                {ordered.map((l) => {
                  const ring = ringOf(l);
                  const pool = isPool(l);
                  const color = colorOf(l);
                  const r = radiusFor(l.priorityScore);
                  const center: LatLngTuple = [l.latitude, l.longitude];
                  return (
                    <Fragment key={l.id}>
                      {ring && (
                        <CircleMarker
                          center={center}
                          radius={r + 4}
                          interactive={false}
                          pathOptions={{
                            color: colors[ring],
                            weight: ring === 'high' ? 2.5 : ring === 'medium' ? 2 : 1.25,
                            dashArray: ring === 'low' ? '2 3' : undefined,
                            fill: false,
                            opacity: pool ? 0.55 : 0.95,
                          }}
                        />
                      )}
                      <CircleMarker
                        center={center}
                        radius={r}
                        pathOptions={{
                          color: pool ? color : colors.surface,
                          weight: pool ? 1.25 : 1.5,
                          fillColor: color,
                          fillOpacity: pool ? 0.28 : 0.88,
                        }}
                      >
                        <Popup maxWidth={280} minWidth={220} autoPanPadding={[24, 24]}>
                          <LeadPopup lead={l} showOwner={showOwner} pool={pool} />
                        </Popup>
                      </CircleMarker>
                    </Fragment>
                  );
                })}
              </BaseMap>
              {poolLoading && (
                <span className="pointer-events-none absolute top-3 left-1/2 z-[500] flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted shadow-md">
                  <Spinner size={12} /> Loading the pool…
                </span>
              )}
            </div>
          ) : (
            <LeadList leads={points} showOwner={showOwner} variant={variant} listHref={listHref} />
          )}
        </div>
      )}

      {open && (
        <Legend
          colorBy={effectiveColorBy}
          owners={[...owners.values()]}
          leads={points}
          colors={colors}
          variant={variant}
          poolCount={poolCount}
        />
      )}
    </Card>
  );
}

/** Fit options: never closer than a town; the padding clears the corner controls on a wide card (fitOptions). */
export const FIT_OPTIONS: FitBoundsOptions = { padding: [28, 28], maxZoom: 12 };

/** Padding that scales with the map (16-44px): a phone-width map should not lose a zoom level to margins. */
const fitOptions = (size: { x: number; y: number }): FitBoundsOptions => {
  const pad = Math.round(Math.min(44, Math.max(16, Math.min(size.x, size.y) * 0.07)));
  return { ...FIT_OPTIONS, padding: [pad, pad] };
};

export const boundsOf = (points: readonly MapLead[]) =>
  latLngBounds(points.map((l) => [l.latitude, l.longitude] as LatLngTuple));

/**
 * Keeps the view fitted to the visible markers: on every `fitKey` change (data, pool, colour mode) and whenever
 * the container resizes (the card stretches with its grid row, fonts load), until the viewer pans or zooms.
 * Also renders the "Fit all leads" control, which re-enables auto-fit.
 */
function FitToLeads({ points, fitKey }: { points: readonly MapLead[]; fitKey: string }) {
  const map = useMap();
  const latest = useRef(points);
  latest.current = points;
  const userMoved = useRef(false);
  const fitting = useRef(false);

  const fit = useCallback((animate = false) => {
    const pts = latest.current;
    const size = map.getSize();
    if (!pts.length || !size.x || !size.y) return; // nothing to show, or not laid out yet (the resize observer retries)
    fitting.current = true;
    if (animate) {
      // An animated zoom fires zoomstart a frame later: stay "ours" until it settles.
      map.once('moveend', () => { fitting.current = false; });
      map.fitBounds(boundsOf(pts), { ...fitOptions(size), animate: true });
      return;
    }
    try {
      map.fitBounds(boundsOf(pts), { ...fitOptions(size), animate: false });
    } finally {
      fitting.current = false;
    }
  }, [map]);

  // A drag or zoom by the viewer (buttons, keyboard, double-click) stops the auto-fit until the next fitKey.
  useEffect(() => {
    const onUserMove = () => { if (!fitting.current) userMoved.current = true; };
    map.on('dragstart zoomstart', onUserMove);
    return () => { map.off('dragstart zoomstart', onUserMove); };
  }, [map]);

  useLayoutEffect(() => {
    userMoved.current = false;
    map.invalidateSize({ animate: false });
    fit();
  }, [fitKey, fit, map]);

  useEffect(() => {
    let frame = 0;
    let live = true;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!live) return;
        map.invalidateSize({ animate: false });
        if (!userMoved.current) fit();
      });
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    ro?.observe(map.getContainer());
    void document.fonts?.ready.then(onResize);
    return () => { live = false; cancelAnimationFrame(frame); ro?.disconnect(); };
  }, [map, fit]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) {
      DomEvent.disableClickPropagation(ref.current);
      DomEvent.disableScrollPropagation(ref.current);
    }
  }, []);
  return (
    <div className="leaflet-top leaflet-right">
      <div ref={ref} className="leaflet-control leaflet-bar">
        <Tooltip content="Fit all leads" describe={false}>
          <button
            type="button"
            aria-label="Fit all leads in view"
            onClick={() => { userMoved.current = false; fit(true); }}
            className="flex size-[30px] items-center justify-center bg-surface text-fg hover:bg-surface-2"
          >
            <Maximize2 className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

const placeOf = (l: MapLead) =>
  (l.summary ? [l.summary.city, l.summary.state].filter(Boolean).join(', ') : '') || (l.countyFips ? countyName(l.countyFips) : 'Location unknown');

function LeadPopup({ lead, showOwner, pool }: { lead: MapLead; showOwner: boolean; pool: boolean }) {
  const badge = actionableBadge(lead.summary?.timing);
  const ring = ringOf(lead);
  return (
    <div className="space-y-2.5">
      <div className="pr-4">
        <p className="m-0! text-sm leading-snug font-semibold text-fg">{lead.name}</p>
        <p className="m-0! mt-0.5! text-xs text-muted">
          {placeOf(lead)}
          {showOwner && <> · {lead.owner ? lead.owner.name : 'Unallocated'}</>}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="neutral" tooltip="Priority score (0-100)">Priority {lead.priorityScore == null ? '—' : Math.round(lead.priorityScore)}</Badge>
        <SegmentBadge segment={lead.segment} />
        {pool && <Badge variant="neutral">Unallocated</Badge>}
      </div>
      {badge ? (
        <div className="rounded-lg bg-surface-2 p-2">
          <TimingBadge badge={badge} />
          <p className="m-0! mt-1.5! line-clamp-4 text-xs text-muted">{readableWeatherText(badge.reason)}</p>
        </div>
      ) : ring ? (
        <Badge variant={`timing-${ring}`}>Timing: {TIMING_SEVERITY_LABELS[ring]}</Badge>
      ) : null}
      <Link to={`/leads/${lead.id}`} className={buttonClasses('primary', 'sm', 'w-full text-accent-fg! no-underline!')}>
        Open lead <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function LeadList({ leads, showOwner, variant, listHref }: { leads: readonly MapLead[]; showOwner: boolean; variant: 'rep' | 'manager'; listHref: string }) {
  const rows = useMemo(
    () => [...leads].sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0)).slice(0, LIST_LIMIT),
    [leads],
  );
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <Table aria-label="Mapped leads by priority">
          <THead>
            <tr>
              <TH className="w-full">Lead</TH>
              <TH className="hidden sm:table-cell">Segment</TH>
              <TH align="right">Priority</TH>
              <TH className="hidden md:table-cell">Timing</TH>
              {showOwner && <TH className="hidden lg:table-cell">Owner</TH>}
            </tr>
          </THead>
          <TBody>
            {rows.map((l) => {
              const badge = actionableBadge(l.summary?.timing);
              const ring = ringOf(l);
              return (
                <TR key={l.id}>
                  <TD className="w-full max-w-0">
                    <Link to={`/leads/${l.id}`} className="block truncate font-medium text-fg hover:text-accent hover:underline">{l.name}</Link>
                    <span className="block truncate text-xs text-muted">
                      {placeOf(l)}
                      {variant === 'rep' && !l.owner && ' · Pool'}
                    </span>
                  </TD>
                  <TD className="hidden sm:table-cell"><SegmentBadge segment={l.segment} /></TD>
                  <TD align="right" className="text-fg">{l.priorityScore == null ? '—' : Math.round(l.priorityScore)}</TD>
                  <TD className="hidden md:table-cell">
                    {badge ? <TimingBadge badge={badge} className="max-w-[220px]" />
                      : ring ? <Badge variant={`timing-${ring}`}>{TIMING_SEVERITY_LABELS[ring]}</Badge>
                      : <span className="text-xs text-subtle">—</span>}
                  </TD>
                  {showOwner && <TD className="hidden whitespace-nowrap text-muted lg:table-cell">{l.owner?.name ?? 'Unallocated'}</TD>}
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
      {leads.length > LIST_LIMIT && (
        <p className="border-t border-border bg-surface px-4 py-2.5 text-xs text-muted sm:px-6">
          Showing the top {LIST_LIMIT} of {formatNumber(leads.length)} by priority.{' '}
          <Link to={listHref} className="font-medium text-accent hover:underline">Open the full list</Link>
        </p>
      )}
    </div>
  );
}

function Dot({ color, size = 10, hollow, ring, dashed }: { color: string; size?: number; hollow?: boolean; ring?: boolean; dashed?: boolean }) {
  const s = size;
  return (
    <svg width={s + 6} height={s + 6} viewBox={`0 0 ${s + 6} ${s + 6}`} aria-hidden className="shrink-0">
      {ring ? (
        <circle cx={(s + 6) / 2} cy={(s + 6) / 2} r={s / 2 + 1} fill="none" stroke={color} strokeWidth={dashed ? 1.25 : 2} strokeDasharray={dashed ? '2 2' : undefined} />
      ) : (
        <circle cx={(s + 6) / 2} cy={(s + 6) / 2} r={s / 2} fill={color} fillOpacity={hollow ? 0.28 : 0.9} stroke={hollow ? color : 'none'} strokeWidth={1.25} />
      )}
    </svg>
  );
}

function Legend({
  colorBy, owners, leads, colors, variant, poolCount,
}: {
  colorBy: ColorBy; owners: Owner[]; leads: readonly MapLead[]; colors: ThemeColors; variant: 'rep' | 'manager'; poolCount: number;
}) {
  const segCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of leads) if (isSegment(l.segment)) m.set(l.segment, (m.get(l.segment) ?? 0) + 1);
    return m;
  }, [leads]);
  const item = 'inline-flex items-center gap-1 whitespace-nowrap';
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border px-4 py-3 text-xs text-muted sm:px-6" aria-label="Map legend">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {colorBy === 'segment'
          ? SEGMENTS.map((s) => (
            <span key={s} className={item}><Dot color={colors[s]} />{SEGMENT_LABELS[s]}<span className="text-subtle tabular">{formatNumber(segCounts.get(s) ?? 0)}</span></span>
          ))
          : (
            <>
              {owners.map((o) => (
                <span key={o.id} className={item}><Dot color={o.color} />{o.name}<span className="text-subtle tabular">{formatNumber(o.count)}</span></span>
              ))}
              <span className={item}><Dot color={colors.subtle} />Unallocated<span className="text-subtle tabular">{formatNumber(poolCount)}</span></span>
            </>
          )}
      </span>
      {variant === 'rep' && poolCount > 0 && (
        <span className={item}><Dot color={colors.subtle} />Yours<Dot color={colors.subtle} hollow />Pool</span>
      )}
      <Tooltip content="Marker size shows the priority score">
        <span className={item}>
          <Dot color={colors.subtle} size={6} /><Dot color={colors.subtle} size={12} />Priority
        </span>
      </Tooltip>
      <Tooltip content="A ring marks a weather or seasonality timing signal: act now, soon, or watch">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={item}><Dot color={colors.high} ring />{TIMING_SEVERITY_LABELS.high}</span>
          <span className={item}><Dot color={colors.medium} ring />{TIMING_SEVERITY_LABELS.medium}</span>
          <span className={item}><Dot color={colors.low} ring dashed />{TIMING_SEVERITY_LABELS.low}</span>
        </span>
      </Tooltip>
    </div>
  );
}
