import type { FitBoundsOptions, LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import type { ReactNode } from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';
import { TILE_ATTRIBUTION, TILE_URL } from '@/lib/config';
import { cn } from '@/lib/cn';

const DEFAULT_CENTER: LatLngExpression = [40.7, -73.95];
const DEFAULT_ZOOM = 10;

export interface BaseMapProps {
  center?: LatLngExpression;
  zoom?: number;
  /** Initial view: fits these bounds when the map is created (wins over the default center/zoom). */
  bounds?: LatLngBoundsExpression;
  boundsOptions?: FitBoundsOptions;
  children?: ReactNode;
  className?: string;
  /** Accessible description of what the map shows. */
  label: string;
}

/** MapContainer + the configured tile layer (VITE_TILE_URL). Use CircleMarker for leads (no icon assets). */
export function BaseMap({ center, zoom, bounds, boundsOptions, children, className, label }: BaseMapProps) {
  // react-leaflet ignores `bounds` whenever both center and zoom are set, so the defaults apply only without bounds.
  const useBounds = bounds != null && center == null;
  return (
    <div role="region" aria-label={label} className={cn('lm-map overflow-hidden rounded-xl border border-border', className)}>
      <MapContainer
        center={useBounds ? undefined : center ?? DEFAULT_CENTER}
        zoom={useBounds ? undefined : zoom ?? DEFAULT_ZOOM}
        bounds={useBounds ? bounds : undefined}
        boundsOptions={useBounds ? boundsOptions : undefined}
        scrollWheelZoom={false}
        className="h-full w-full"
      >
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
        {children}
      </MapContainer>
    </div>
  );
}
