// ZIP code -> centroid for LeadFilter.near: the shipped Census ZCTA points, else the mean location of the
// companies with that postal code that the viewer may see (so the answer reveals nothing about the others).
import { zctaCentroid, zipFallbackSql, type Point, type Viewer } from '@leadmaker/shared';
import { one, type Db } from './db.ts';

export async function zipCentroid(db: Db, zip: string, viewer?: Viewer): Promise<Point | undefined> {
  const known = zctaCentroid(zip);
  if (known) return known;
  const row = await one<{ lat: number | null; lng: number | null }>(db.replica, zipFallbackSql(zip, viewer));
  return row?.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : undefined;
}
