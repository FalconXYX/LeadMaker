// Streaming [src:<key>] extractor (§7.7). The model tags sentences with the lead-context section they came from;
// the tags never reach the user. A tag is dropped together with one preceding space, and becomes a `citation`
// event only when its key is allowlisted (CITATION_FIELDS) and there is an active lead, once per field per reply.
// Works across chunk boundaries: a "[" holds output back until "]", a newline or MAX_TAG chars decide. A trailing
// "," ";" or ":" is held too: when a dropped tag sits between it and more punctuation ("job, [src:activity]."), the
// held mark goes, so the answer reads "job." and not "job,." (seen live on 2026-10-19).
import { CITATION_FIELDS, type LeadAiContext } from '@leadmaker/shared';

const MAX_TAG = 80;
// "[src:details]", leniently "[src: details, notes]" and "[src:details, src:insights]" (Gemini 3.5 repeats the
// prefix; seen live on 2026-10-19, when the stricter pattern let the whole tag through to the user).
const KEY = String.raw`(?:src\s*:\s*)?[A-Za-z_]+`;
const TAG = new RegExp(String.raw`^\[\s*src\s*:\s*([A-Za-z_]+(?:\s*[,;]\s*${KEY})*)\s*\]$`, 'i');
const FIELDS = new Map<string, string>(Object.entries(CITATION_FIELDS).map(([k, v]) => [k.toLowerCase(), v]));

export interface Citation { leadId: string; field: string; leadName?: string }

export interface CitationSink {
  text(text: string): void;
  citation(c: Citation): void;
}

export class CitationExtractor {
  readonly #lead: LeadAiContext | null;
  readonly #sink: CitationSink;
  readonly #seen = new Set<string>();
  #tag: string | null = null;
  #heldSpace = false;
  #heldPunct = '';
  #afterTag = false;

  constructor(leadContext: LeadAiContext | null, sink: CitationSink) {
    this.#lead = leadContext;
    this.#sink = sink;
  }

  push(chunk: string): void {
    let out = '';
    let work = chunk;
    const punct = () => {
      const p = this.#heldPunct;
      this.#heldPunct = '';
      return p;
    };
    while (work.length) {
      const ch = work[0]!;
      work = work.slice(1);
      if (this.#tag !== null) {
        this.#tag += ch;
        if (ch === ']') {
          const m = TAG.exec(this.#tag);
          if (m) {
            this.#cite(m[1]!);
            this.#tag = null;
            this.#heldSpace = false;
            this.#afterTag = true;
            continue;
          }
        }
        if (ch === ']' || ch === '\n' || this.#tag.length >= MAX_TAG) {
          // Not a tag: emit the "[" and re-read the rest (it may hold the start of a real tag).
          out += punct();
          if (this.#heldSpace) out += ' ';
          this.#heldSpace = false;
          out += '[';
          work = this.#tag.slice(1) + work;
          this.#tag = null;
        }
        continue;
      }
      if (ch === '[') {
        this.#tag = '[';
      } else if (ch === ' ') {
        if (this.#heldSpace) out += `${punct()} `;
        this.#heldSpace = true;
      } else {
        // A dropped tag between a held "," and more punctuation: the held mark goes.
        if (this.#heldPunct && this.#afterTag && /[.!?,;:]/.test(ch)) this.#heldPunct = '';
        out += punct();
        if (this.#heldSpace) out += ' ';
        this.#heldSpace = false;
        this.#afterTag = false;
        if (ch === ',' || ch === ';' || ch === ':') this.#heldPunct = ch;
        else out += ch;
      }
    }
    if (out) this.#sink.text(out);
  }

  /** End of the stream: whatever is held back is plain text. */
  flush(): void {
    let out = this.#heldPunct + (this.#heldSpace ? ' ' : '');
    if (this.#tag !== null) out += this.#tag;
    this.#tag = null;
    this.#heldSpace = false;
    this.#heldPunct = '';
    this.#afterTag = false;
    if (out) this.#sink.text(out);
  }

  #cite(keys: string): void {
    if (!this.#lead) return;
    for (const key of keys.split(/[,;]/).map((k) => k.trim().replace(/^src\s*:\s*/i, '').toLowerCase())) {
      const field = FIELDS.get(key);
      if (!field || this.#seen.has(field)) continue;
      this.#seen.add(field);
      this.#sink.citation({ leadId: this.#lead.id, field, leadName: this.#lead.businessName });
    }
  }
}
