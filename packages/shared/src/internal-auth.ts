// Gateway -> internal service hop. The gateway verifies the JWT and forwards who the user is in these
// headers together with the shared INTERNAL_TOKEN; internal services trust nothing else.
import { timingSafeEqual } from 'node:crypto';
import { ROLES, type Role, type Viewer } from './visibility.ts';

export const HEADER_USER_ID = 'x-user-id';
export const HEADER_USER_ROLE = 'x-user-role';
export const HEADER_INTERNAL_TOKEN = 'x-internal-token';

export const DEV_INTERNAL_TOKEN = 'dev-internal-token-change-me';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** INTERNAL_TOKEN, falling back to the local demo value outside production. */
export function internalToken(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INTERNAL_TOKEN) return env.INTERNAL_TOKEN;
  if (env.NODE_ENV === 'production') throw new Error('INTERNAL_TOKEN is not set');
  return DEV_INTERNAL_TOKEN;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export type InternalAuthResult =
  | { ok: true; viewer: Viewer }
  | { ok: false; status: 401; error: string };

/** Validates the internal hop headers (lower-cased names, as Node delivers them). */
export function authenticateInternal(headers: Headers, expectedToken: string): InternalAuthResult {
  const token = header(headers, HEADER_INTERNAL_TOKEN);
  if (!token || !sameSecret(token, expectedToken)) return { ok: false, status: 401, error: 'invalid internal token' };
  const id = header(headers, HEADER_USER_ID);
  const role = header(headers, HEADER_USER_ROLE);
  if (!isUuid(id)) return { ok: false, status: 401, error: 'missing or invalid X-User-Id' };
  if (!ROLES.includes(role as Role)) return { ok: false, status: 401, error: 'missing or invalid X-User-Role' };
  return { ok: true, viewer: { id: id.toLowerCase(), role: role as Role } };
}
