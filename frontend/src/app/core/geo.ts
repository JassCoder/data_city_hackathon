import type { MultiPolygon, Polygon, Position } from 'geojson';
import { Coordinate } from './models';

/** Ray casting on one ring ([lon, lat] positions). */
function inRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon: number, lat: number, rings: Position[][]): boolean {
  if (!rings.length || !inRing(lon, lat, rings[0])) return false;
  return !rings.slice(1).some((hole) => inRing(lon, lat, hole)); // holes exclude
}

/** Point-in-polygon for GeoJSON Polygon/MultiPolygon (not a bounding-box test). */
export function containsPoint(geom: Polygon | MultiPolygon | null | undefined, c: Coordinate): boolean {
  if (!geom) return false;
  const { longitude: lon, latitude: lat } = c;
  return geom.type === 'Polygon'
    ? inPolygon(lon, lat, geom.coordinates)
    : geom.coordinates.some((poly) => inPolygon(lon, lat, poly));
}
