// Deterministic fake provider (§7.9) for tests, offline evals, the private test stack and UI work without a key.
// It reads only what a real model would get: the system prompt and the rendered turns.
//   Script mode: a <user_message> starting with "/fake " carries {"steps":[...]}; one step per provider call
//     ({text}, {tool, args}, {tools:[...]}, {error}, {delayMs}). Exhausted -> "(end of script)" (or, after a tool
//     result, the rules-mode reply to it).
//   Rules mode: answers a tool result, else lead Q&A templates from <lead_context>, else parseFilterRules().
import {
  CERTIFICATIONS, type FilterVocabulary, type LeadFilterTool, type Role,
} from '@leadmaker/shared';
import { PACIFIC_TZ, nextMidnight } from '../time.ts';
import {
  LlmApiError, LlmAuthError, LlmOutputError, LlmQuotaExceeded, LlmRateLimited, LlmTimeoutError, type ChatDelta,
  type ChatMessage, type ChatRequest, type LlmProvider, type ToolCall,
} from './types.ts';

export interface FakeOptions { model?: string; delayMs?: number; allowed?: boolean; now?: () => Date }

type Json = Record<string, unknown>;
type Step = Json & { text?: unknown; tool?: unknown; args?: unknown; tools?: unknown; error?: unknown; delayMs?: unknown };

