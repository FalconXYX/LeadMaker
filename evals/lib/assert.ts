// The eval assertion DSL (evals/README.md): evaluates a case's `expect` against one normalized assistant output.
// Pure functions, no I/O, so the DSL itself is unit-tested (assert.test.ts).
import type { Expect, ExpectBase, FilterAssert, FilterAssertBase, TextAssert, ToolOutcome } from './cases.ts';

export type Role = 'rep' | 'manager';

/** What a case produced, reduced to what the DSL looks at. */
export interface CaseOutput {
  tool: ToolOutcome;
  /** The applied (or findLeads) filter with sort merged back in; null when no filter was produced. */
  filter: Record<string, unknown> | null;
  /** The streamed answer (citation tags already stripped by the server). */
  text: string;
  explanation: string | null;
  /** apply_filter's matchCount (null without one). */
  matchCount?: number | null;
  /** citation.field values, in order. */
  citations: string[];
  outcome: 'done' | 'error' | 'none';
  errorCode: string | null;
}

export interface AssertContext {
  role: Role;
  /** "now" for dateDaysAgo: the pinned eval clock offline and in-process, the wall clock over the gateway. */
  now: Date;
}

export const DEFAULT_SCOPE: Record<Role, string> = { rep: 'mine', manager: 'all' };
export const TIME_ZONE = 'America/New_York';

// ------------------------------------------------------------------ helpers

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/** Arrays sorted (by stable JSON) all the way down; objects copied. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep).sort((x, y) => (stable(x) < stable(y) ? -1 : stable(x) > stable(y) ? 1 : 0));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, sortDeep(x)]));
  }
  return v;
}

/** Every path an expectation names (anyOf branches included), so the default scope is kept when asserted. */
export function assertedPaths(e: FilterAssert | FilterAssertBase | undefined): Set<string> {
  const out = new Set<string>();
  if (!e) return out;
  for (const m of [e.includes, e.setEquals, e.excludes, e.range, e.matches, e.dateDaysAgo]) for (const k of Object.keys(m ?? {})) out.add(k);
  for (const k of e.absent ?? []) out.add(k);
  for (const sub of (e as FilterAssert).anyOf ?? []) for (const k of assertedPaths(sub)) out.add(k);
  return out;
}

/** Arrays sorted; the role's default scope (rep "mine", manager "all") removed unless `keepScope`. */
export function normalizeFilter(filter: Record<string, unknown> | null, role: Role, keepScope = false): Record<string, unknown> | null {
  if (!filter) return null;
  const f = sortDeep(filter) as Record<string, unknown>;
  if (!keepScope && f.scope === DEFAULT_SCOPE[role]) delete f.scope;
  return f;
}

/** YYYY-MM-DD of a date in America/New_York. */
export function etDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/** The ET calendar date of an ISO date or date-time value; null when unparseable. */
export function isoToEtDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : etDate(new Date(t));
}

const re = (s: string) => new RegExp(s, 'i');
const LINK = /\/leads\/[A-Za-z0-9-]+/g;

