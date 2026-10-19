// Writes schema/lead-filter.schema.json (the list API's LeadFilter, read by the Python pipeline) and
// schema/lead-filter.tool.schema.json (the AI filter tool's parameters: LeadFilterTool).
import { writeFileSync } from 'node:fs';
import { leadFilterJsonSchema, leadFilterToolJsonSchema } from '../src/filter.ts';

for (const [file, schema] of [
  ['lead-filter.schema.json', leadFilterJsonSchema()],
  ['lead-filter.tool.schema.json', leadFilterToolJsonSchema()],
] as const) {
  const out = new URL(`../schema/${file}`, import.meta.url);
  writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${out.pathname}`);
}