const CHUNK = 16;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeProvider implements LlmProvider {
  readonly name = 'fake' as const;
  readonly model: string;
  readonly fingerprint: string;
  readonly #delayMs: number;
  readonly #allowed: boolean;
  readonly #now: () => Date;
  /** Every request seen (tests assert call counts and prompts). */
  readonly calls: ChatRequest[] = [];

  constructor(opts: FakeOptions = {}) {
    this.model = opts.model || 'fake-1';
    this.fingerprint = `fake:${this.model}`;
    this.#delayMs = Math.max(0, opts.delayMs ?? 0);
    this.#allowed = opts.allowed ?? true;
    this.#now = opts.now ?? (() => new Date());
  }

  isConfigured(): { ok: true } | { ok: false; reason: string } {
    return this.#allowed ? { ok: true } : { ok: false, reason: 'the fake provider is for tests; set LEADMAKER_ALLOW_FAKE_LLM=1' };
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    this.calls.push(req);
    const turn = parseTurn(req.messages);
    const callIndex = assistantTurnsSince(req.messages, turn.index);
    let text = '';
    let calls: ToolCall[] = [];
    const script = turn.userMessage.startsWith('/fake ') ? parseScript(turn.userMessage.slice(6)) : null;
    if (script) {
      const step = await this.#scriptStep(script, callIndex, signal);
      if (!step) {
        text = endsWithToolResult(req.messages) ? toolResultReply(req.messages) : '(end of script)';
      } else {
        if (typeof step.error === 'string') throw scriptedError(step.error, this.#now());
        if (typeof step.text === 'string') text = step.text;
        const tools = Array.isArray(step.tools) ? (step.tools as Step[]) : step.tool !== undefined ? [step] : [];
        calls = tools.map((t, i) => ({
          id: `fake-call-${callIndex}-${i}`,
          name: String(t.tool ?? ''),
          arguments: (t.args && typeof t.args === 'object' && !Array.isArray(t.args) ? t.args : {}) as Json,
        }));
        if (!text && !calls.length) text = '(empty step)';
      }
    } else {
      const reply = rulesReply(req.messages, turn);
      text = reply.text;
      calls = reply.calls.map((c, i) => ({ id: `fake-call-${callIndex}-${i}`, name: c.name, arguments: c.args }));
    }
    for (let i = 0; i < text.length; i += CHUNK) {
      if (signal.aborted) throw signal.reason;
      if (i > 0) await sleep(this.#delayMs, signal);
      yield { type: 'text', text: text.slice(i, i + CHUNK) };
    }
    for (const call of calls) yield { type: 'tool_call', call };
    const inputChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    yield { type: 'usage', inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil((text.length + JSON.stringify(calls).length * (calls.length ? 1 : 0)) / 4) };
    yield { type: 'end', stopReason: calls.length ? 'tool_calls' : 'stop', raw: { provider: 'fake' } };
  }

  async #scriptStep(steps: Step[], callIndex: number, signal: AbortSignal): Promise<Step | null> {
    let i = 0;
    for (let c = 0; c < callIndex; c++) {
      while (i < steps.length && steps[i]!.delayMs !== undefined && Object.keys(steps[i]!).length === 1) i++;
      i++;
    }
    while (i < steps.length) {
      const s = steps[i]!;
      if (s.delayMs !== undefined && Object.keys(s).length === 1) {
        await sleep(Number(s.delayMs) || 0, signal);
        i++;
        continue;
      }
      return s;
    }
    return null;
  }
}

function scriptedError(kind: string, now: Date): Error {
  const provider = 'fake';
  switch (kind) {
    case 'quota':
      return new LlmQuotaExceeded('scripted quota error', { provider, status: 429, resetsAt: nextMidnight(PACIFIC_TZ, now), scope: 'daily' });
    case 'rate_limited':
      return new LlmRateLimited('scripted rate limit', { provider, status: 429, retryAfterMs: 1000 });
    case 'auth':
      return new LlmAuthError('scripted auth error', { provider, status: 401 });
    case 'timeout':
      return new LlmTimeoutError('scripted timeout', { provider });
    case 'blocked':
      return new LlmOutputError('scripted safety block', { provider });
    default:
      return new LlmApiError('scripted api error', { provider, status: 503 });
  }
}

function parseScript(json: string): Step[] {
  try {
    const v = JSON.parse(json) as { steps?: unknown };
    return Array.isArray(v?.steps) ? (v.steps.filter((s) => s && typeof s === 'object') as Step[]) : [{ text: '(invalid fake script)' }];
  } catch {
    return [{ text: '(invalid fake script)' }];
  }
}

// ---- reading the rendered turn ---------------------------------------------------------------------------

export interface FakeLead {
  id: string; name: string; tier: string | null; city: string | null; county: string | null; account: string | null; lastContacted: string | null;
  rating: string | null; summary: string | null; pitch: string | null; target: string | null; targetReason: string | null;
  firstContact: string | null; timing: string[]; latestNote: string | null;
}

interface Turn {
  index: number;
  userMessage: string;
  role: Role;
  today: string;
  vocab: FilterVocabulary;
  lead: FakeLead | null;
}

const between = (s: string, open: RegExp, close: string): string | null => {
  const m = open.exec(s);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = s.indexOf(close, start);
  return end < 0 ? null : s.slice(start, end);
};

const field = (s: string | null, re: RegExp): string | null => {
  const m = s ? re.exec(s) : null;
  return m ? m[1]!.trim() : null;
};

function parseTurn(messages: ChatMessage[]): Turn {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user' && messages[i]!.content.includes('<user_message>')) {
      index = i;
      break;
    }
  }
  const content = index >= 0 ? messages[index]!.content : messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  const userMessage = (between(content, /<user_message>\n?/, '</user_message>') ?? content).trim();
  const session = between(content, /<session>/, '</session>') ?? '';
  const role = (field(session, /user role: (\w+)/) === 'manager' ? 'manager' : 'rep') as Role;
  const today = field(session, /today: (\d{4}-\d{2}-\d{2})/) ?? new Date().toISOString().slice(0, 10);
  return { index, userMessage, role, today, vocab: parseVocabulary(between(content, /<vocabulary>/, '</vocabulary>') ?? ''), lead: parseLead(content) };
}

