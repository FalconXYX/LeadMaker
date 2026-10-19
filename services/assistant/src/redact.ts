// Secret scrubbing (§7.11.7): every configured key value, key-shaped strings (Google AIza..., Anthropic sk-ant-...,
// OpenAI sk-...) and x-goog-api-key / x-api-key / Authorization header values become [redacted]. Applied to every
// error before it is logged; SSE errors carry fixed copy only, so provider text never reaches a client anyway.
const PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /((?:x-goog-api-key|x-api-key|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi,
  /([?&](?:key|api_key|access_token)=)[^&\s"']+/gi,
];

export const REDACTED = '[redacted]';

export class Redactor {
  readonly #secrets: string[];

  constructor(secrets: string[] = []) {
    // Longest first, so a key that contains another is replaced whole.
    this.#secrets = [...new Set(secrets.filter((s) => s && s.length >= 8))].sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    let s = input;
    for (const secret of this.#secrets) s = s.split(secret).join(REDACTED);
    for (const re of PATTERNS) {
      // Patterns with a capture group keep it (the header or parameter name) and redact the value after it.
      s = s.replace(re, (_match: string, ...rest: unknown[]) => (typeof rest[0] === 'string' ? `${rest[0]}${REDACTED}` : REDACTED));
    }
    return s;
  }

  /** Deep copy of a log object / error with every string scrubbed. */
  value(input: unknown, depth = 0): unknown {
    if (typeof input === 'string') return this.text(input);
    if (depth > 6 || input === null || typeof input !== 'object') return input;
    if (input instanceof Error) {
      return { type: input.name, message: this.text(input.message), ...(input.stack ? { stack: this.text(input.stack) } : {}) };
    }
    if (Array.isArray(input)) return input.map((v) => this.value(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = this.value(v, depth + 1);
    return out;
  }
}
