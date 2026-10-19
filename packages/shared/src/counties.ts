// County FIPS -> Census name with the state, for the counties of data/county-names.tsv (as zcta-centroids.tsv).
import { readFileSync } from 'node:fs';

let names: Map<string, string> | undefined;

/** "Bergen County, NJ"; null for a county outside the shipped table. */
export function countyName(fips: string | null | undefined): string | null {
  if (!fips) return null;
  if (!names) {
    names = new Map();
    for (const line of readFileSync(new URL('../data/county-names.tsv', import.meta.url), 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [code, name] = line.split('\t');
      names.set(code, name);
    }
  }
  return names.get(fips) ?? null;
}
