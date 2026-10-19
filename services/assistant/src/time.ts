// Calendar helpers in a named time zone (user limits use the sales team's day, America/New_York; the Gemini
// free tier resets at midnight America/Los_Angeles).
export const SALES_TZ = 'America/New_York';
export const PACIFIC_TZ = 'America/Los_Angeles';

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(tz: string, at: Date): Record<string, number> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(at)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** The zone's offset from UTC at `at`, in ms (negative west of Greenwich). */
function offsetMs(tz: string, at: Date): number {
  const p = parts(tz, at);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** YYYY-MM-DD of `at` in the zone. */
export function dateIn(tz: string, at: Date): string {
  const p = parts(tz, at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The next midnight (start of tomorrow) in the zone, as an instant. */
export function nextMidnight(tz: string, at: Date): Date {
  const p = parts(tz, at);
  const guess = Date.UTC(p.year!, p.month! - 1, p.day! + 1, 0, 0, 0);
  let instant = guess - offsetMs(tz, new Date(guess));
  instant = guess - offsetMs(tz, new Date(instant));
  return new Date(instant);
}

/** "3:00 AM" in the zone. */
export function clockTime(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at);
}

/** Weekday name of `at` in the zone ("Monday"). */
export function weekdayIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(at);
}

/** "today", "tomorrow" or the weekday ("Wednesday") of `at`, as seen from `now`, in the zone. */
export function dayWord(tz: string, at: Date, now: Date): string {
  const a = dateIn(tz, at);
  if (a === dateIn(tz, now)) return 'today';
  if (a === dateIn(tz, new Date(now.getTime() + 24 * 3600_000))) return 'tomorrow';
  return `on ${weekdayIn(tz, at)}`;
}
