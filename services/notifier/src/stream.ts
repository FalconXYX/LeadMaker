import { isUuid } from '@leadmaker/shared';

/** A relayed outbox event (stream fields as the relay writes them: id, type, company_id, payload, created_at). */
export type NotifierEvent = {
  streamId: string;
  /** outbox_events.id: the dedupe key, stable across the relay's at-least-once republishing. */
  outboxId: string;
  type: string;
  companyId: string | null;
  payload: Record<string, unknown>;
};

const OUTBOX_ID = /^\d{1,19}$/;

export function parseEntry(streamId: string, fields: string[]): NotifierEvent | null {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  if (!f.type || !OUTBOX_ID.test(f.id ?? '')) return null;
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(f.payload ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {
    return null;
  }
  const company = f.company_id || payload.company_id;
  return { streamId, outboxId: f.id, type: f.type, companyId: isUuid(company) ? company.toLowerCase() : null, payload };
}

export const uuidOrNull = (v: unknown): string | null => (isUuid(v) ? v.toLowerCase() : null);