function parseVocabulary(block: string): FilterVocabulary {
  const line = (prefix: string) => block.split('\n').find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? '';
  const items = (s: string) => s.split('; ').map((x) => x.trim()).filter((x) => x && x !== 'none');
  const counties = items(line('counties (name -> FIPS, leads you can see): ')).map((x) => {
    const m = /^(.*) -> (\d{5}) \((\d+)\)$/.exec(x);
    return m ? { fips: m[2]!, name: m[1]!, leadCount: Number(m[3]) } : null;
  }).filter((x): x is { fips: string; name: string; leadCount: number } => !!x);
  const customTags = items(line('custom tags: ')).map((x, i) => {
    const m = /^(.*) \((\d+)\)$/.exec(x);
    return { id: `tag-${i}`, name: m ? m[1]! : x, leadCount: m ? Number(m[2]) : 0 };
  });
  const customFieldKeys = items(line('custom fields: ')).map((x) => {
    const m = /^(.*) \((\w+)\)$/.exec(x);
    return { key: m ? m[1]! : x, valueType: (m ? m[2] : 'mixed') as FilterVocabulary['customFieldKeys'][number]['valueType'] };
  });
  const reps = items(line('reps (managers only): ')).map((x) => {
    const m = /^(.*) -> ([0-9a-f-]{36})$/i.exec(x);
    return m ? { id: m[2]!, name: m[1]! } : null;
  }).filter((x): x is { id: string; name: string } => !!x);
  return { counties, customTags, customFieldKeys, reps, generatedAt: '' };
}

function parseLead(content: string): FakeLead | null {
  const open = /<lead_context id="([^"]*)" name="([^"]*)">/.exec(content);
  if (!open) return null;
  const body = content.slice(open.index);
  const section = (src: string) => between(body, new RegExp(`<section src="${src}">`), '</section>');
  const details = section('details');
  const insights = section('insights');
  const contacts = section('contacts');
  const timing = section('timing');
  const notes = section('notes');
  const stop = '(?:; talking points: |; ask for: |; product focus: |; generated |$)';
  const targetLine = contacts?.split('\n').find((l) => l.startsWith('target: '))?.slice(8) ?? null;
  const targetParts = targetLine?.split(' - ') ?? [];
  const firstContact = contacts?.split('\n').find((l) => !l.startsWith('target: ')) ?? null;
  return {
    id: open[1]!,
    name: open[2]!,
    tier: field(details, /GAF tier: ([^;\n]+)/),
    city: field(details, /location: ([^,;\n(]+)/),
    county: field(details, /location: [^;\n]*\(([^)]+)\)/),
    account: field(details, /account: ([^;\n]+)/),
    lastContacted: field(details, /last contacted: ([^;\n]+)/),
    rating: field(details, /(rating [\d.]+ \(\d+ reviews\))/),
    summary: field(insights, new RegExp(`summary: (.*?)(?:; pitch: |${stop.slice(3)}`)),
    pitch: field(insights, new RegExp(`pitch: (.*?)${stop}`)),
    target: targetParts.length > 1 ? targetParts[1]! : targetParts[0] ?? null,
    targetReason: targetParts.length > 2 ? targetParts.slice(2).join(' - ') : null,
    firstContact: firstContact ? firstContact.replace(/ \(.*\)$/, '') : null,
    timing: timing && !timing.startsWith('none') ? timing.split('\n').filter(Boolean) : [],
    latestNote: notes?.split('\n')[0] ?? null,
  };
}

function assistantTurnsSince(messages: ChatMessage[], index: number): number {
  return messages.slice(index + 1).filter((m) => m.role === 'assistant').length;
}

function endsWithToolResult(messages: ChatMessage[]): boolean {
  return messages.at(-1)?.role === 'tool';
}

// ---- rules mode --------------------------------------------------------------------------------------------

interface RulesReply { text: string; calls: { name: string; args: Json }[] }

function toolResultReply(messages: ChatMessage[]): string {
  const results: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role === 'tool'; i--) results.unshift(messages[i]!);
  for (const r of results) {
    let v: Json = {};
    try {
      v = JSON.parse(r.content) as Json;
    } catch {
      v = {};
    }
    if (Array.isArray(v.errors) && v.errors.length) return `I couldn't apply that: ${String(v.errors[0])}.`;
    if (Array.isArray(v.candidates)) {
      const names = (v.candidates as Json[]).map((c) => `[${String(c.name)}](/leads/${String(c.id)})`).join(', ');
      return `Several leads match that name: ${names}. Which one do you mean?`;
    }
    if (v.error === 'not_found') return "I couldn't find a lead with that name among the leads you can see.";
    if (Array.isArray(v.leads) && typeof v.overdue === 'number') {
      const leads = v.leads as Json[];
      const head = `${v.overdue} follow-up${v.overdue === 1 ? ' is' : 's are'} overdue and ${String(v.dueToday)} due today.`;
      if (!leads.length) return `${head} Nothing else is waiting.`;
      return `${head} Call first: ${leads.slice(0, 5).map((l) => `[${String(l.name)}](/leads/${String(l.id)}) (${String(l.reason)})`).join(', ')}.`;
    }
    if (Array.isArray(v.leads)) {
      const leads = v.leads as Json[];
      if (!leads.length) return 'No leads match that.';
      return `Top matches: ${leads.slice(0, 5).map((l) => `[${String(l.name)}](/leads/${String(l.id)})`).join(', ')}.`;
    }
  }
  return 'Done.';
}

