import { cn } from '@/lib/cn';
import { SEGMENT_LABELS, isSegment } from '@/lib/labels';
import { Tooltip } from './Tooltip';

const SEGMENT_BAR: Record<string, string> = {
  strategic: 'bg-seg-strategic',
  growth: 'bg-seg-growth',
  emerging: 'bg-seg-emerging',
  long_tail: 'bg-seg-long-tail',
};

/** The bar colour for a segment (the accent without one). */
export const segmentBarClass = (segment: string | null | undefined) => (isSegment(segment) && SEGMENT_BAR[segment]) || 'bg-accent';

/** Priority score (0-100) with a meter in the segment's colour; the same everywhere a score shows. */
export function PriorityMeter({ score, segment, className }: { score: number | null | undefined; segment?: string | null; className?: string }) {
  if (score == null) return <Tooltip content="Not scored yet"><span className="text-subtle">—</span></Tooltip>;
  const pct = Math.max(0, Math.min(100, score));
  return (
    <Tooltip content={`Priority score ${score.toFixed(1)} of 100${isSegment(segment) ? ` · ${SEGMENT_LABELS[segment]} segment` : ''}`}>
      <div className={cn('flex items-center gap-2', className)}>
        <span className="w-7 text-right text-sm font-semibold tabular text-fg">{Math.round(score)}</span>
        <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-surface-3" aria-hidden>
          <span className={cn('absolute inset-y-0 left-0 rounded-full', segmentBarClass(segment))} style={{ width: `${pct}%` }} />
        </span>
      </div>
    </Tooltip>
  );
}
