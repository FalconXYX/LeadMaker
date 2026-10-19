// Regenerates evals/schema/cases.schema.json from the zod case schemas: node evals/lib/export-schema.ts
import { writeFileSync } from 'node:fs';
import { CASES_SCHEMA_PATH, casesJsonSchema } from './cases.ts';

writeFileSync(CASES_SCHEMA_PATH, `${JSON.stringify(casesJsonSchema(), null, 2)}\n`);
console.log(`wrote ${CASES_SCHEMA_PATH}`);
