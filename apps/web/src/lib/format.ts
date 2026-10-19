const nf = new Intl.NumberFormat('en-US');
const df = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const dtf = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

export const formatNumber = (n: number | null | undefined) => (n == null ? '—' : nf.format(n));

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : df.format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dtf.format(d);
}

/** "3 min ago", "yesterday", "in 2 days". */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 30 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return formatDate(iso);
}

/** 'storm_damage' / 'service:metal_roofing' -> 'Storm damage' / 'Metal roofing'. */
export function humanize(key: string): string {
  const last = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
  const s = last.replace(/[_-]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : key;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