const WRITE_INTENT = /^(please\s+)?(delete|erase|wipe|reassign|allocate|assign|mark|log|edit|update)\b|\badd (a )?(note|task|follow-?up)\b/i;
const UNKNOWN_FACT = /revenue|e-?mail|phone number|trucks|employees count|how many employees|crew size/i;
const COMPANY_WORDS = /\b((?:[A-Z][\w&'.-]*\s+){0,4}(?:Roofing|Roofers|Co\.?|Company|LLC|Inc\.?|Corp\.?|Construction|Contracting|Contractors|Exteriors|Builders|Restoration|Group|Services|Homes?))\b/;

function leadReply(q: string, lead: FakeLead): string | null {
  const lower = q.toLowerCase();
  const company = COMPANY_WORDS.exec(q)?.[1]?.trim();
  if (company && !lead.name.toLowerCase().includes(company.toLowerCase()) && !/^(this|the|their)\b/i.test(company)) {
    return `I can only answer about ${lead.name}, the lead that's open.`;
  }
  if (UNKNOWN_FACT.test(q)) {
    return "I don't know; that isn't in this lead's profile. Contact details are on the Contacts tab; ask on the first call for anything else.";
  }
  if (/summar|about|who are/i.test(q)) {
    const tier = lead.tier && lead.tier !== 'none listed' ? `${lead.tier} ` : '';
    const where = lead.city ? ` in ${lead.city}` : '';
    const summary = lead.summary ? ` ${lead.summary} [src:insights]` : '';
    return `${lead.name} is a ${tier}roofing contractor${where}. [src:details]${summary}`;
  }
  if (/last contacted|when did we|last contact\b/i.test(lower)) {
    return `Last contacted: ${lead.lastContacted ?? 'never'}. [src:details]`;
  }
  if (/contact|who should|ask for/i.test(q)) {
    if (lead.target) return `Ask for ${lead.target}.${lead.targetReason ? ` ${lead.targetReason}` : ''} [src:contacts]`;
    if (lead.firstContact) return `Ask for ${lead.firstContact}. [src:contacts]`;
    return 'No contact is on file; ask for the owner on the first call. [src:contacts]';
  }
  if (/pitch|storm|sell/i.test(q)) {
    const pitch = lead.pitch ? `${lead.pitch} [src:insights]` : "There's no AI pitch for this lead yet.";
    const timing = lead.timing[0] ? ` Timing: ${lead.timing[0].replace(/ \((high|medium|low|info)\):.*$/, '')}. [src:timing]` : '';
    return pitch + timing;
  }
  if (/weather|alert|forecast/i.test(q)) {
    if (!lead.timing.length) return `There are no active weather alerts or timing signals for ${lead.name} right now. [src:timing]`;
    return `Timing: ${lead.timing[0]}. [src:timing]`;
  }
  if (/note|last call|said|hear/i.test(q)) {
    return lead.latestNote ? `The latest note: ${lead.latestNote} [src:notes]` : 'There are no notes on this lead yet.';
  }
  if (/master elite|certif|tier/i.test(q)) {
    const tier = lead.tier ?? 'none listed';
    const no = /master elite/i.test(q) && !/master elite/i.test(tier) ? 'No. ' : '';
    return `${no}Their listed GAF tier is ${tier}. [src:details]`;
  }
  if (/customer|account status|account/i.test(lower)) {
    return lead.account ? `Account status: ${lead.account}. [src:details]` : 'The account status is not in the profile.';
  }
  if (/rating|rated|reviews/i.test(lower)) {
    return lead.rating ? `${lead.name} has a ${lead.rating}. [src:details]` : "The rating isn't in the profile.";
  }
  return null;
}

function rulesReply(messages: ChatMessage[], turn: Turn): RulesReply {
  if (endsWithToolResult(messages)) return { text: toolResultReply(messages), calls: [] };
  const q = turn.userMessage;
  if (WRITE_INTENT.test(q)) {
    return { text: "I can't change data. Notes, stages and follow-ups are on the lead's profile; allocations are on the Allocation page.", calls: [] };
  }
  if (turn.role !== 'manager' && /\b(?!My\b)[A-Z][a-z]+['’]s leads\b/.test(q)) {
    return { text: "You can only see your own leads and the unallocated pool, so I can't show another rep's leads.", calls: [] };
  }
  const open = /^open\s+(.+?)[.!]?$/i.exec(q);
  if (open) return { text: '', calls: [{ name: 'openLead', args: { name: open[1]! } }] };
  if (!turn.lead && /\b(call|ring|phone|contact)\b[^.?!]{0,30}\b(first|today|next)\b/i.test(q)) {
    return { text: '', calls: [{ name: 'todaysCalls', args: { limit: 5 } }] };
  }
  let intent = parseFilterRules(q, turn.vocab, turn.today, turn.role);
  if (turn.lead) {
    // With a lead open, only an explicit list request is a filter ("storm" alone is a question about this lead).
    const listy = /\b(show|find|list|filter|leads|contractors|roofers|companies|similar|others)\b/i.test(q);
    if (listy && /\b(similar|like this)\b/i.test(q)) intent = similarTo(turn.lead, turn.vocab) ?? intent;
    if (!intent || !listy) {
      return { text: leadReply(q, turn.lead) ?? `I can only answer from ${turn.lead.name}'s profile.`, calls: [] };
    }
  }
  if (!intent) return { text: 'I can answer questions about the open lead or filter your lead list.', calls: [] };
  const args: Json = intent.tool === 'findLeads' ? { filter: intent.filter, limit: 5 } : { filter: intent.filter, explanation: intent.explanation };
  return { text: '', calls: [{ name: intent.tool, args }] };
}

/** "Similar contractors": same county and GAF tier as the open lead. */
function similarTo(lead: FakeLead, vocab: FilterVocabulary): FilterRulesResult | null {
  const filter: LeadFilterTool = {};
  const county = lead.county ? vocab.counties.find((c) => c.name === lead.county) : undefined;
  if (county) filter.counties = [county.fips];
  const tier = (lead.tier ?? '').toLowerCase();
  if (tier.includes('master elite')) filter.certifications = ['gaf:master_elite'];
  else if (tier.includes('certified plus')) filter.certifications = ['gaf:certified_plus'];
  else if (tier.includes('certified')) filter.certifications = ['gaf:certified'];
  if (!Object.keys(filter).length) return null;
  return { tool: 'applyListFilters', filter, explanation: `Like ${lead.name}: same county and GAF tier`.slice(0, 100) };
}

// ---- parseFilterRules ------------------------------------------------------------------------------------------

export interface FilterRulesResult { tool: 'applyListFilters' | 'findLeads'; filter: LeadFilterTool; explanation: string }

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10 };
const COUNTY_ALIASES: [RegExp, string][] = [
  [/\bbrooklyn\b/, '36047'], [/\bmanhattan\b/, '36061'], [/\bstaten island\b/, '36085'], [/\bqueens\b/, '36081'], [/\bbronx\b/, '36005'],
];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function minusDays(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function add<T>(list: T[] | undefined, ...values: T[]): T[] {
  const out = list ? [...list] : [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

/**
 * Best-effort keyword parser from a list request to the filter tool's arguments (rules mode of the fake; the evals
 * score it separately as the rules-parser baseline). null when nothing in the text maps to a filter.
 */
export function parseFilterRules(text: string, vocab: FilterVocabulary, today: string, role: Role): FilterRulesResult | null {
  const original = text.replace(/[’‘]/g, "'").trim();
  let t = ` ${original.toLowerCase()} `;
  const f: LeadFilterTool = {};
  const said: string[] = [];
  const cannot: string[] = [];

  // Exclusions cannot be expressed (the filter has no NOT), except certifications below.
  const excl = /\b(?:excluding|except|without|but not|no)\s+((?:\w+\s+){0,2}?)(storm|restoration|insurance|emergency|commercial|gutters?|siding|new construction)\w*(\s+work)?/g;
  t = t.replace(excl, (_m, _w, what: string) => {
    cannot.push(`can't exclude ${what}`);
    return ' ';
  });

  // scope
  if (/\b(unallocated|in the pool|the pool|pool)\b/.test(t)) f.scope = 'unallocated';
  else if (/everything i can see|\ball (the )?leads\b|\beverything\b/.test(t)) f.scope = 'all';
  else if (/\bmy (leads|accounts|book)\b|\bmine\b|\bof my\b/.test(t)) f.scope = 'mine';
  if (role === 'manager') {
    const m = /\b([A-Z][a-z]+)'s (leads|book|accounts)\b/.exec(original);
    const rep = m ? vocab.reps.find((r) => r.name.toLowerCase().split(/\s+/)[0] === m[1]!.toLowerCase()) : undefined;
    if (rep) {
      f.repId = rep.id;
      delete f.scope;
      said.push(`${rep.name.split(' ')[0]}'s leads`);
    }
  }
  if (f.scope === 'unallocated') said.push('unallocated');

  // certifications
  if (/\bnot (a )?master elite|\bnon-master elite|\bexcluding master elite/.test(t)) {
    f.certifications = CERTIFICATIONS.filter((c) => c !== 'gaf:master_elite');
    said.push('not Master Elite');
  } else {
    if (/master elite/.test(t)) { f.certifications = add(f.certifications, 'gaf:master_elite'); said.push('Master Elite'); }
    if (/certified plus|president'?s club/.test(t)) { f.certifications = add(f.certifications, 'gaf:certified_plus'); said.push('Certified Plus'); }
    if (/\bno gaf cert|without (a )?gaf cert|\buncertified\b|not gaf certified/.test(t)) { f.certifications = add(f.certifications, 'gaf:none'); said.push('no GAF certification'); }
  }

  // materials
  const materials: [RegExp, string, string][] = [
    [/\bmetal\b/, 'metal_roofing', 'metal roofs'], [/\bslate\b/, 'slate_roofing', 'slate'], [/\btiles?\b/, 'tile_roofing', 'tile'],
    [/\btpo\b/, 'tpo_roofing', 'TPO'], [/\bflat[- ]roof/, 'flat_roofing', 'flat roofs'], [/\bshingles?\b/, 'shingle_roofing', 'shingles'],
    [/\bsingle[- ]ply\b/, 'single_ply_roofing', 'single-ply'],
  ];
  for (const [re, key, label] of materials) if (re.test(t)) { f.materials = add(f.materials, key); said.push(label); }

  // services
  const services: string[] = [];
  const svc: [RegExp, string, string][] = [
    [/\bstorm|\brestoration\b/, 'storm_damage', 'storm work'], [/\binsurance\b/, 'insurance_claims', 'insurance claims'],
    [/\bemergency\b/, 'emergency_service', 'emergency repair'], [/\bcommercial\b/, 'commercial_roofing', 'commercial'],
    [/\bgutters?\b/, 'gutters', 'gutters'], [/\bsiding\b/, 'siding', 'siding'], [/\bnew[- ]construction\b/, 'new_construction', 'new construction'],
  ];
  for (const [re, key, label] of svc) if (re.test(t)) { services.push(key); said.push(label); }
  if (services.length >= 2 && /\bboth\b/.test(t)) f.tagsAll = services.map((s) => `service:${s}`);
  else if (services.length) f.services = services;

  // checked / contacted
  if (/haven'?t (checked|reviewed)|not (been )?(checked|reviewed)|\bunchecked\b|nobody has (checked|reviewed)/.test(t)) {
    f.unchecked = /nobody|no one|\bteam\b/.test(t) ? 'team' : 'me';
    said.push(f.unchecked === 'team' ? 'not checked by the team' : 'not checked by you');
  }
  const since = /(?:not|haven'?t|n't)\s+(?:been\s+)?(?:contacted|called|touched)\s+(?:in|for)\s+(?:the\s+(?:last|past)\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|ten)\s+(days?|weeks?|months?)/.exec(t);
  if (since) {
    const n = /^\d+$/.test(since[1]!) ? Number(since[1]) : NUMBER_WORDS[since[1]!] ?? 1;
    const unit = since[2]!.startsWith('week') ? 7 : since[2]!.startsWith('month') ? 30 : 1;
    f.notContactedSince = minusDays(today, n * unit);
    said.push(`not contacted since ${f.notContactedSince}`);
  } else if (/haven'?t (contacted|called|touched)|never (been )?contacted|\buncontacted\b|(nobody|no one)( on the team)? has (contacted|called)|not (been )?contacted/.test(t)) {
    f.unserviced = /nobody|no one|\bteam\b/.test(t) ? 'team' : 'me';
    said.push(f.unserviced === 'team' ? 'never contacted by the team' : 'not contacted by you');
  }

  // follow-ups
  if (/\boverdue\b/.test(t)) f.followUp = 'overdue';
  else if (/\bno follow-?ups?\b|without (a )?follow-?up/.test(t)) f.followUp = 'none';
  else if (/(due|follow-?ups?)\b[^.]*\btoday\b|\bdue today\b/.test(t)) f.followUp = 'today';
  else if (/(due|follow-?ups?)\b[^.]*\bthis week\b/.test(t)) f.followUp = 'week';
  if (f.followUp) said.push(`follow-up ${f.followUp}`);

  // stages
  const stages: string[] = [];
  if (/\binterested\b/.test(t)) stages.push('interested');
  if (/\bquoting\b|\bquoted\b/.test(t)) stages.push('quoting');
  if (/\bwon\b/.test(t)) stages.push('won');
  if (/\bnot a fit\b|\blost\b/.test(t)) stages.push('lost');
  if (/\b(in|at) (the )?contacted\b/.test(t)) stages.push('contacted');
  if (/\bnew leads?\b/.test(t) && !/new or changed/.test(t) && !f.unserviced) stages.push('new');
  if (stages.length) {
    f.stages = stages as LeadFilterTool['stages'];
    said.push(`stage ${stages.join(' or ')}`);
  }

  // near / distance
  const within = /within (\d+(?:\.\d+)?) ?(?:mi|miles?) (?:of|from) (\d{5})/.exec(t);
  const near = /(?:near|around|close to|closest to|nearest to|by) (\d{5})/.exec(t);
  if (within) f.near = { zip: within[2]!, radiusMiles: Number(within[1]) };
  else if (near) f.near = { zip: near[1]!, radiusMiles: 10 };
  if (f.near) said.push(`within ${f.near.radiusMiles} mi of ${f.near.zip}`);
  if (/\b(closest|nearest)\b/.test(t) && f.near) f.sort = { by: 'distance', dir: 'asc' };

  // counties
  const counties: string[] = [];
  for (const c of vocab.counties) {
    const base = (c.name ?? '').replace(/,.*$/, '').toLowerCase().trim();
    const first = base.replace(/ county$/, '');
    if (!first) continue;
    const re = first.includes(' ') ? new RegExp(`\\b${first} county\\b`) : new RegExp(`\\b${first}\\b`);
    if (re.test(t)) counties.push(c.fips);
  }
  for (const [re, fips] of COUNTY_ALIASES) if (re.test(t)) counties.push(fips);
  if (counties.length) {
    f.counties = [...new Set(counties)];
    said.push(`${f.counties.length === 1 ? 'county' : 'counties'} ${f.counties.join(', ')}`);
  }

  // rating
  const rating = /(?<![\d.])([0-5](?:\.\d)?)\s*\+/.exec(t) ?? /rated (?:above|over|at least|over) ([0-5](?:\.\d)?)/.exec(t)
    ?? /(?<![\d.])([0-5](?:\.\d)?)\s*\+?\s*stars?/.exec(t);
  if (rating) {
    f.minRating = Number(rating[1]);
    said.push(`${f.minRating}+ stars`);
  }

  // priority, years
  if (/\bhighest[- ]priority\b/.test(t)) f.sort = { by: 'priority_score', dir: 'desc' };
  else if (/\bhigh[- ]priority\b/.test(t)) { f.minPriority = 70; said.push('priority 70+'); }
  const years = /(?:over|more than|at least) (\d+) years/.exec(t);
  if (years) { f.minYearsInBusiness = Number(years[1]); said.push(`${years[1]}+ years in business`); }
  if (/\bhighest[- ]rated\b|\bbest[- ]rated\b|sort(ed)? by rating/.test(t)) f.sort = { by: 'rating', dir: 'desc' };

  // size, segment, account status
  const sizes = (['small', 'medium', 'large'] as const).filter((s) => new RegExp(`\\b${s}\\b`).test(t));
  if (sizes.length) { f.size = [...sizes]; said.push(sizes.join(' or ')); }
  const segments = (['strategic', 'growth', 'emerging'] as const).filter((s) => new RegExp(`\\b${s}\\b`).test(t));
  const segs: NonNullable<LeadFilterTool['segment']> = [...segments];
  if (/long[- ]tail/.test(t)) segs.push('long_tail');
  if (segs.length) { f.segment = segs; said.push(segs.join(' or ')); }
  const statuses: NonNullable<LeadFilterTool['accountStatus']> = [];
  if (/\blapsed\b/.test(t)) statuses.push('lapsed_customer');
  if (/\bexisting customers?\b|\bcurrent customers?\b/.test(t)) statuses.push('existing_customer');
  if (/\bprospects?\b/.test(t)) statuses.push('prospect');
  if (statuses.length) { f.accountStatus = statuses; said.push(statuses.map((s) => s.replace(/_/g, ' ')).join(' or ')); }

  // poll / dates
  if (/updated in the last poll|new or changed|changed in the last poll/.test(t)) { f.updatedInLastPoll = true; said.push('changed in the last poll'); }
  const changed = /changed since (\d{4}-\d{2}-\d{2}|([a-z]+) (\d{1,2}))/.exec(t);
  if (changed) {
    let iso: string | null = changed[1]!.match(/^\d{4}/) ? changed[1]! : null;
    if (!iso && changed[2]) {
      const month = MONTHS.indexOf(changed[2]);
      if (month >= 0) iso = `${today.slice(0, 4)}-${String(month + 1).padStart(2, '0')}-${String(Number(changed[3])).padStart(2, '0')}`;
    }
    if (iso) { f.updatedSince = iso; said.push(`changed since ${iso}`); }
  }

  // name, custom tags and fields
  const named = /\b(?:named|called)\s+["']?([\w&'. -]{2,60}?)["']?[.?!]?\s*$/.exec(original);
  if (named) { f.text = named[1]!.trim(); said.push(`named ${f.text}`); }
  const tags = vocab.customTags.filter((c) => c.name && t.includes(c.name.toLowerCase())).map((c) => c.name);
  if (tags.length) { f.customTags = tags; said.push(`tagged ${tags.join(', ')}`); }
  for (const k of vocab.customFieldKeys) {
    const words = k.key.toLowerCase().split(/[_\s]+/).filter((w) => w.length >= 3);
    if (!words.length || !words.every((w) => t.includes(w))) continue;
    const gte = /(?:at least|over|more than|above|minimum(?: of)?|>=?)\s*(\d+(?:\.\d+)?)/.exec(t);
    const lte = /(?:at most|under|less than|below|maximum(?: of)?|<=?)\s*(\d+(?:\.\d+)?)/.exec(t);
    const cond = gte ? { key: k.key, op: 'gte' as const, value: Number(gte[1]) }
      : lte ? { key: k.key, op: 'lte' as const, value: Number(lte[1]) } : { key: k.key, op: 'exists' as const };
    f.customFields = [...(f.customFields ?? []), cond];
    said.push(k.key.replace(/_/g, ' '));
  }

  if (!Object.keys(f).length) return null;
  const tool = /^\s*(how many|which|who should|what are my top)\b/i.test(original) ? 'findLeads' : 'applyListFilters';
  const explanation = [...said, ...cannot].join(', ') || (f.scope === 'all' ? 'everything you can see' : 'your leads');
  return { tool, filter: f, explanation: explanation.slice(0, 100) };
}
