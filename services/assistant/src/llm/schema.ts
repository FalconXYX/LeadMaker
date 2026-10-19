// JSON schema (draft 2020-12, as zod's toJSONSchema writes it) -> what each provider's tool `parameters` accept.
// Gemini takes an OpenAPI 3.0 subset: upper-case types, `nullable` instead of type unions, no
// additionalProperties/$schema/default, and only some formats. Port of leadmaker/llm/providers/gemini.py
// to_gemini_schema, plus the anyOf collapsing below (Gemini function declarations handle unions poorly).
import type { ProviderName } from './types.ts';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const SCALARS = new Set(['string', 'number', 'integer', 'boolean']);
const KEEP_FORMATS = new Set(['date-time', 'enum']);
const COPY_KEYS = ['description', 'title', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern'] as const;

function typeOf(s: Json): { type: string | null; nullable: boolean } {
  const t = s.type;
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null');
    return { type: (nonNull[0] as string | undefined) ?? 'string', nullable: nonNull.length < t.length };
  }
  return { type: typeof t === 'string' ? t : null, nullable: false };
}

function joinDescriptions(...parts: (unknown)[]): string | undefined {
  const out = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim());
  return out.length ? [...new Set(out)].join(' ') : undefined;
}

function list(words: string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

export function toGeminiSchema(schema: Json): Json {
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isObj) : null;
  if (variants && schema.type === undefined) {
    const nonNull = variants.filter((v) => v.type !== 'null');
    const nullable = nonNull.length < variants.length;
    let out: Json;
    if (nonNull.length === 1) {
      out = toGeminiSchema({ ...nonNull[0], description: joinDescriptions(schema.description, nonNull[0]!.description) });
    } else if (nonNull.length && nonNull.every((v) => v.type === 'string')) {
      // e.g. an ISO date or date-time: one STRING; the variants' patterns differ, so they are dropped.
      const formats = nonNull.map((v) => v.format).filter((f): f is string => typeof f === 'string');
      out = { type: 'STRING' };
      const description = joinDescriptions(
        schema.description, ...nonNull.map((v) => v.description), formats.length ? `Format: ${list(formats)}.` : undefined);
      if (description) out.description = description;
    } else if (nonNull.length && nonNull.every((v) => SCALARS.has(String(v.type)))) {
      const types = [...new Set(nonNull.map((v) => String(v.type === 'integer' ? 'number' : v.type)))];
      out = { type: 'STRING' };
      out.description = joinDescriptions(schema.description, ...nonNull.map((v) => v.description), `${list(types)}.`)!;
    } else {
      out = { anyOf: nonNull.map(toGeminiSchema) };
      const description = joinDescriptions(schema.description);
      if (description) out.description = description;
    }
    if (nullable) out.nullable = true;
    return out;
  }

  const out: Json = {};
  const { type, nullable } = typeOf(schema);
  if (type) out.type = type.toUpperCase();
  for (const k of COPY_KEYS) if (schema[k] !== undefined) out[k] = schema[k];
  if (typeof schema.format === 'string' && KEEP_FORMATS.has(schema.format)) out.format = schema.format;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.filter((v) => v !== null).map(String);
  else if (schema.const !== undefined && schema.const !== null) out.enum = [String(schema.const)];
  if (out.enum && !out.type) out.type = 'STRING';
  if (nullable || schema.nullable === true) out.nullable = true;
  if (isObj(schema.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).filter(([, v]) => isObj(v)).map(([k, v]) => [k, toGeminiSchema(v as Json)]));
    out.propertyOrdering = Object.keys(out.properties as Json);
    if (Array.isArray(schema.required) && schema.required.length) out.required = [...schema.required];
    if (!out.type) out.type = 'OBJECT';
  }
  if (isObj(schema.items)) out.items = toGeminiSchema(schema.items);
  return out;
}

/** Deep copy without the keys no provider wants in a tool's input schema. */
function stripMeta(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripMeta);
  if (!isObj(schema)) return schema;
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === '$id') continue;
    out[k] = isObj(v) || Array.isArray(v) ? stripMeta(v) : v;
  }
  return out;
}

export function toJsonSchemaForProvider(schema: Json, provider: ProviderName): Json {
  return provider === 'gemini' ? toGeminiSchema(schema) : (stripMeta(schema) as Json);
}
