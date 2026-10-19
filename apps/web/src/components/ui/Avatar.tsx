import { cn } from '@/lib/cn';

const TONES = 6;

export function initials(name: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '?';
}

/** Initials avatar with a stable per-name colour from the theme. */
export function Avatar({ name, size = 28, className }: { name: string; size?: number; className?: string }) {
  let h = 2166136261;
  for (const ch of name ?? '') h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const tone = (h % TONES) + 1;
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-wide', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: `var(--c-avatar-${tone})`, color: 'var(--c-avatar-fg)' }}
    >
      {initials(name)}
    </span>
  );
}
