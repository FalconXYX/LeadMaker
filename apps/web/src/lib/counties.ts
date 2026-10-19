// County FIPS -> display names. GET /api/signals names the counties it covers ("Bergen County, NJ"); those
// names are registered here as they arrive and win. The table below is the fallback for the distributor's
// NJ / NYC metro territory, and the only source of the borough names reps know NYC counties by.

interface County {
  /** "Kings" */
  name: string;
  /** "Kings County" */
  full: string;
  state: string | null;
  /** NYC borough: "Brooklyn". */
  borough?: string;
}

const STATES: Record<string, string> = { '09': 'CT', '34': 'NJ', '36': 'NY', '42': 'PA' };

const NAMES: Record<string, string> = {
  // Connecticut
  '09001': 'Fairfield', '09005': 'Litchfield', '09009': 'New Haven',
  // New Jersey
  '34001': 'Atlantic', '34003': 'Bergen', '34005': 'Burlington', '34007': 'Camden', '34009': 'Cape May',
  '34011': 'Cumberland', '34013': 'Essex', '34015': 'Gloucester', '34017': 'Hudson', '34019': 'Hunterdon',
  '34021': 'Mercer', '34023': 'Middlesex', '34025': 'Monmouth', '34027': 'Morris', '34029': 'Ocean',
  '34031': 'Passaic', '34033': 'Salem', '34035': 'Somerset', '34037': 'Sussex', '34039': 'Union', '34041': 'Warren',
  // New York: the five boroughs, Long Island, the Hudson Valley
  '36005': 'Bronx', '36027': 'Dutchess', '36047': 'Kings', '36059': 'Nassau', '36061': 'New York',
  '36071': 'Orange', '36079': 'Putnam', '36081': 'Queens', '36085': 'Richmond', '36087': 'Rockland',
  '36103': 'Suffolk', '36105': 'Sullivan', '36111': 'Ulster', '36119': 'Westchester',
  // Pennsylvania
  '42017': 'Bucks', '42095': 'Northampton', '42101': 'Philadelphia', '42103': 'Pike',
};

/** NYC counties, which reps know by borough. */
const BOROUGHS: Record<string, string> = {
  '36005': 'The Bronx', '36047': 'Brooklyn', '36061': 'Manhattan', '36081': 'Queens', '36085': 'Staten Island',
};

const fromServer = new Map<string, Omit<County, 'borough'>>();

/** Splits a Census name with its state: "Bergen County, NJ" -> Bergen / Bergen County / NJ. */
export function parseCountyName(label: string): Omit<County, 'borough'> | null {
  const m = /^\s*(.+?)(?:,\s*([A-Z]{2}))?\s*$/.exec(label);
  if (!m || !m[1]) return null;
  const full = m[1].trim();
  const name = full.replace(/\s+(County|Parish|Borough|Census Area|Municipality|city)$/i, '').trim() || full;
  return { name, full, state: m[2] ?? null };
}

/** Takes the county names a signals response carries (later responses win). */
export function registerCountyNames(counties: readonly { countyFips: string; name?: string | null }[] | undefined): void {
  for (const c of counties ?? []) {
    if (!c?.countyFips || typeof c.name !== 'string' || !c.name.trim()) continue;
    const parsed = parseCountyName(c.name);
    if (parsed) fromServer.set(c.countyFips, { ...parsed, state: parsed.state ?? STATES[c.countyFips.slice(0, 2)] ?? null });
  }
}

/** Test hook: forget the registered names. */
export function resetCountyNames(): void {
  fromServer.clear();
}

function lookup(fips: string): County | null {
  const borough = BOROUGHS[fips];
  const server = fromServer.get(fips);
  if (server) return { ...server, borough };
  const name = NAMES[fips];
  if (!name) return null;
  return { name, full: `${name} County`, state: STATES[fips.slice(0, 2)] ?? null, borough };
}

const sameName = (a: string, b: string) => a.replace(/^the /i, '').toLowerCase() === b.replace(/^the /i, '').toLowerCase();

/** "Kings County, NY" (state: false -> "Kings County"); unknown codes read "County 36047". */
export function countyName(fips: string | null | undefined, opts: { state?: boolean } = {}): string {
  if (!fips) return 'Unknown county';
  const c = lookup(fips);
  if (!c) return `County ${fips}`;
  return `${c.full}${opts.state !== false && c.state ? `, ${c.state}` : ''}`;
}

/** With the borough when it differs: "Kings County, NY (Brooklyn)", "Bergen County, NJ". */
export function countyFullName(fips: string | null | undefined): string {
  const base = countyName(fips);
  const c = fips ? lookup(fips) : null;
  return c?.borough && !sameName(c.borough, c.name) ? `${base} (${c.borough.replace(/^The /, '')})` : base;
}

/** Short chip label: "Kings (Brooklyn)", "Bronx", "Bergen"; unknown codes show the code. */
export function countyShort(fips: string | null | undefined): string {
  if (!fips) return 'Unknown';
  const c = lookup(fips);
  if (!c) return fips;
  return c.borough && !sameName(c.borough, c.name) ? `${c.name} (${c.borough.replace(/^The /, '')})` : c.name;
}

/** How reps say it: "Brooklyn", "The Bronx", "Bergen County" (state: true -> "Brooklyn, NY"). */
export function countyPlace(fips: string | null | undefined, opts: { state?: boolean } = {}): string {
  if (!fips) return 'Unknown county';
  const c = lookup(fips);
  if (!c) return `County ${fips}`;
  const place = c.borough ?? c.full;
  return opts.state && c.state ? `${place}, ${c.state}` : place;
}

/** Compact table cell: "Brooklyn", "Bergen"; unknown codes show the code, none a dash. */
export function countyPlaceShort(fips: string | null | undefined): string {
  if (!fips) return '—';
  const c = lookup(fips);
  if (!c) return fips;
  return c.borough ?? c.name;
}

/** Replaces "county 36047" in server-written text with the county's name. */
export function humanizeCountyRefs(text: string): string {
  return text.replace(/\bcounty (\d{5})\b/gi, (_m, fips: string) => countyPlace(fips));
}
