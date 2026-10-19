// Loaded lazily (Leaflet is heavy and needs a real DOM).
import { CircleMarker, Tooltip } from 'react-leaflet';
import { BaseMap } from '@/components/map/BaseMap';

function cssVar(name: string): string {
  if (typeof window === 'undefined') return 'currentColor';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'currentColor';
}

export default function LocationMap({ lat, lng, name }: { lat: number; lng: number; name: string }) {
  // SVG attributes cannot read CSS variables, so resolve the theme colours once.
  const accent = cssVar('--c-accent');
  const ring = cssVar('--c-surface');
  return (
    <BaseMap center={[lat, lng]} zoom={13} label={`Map showing the location of ${name}`} className="h-full rounded-none border-0">
      <CircleMarker center={[lat, lng]} radius={14} pathOptions={{ stroke: false, fillColor: accent, fillOpacity: 0.18 }} />
      <CircleMarker center={[lat, lng]} radius={7} pathOptions={{ color: ring, weight: 2.5, fillColor: accent, fillOpacity: 1 }}>
        <Tooltip direction="top" offset={[0, -8]}>{name}</Tooltip>
      </CircleMarker>
    </BaseMap>
  );
}
