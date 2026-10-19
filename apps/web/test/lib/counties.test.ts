import { afterEach, describe, expect, it } from 'vitest';
import {
  countyFullName, countyName, countyPlace, countyPlaceShort, countyShort, humanizeCountyRefs, parseCountyName,
  registerCountyNames, resetCountyNames,
} from '@/lib/counties';

afterEach(() => resetCountyNames());

describe('county names', () => {
  it('names counties from the fallback table', () => {
    expect(countyName('36047')).toBe('Kings County, NY');
    expect(countyName('34003', { state: false })).toBe('Bergen County');
    expect(countyFullName('36047')).toBe('Kings County, NY (Brooklyn)');
    expect(countyFullName('36005')).toBe('Bronx County, NY');
    expect(countyFullName('34003')).toBe('Bergen County, NJ');
    expect(countyShort('36047')).toBe('Kings (Brooklyn)');
    expect(countyShort('36005')).toBe('Bronx');
    expect(countyPlace('36047')).toBe('Brooklyn');
    expect(countyPlace('34003')).toBe('Bergen County');
    expect(countyPlace('36047', { state: true })).toBe('Brooklyn, NY');
    expect(countyPlaceShort('34003')).toBe('Bergen');
    expect(humanizeCountyRefs('works 3 leads in county 34003')).toBe('works 3 leads in Bergen County');
  });

  it('falls back to the code for unknown counties', () => {
    expect(countyName('99999')).toBe('County 99999');
    expect(countyFullName('99999')).toBe('County 99999');
    expect(countyPlace('99999')).toBe('County 99999');
    expect(countyShort('99999')).toBe('99999');
    expect(countyPlaceShort(null)).toBe('—');
    expect(countyName(null)).toBe('Unknown county');
  });

  it('prefers the names the signals API sends', () => {
    expect(parseCountyName('Bergen County, NJ')).toEqual({ name: 'Bergen', full: 'Bergen County', state: 'NJ' });
    registerCountyNames([
      { countyFips: '51760', name: 'Richmond city, VA' },
      { countyFips: '36047', name: 'Kings County, NY' },
      { countyFips: '34003', name: null },
    ]);
    expect(countyName('51760')).toBe('Richmond city, VA');
    expect(countyShort('51760')).toBe('Richmond');
    expect(countyFullName('36047')).toBe('Kings County, NY (Brooklyn)');
    expect(countyName('34003')).toBe('Bergen County, NJ');
  });
});