export function countLeadLinks(text: string): number {
  return new Set(text.match(LINK) ?? []).size;
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

// ------------------------------------------------------------------ operators

export function checkText(label: string, a: TextAssert | undefined, text: string | null): string[] {
  if (!a) return [];
  const t = text ?? '';
  const out: string[] = [];
  for (const p of a.mustMatch ?? []) if (!re(p).test(t)) out.push(`${label}: does not match /${p}/i`);
  for (const p of a.mustNotMatch ?? []) if (re(p).test(t)) out.push(`${label}: matches forbidden /${p}/i`);
  if (a.maxWords !== undefined && wordCount(t) > a.maxWords) out.push(`${label}: ${wordCount(t)} words > ${a.maxWords}`);
  if (a.maxChars !== undefined && t.length > a.maxChars) out.push(`${label}: ${t.length} chars > ${a.maxChars}`);
  const links = countLeadLinks(t);
  if (a.minLinks !== undefined && links < a.minLinks) out.push(`${label}: ${links} lead links < ${a.minLinks}`);
  if (a.maxLinks !== undefined && links > a.maxLinks) out.push(`${label}: ${links} lead links > ${a.maxLinks}`);
  return out;
}

function checkFilterBase(e: FilterAssertBase, f: Record<string, unknown> | null, ctx: AssertContext, label = 'filter'): string[] {
  const out: string[] = [];
  const has = Object.keys(e).some((k) => (e as Record<string, unknown>)[k] !== undefined);
  if (!has) return out;
  if (!f) {
    // Only "absent" style checks can pass without a filter.
    const onlyAbsent = Object.entries(e).every(([k, v]) => v === undefined || k === 'absent' || k === 'onlyKeys');
    return onlyAbsent ? [] : [`${label}: no filter was produced`];
  }
  for (const [path, exp] of Object.entries(e.includes ?? {})) {
    const act = getPath(f, path);
    if (Array.isArray(exp)) {
      if (!Array.isArray(act)) out.push(`${label}.${path}: expected an array including ${stable(exp)}, got ${stable(act)}`);
      else {
        const missing = exp.filter((x) => !act.some((y) => deepEqual(x, y)));
        if (missing.length) out.push(`${label}.${path}: missing ${stable(missing)} (got ${stable(act)})`);
      }
    } else if (!deepEqual(act, exp)) out.push(`${label}.${path}: expected ${stable(exp)}, got ${stable(act)}`);
  }
  for (const [path, exp] of Object.entries(e.setEquals ?? {})) {
    const act = getPath(f, path);
    const want = new Set(exp.map(stable));
    const got = Array.isArray(act) ? new Set(act.map(stable)) : null;
    const ok = got !== null && got.size === want.size && [...want].every((x) => got.has(x));
    if (!ok) out.push(`${label}.${path}: expected exactly ${stable(sortDeep(exp))}, got ${stable(act)}`);
  }
  for (const [path, bad] of Object.entries(e.excludes ?? {})) {
    const act = getPath(f, path);
    if (act === undefined) continue;
    const hits = Array.isArray(act) ? bad.filter((x) => act.some((y) => deepEqual(x, y))) : bad.filter((x) => deepEqual(x, act));
    if (hits.length) out.push(`${label}.${path}: must not include ${stable(hits)}`);
  }
  for (const [path, [lo, hi]] of Object.entries(e.range ?? {})) {
    const act = getPath(f, path);
    if (typeof act !== 'number' || act < lo || act > hi) out.push(`${label}.${path}: expected ${lo}..${hi}, got ${stable(act)}`);
  }
  for (const path of e.absent ?? []) {
    const act = getPath(f, path);
    if (act !== undefined && !(Array.isArray(act) && act.length === 0)) out.push(`${label}.${path}: expected absent, got ${stable(act)}`);
  }
  if (e.onlyKeys) {
    const extra = Object.keys(f).filter((k) => !e.onlyKeys!.includes(k));
    if (extra.length) out.push(`${label}: unexpected keys ${extra.join(', ')}`);
  }
  for (const [path, p] of Object.entries(e.matches ?? {})) {
    const act = getPath(f, path);
    if (act === undefined || !re(p).test(typeof act === 'string' ? act : stable(act))) out.push(`${label}.${path}: ${stable(act)} does not match /${p}/i`);
  }
  for (const [path, days] of Object.entries(e.dateDaysAgo ?? {})) {
    const act = isoToEtDate(getPath(f, path));
    const want = etDate(new Date(ctx.now.getTime() - days * 86_400_000));
    if (!act) out.push(`${label}.${path}: expected a date ${days} days ago (${want}), got ${stable(getPath(f, path))}`);
    else if (Math.abs(daysBetween(act, want)) > 1) out.push(`${label}.${path}: expected ${want} (+-1 day), got ${act}`);
  }
  return out;
}

export function checkFilter(e: FilterAssert | undefined, raw: Record<string, unknown> | null, ctx: AssertContext): string[] {
  if (!e) return [];
  const keepScope = [...assertedPaths(e)].some((p) => p === 'scope' || p.startsWith('scope.'));
  const f = normalizeFilter(raw, ctx.role, keepScope);
  const { anyOf, ...base } = e;
  const out = checkFilterBase(base, f, ctx);
  if (anyOf?.length) {
    const branches = anyOf.map((b, i) => checkFilterBase(b, f, ctx, `filter.anyOf[${i}]`));
    if (!branches.some((b) => b.length === 0)) out.push(`filter.anyOf: no branch passed (${branches.map((b) => b.join('; ')).join(' | ')})`);
  }
  return out;
}

function checkCitations(e: ExpectBase['citations'], cites: string[]): string[] {
  if (!e) return [];
  const out: string[] = [];
  const have = new Set(cites);
  for (const c of e.includes ?? []) if (!have.has(c)) out.push(`citations: missing ${c} (got ${[...have].join(', ') || 'none'})`);
  if (e.includesAny && !e.includesAny.some((c) => have.has(c))) out.push(`citations: none of ${e.includesAny.join(', ')} (got ${[...have].join(', ') || 'none'})`);
  for (const c of e.excludes ?? []) if (have.has(c)) out.push(`citations: must not include ${c}`);
  if (e.none === true && have.size) out.push(`citations: expected none, got ${[...have].join(', ')}`);
  if (e.none === false && !have.size) out.push('citations: expected at least one');
  return out;
}

function checkBase(e: ExpectBase, o: CaseOutput, ctx: AssertContext): string[] {
  const out: string[] = [];
  if (e.matchCountMin !== undefined) {
    const n = o.matchCount ?? null;
    if (n === null || n < e.matchCountMin) out.push(`matchCount: expected at least ${e.matchCountMin}, got ${n}`);
  }
  if (e.tool !== undefined) {
    const ok = Array.isArray(e.tool) ? e.tool.includes(o.tool) : e.tool === o.tool;
    if (!ok) out.push(`tool: expected ${Array.isArray(e.tool) ? e.tool.join(' | ') : e.tool}, got ${o.tool}`);
  }
  if (e.outcome !== undefined && e.outcome !== o.outcome) out.push(`outcome: expected ${e.outcome}, got ${o.outcome}`);
  if (e.errorCode !== undefined && e.errorCode !== o.errorCode) out.push(`errorCode: expected ${e.errorCode}, got ${o.errorCode}`);
  out.push(...checkFilter(e.filter, o.filter, ctx));
  out.push(...checkText('text', e.text, o.text));
  out.push(...checkText('explanation', e.explanation, o.explanation));
  out.push(...checkCitations(e.citations, o.citations));
  return out;
}

/** Failed assertions ([] = pass). */
export function evaluate(e: Expect, o: CaseOutput, ctx: AssertContext): string[] {
  const { anyOf, ...base } = e;
  const out = checkBase(base, o, ctx);
  if (anyOf?.length) {
    const branches = anyOf.map((b) => checkBase(b, o, ctx));
    if (!branches.some((b) => b.length === 0)) out.push(`anyOf: no branch passed (${branches.map((b) => b.join('; ')).join(' | ')})`);
  }
  return out;
}
