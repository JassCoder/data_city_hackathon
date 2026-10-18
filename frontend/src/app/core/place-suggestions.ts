import { Injectable, computed, inject, signal } from '@angular/core';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { containsPoint } from './geo';
import { LayersService } from './layers';
import { MapDataService } from './map-data';
import { Coordinate, SelectedLocation } from './models';
import { SETTINGS } from './settings';

/**
 * Instant suggestions while typing come only from local data (landing stations,
 * the 18 districts, places picked before in this browser) plus typed coordinates.
 * Address search goes to the backend (Nominatim) only on explicit submit: the
 * public Nominatim policy forbids autocomplete.
 */

export type SuggestionKind = 'coordinates' | 'recent' | 'station' | 'district';

export interface Suggestion {
  kind: SuggestionKind;
  label: string;
  detail: string;
  coordinate: Coordinate;
}

const RECENT_KEY = 'skyroute.recentPlaces.v1';

/** "52.2297, 21.0122" / "52.2297 21.0122" / "52,2297; 21,0122" → coordinate (lat, lon order). */
export function parseCoordinates(text: string): Coordinate | null {
  const m = text
    .trim()
    .match(/^(-?\d{1,2}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.'));
  const lon = Number(m[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latitude: lat, longitude: lon };
}

/** Case- and diacritic-insensitive text for matching ("Śródmieście" ~ "srodmiescie"). */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase();
}

/** Ranked local matches: word-start matches first, then contains. */
export function matchSuggestions(query: string, pool: Suggestion[], limit = 6): Suggestion[] {
  const q = fold(query.trim());
  if (!q) return pool.filter((s) => s.kind === 'recent').slice(0, limit);
  const scored: [number, Suggestion][] = [];
  for (const s of pool) {
    const label = fold(s.label);
    const idx = label.indexOf(q);
    if (idx < 0) continue;
    const wordStart = idx === 0 || /[\s\-(/]/.test(label[idx - 1]);
    const kindRank = { recent: 0, station: 1, district: 2, coordinates: 3 }[s.kind];
    scored.push([(wordStart ? 0 : 10) + kindRank, s]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, s]) => s).slice(0, limit);
}

/** A point inside the polygon for labelling (area centroid of the outer ring, else a vertex average). */
export function labelPoint(geom: Polygon | MultiPolygon): Coordinate | null {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const ring = polys.map((p) => p[0]).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))[0];
  if (!ring?.length) return null;
  const a = area(ring);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  const centroid = a ? { longitude: cx / (6 * a), latitude: cy / (6 * a) } : null;
  if (centroid && containsPoint(geom, centroid)) return centroid;
  const avg = ring.reduce((s, [x, y]) => ({ longitude: s.longitude + x / ring.length, latitude: s.latitude + y / ring.length }), {
    longitude: 0,
    latitude: 0,
  });
  return containsPoint(geom, avg) ? avg : null;
}

function area(ring: Position[]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
}

@Injectable({ providedIn: 'root' })
export class PlaceSuggestions {
  private readonly layers = inject(LayersService);
  private readonly mapData = inject(MapDataService);
  readonly recent = signal<Suggestion[]>(this.loadRecent());

  private readonly stations = computed<Suggestion[]>(() =>
    (this.layers.data()?.stations.features ?? []).map((f) => ({
      kind: 'station',
      label: f.properties.name,
      detail: 'Landing station (demo)',
      coordinate: { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] },
    })),
  );

  private readonly districts = computed<Suggestion[]>(() =>
    (this.mapData.boundaryData()?.districts.features ?? []).flatMap((f) => {
      const c = labelPoint(f.geometry);
      return c ? [{ kind: 'district' as const, label: f.properties.name, detail: 'District centre', coordinate: c }] : [];
    }),
  );

  /** Suggestions for the current text: typed coordinates first, then local places. */
  suggest(query: string): Suggestion[] {
    const coord = parseCoordinates(query);
    const typed: Suggestion[] = coord
      ? [{ kind: 'coordinates', label: `${coord.latitude.toFixed(5)}, ${coord.longitude.toFixed(5)}`, detail: 'Use these coordinates', coordinate: coord }]
      : [];
    return [...typed, ...matchSuggestions(query, [...this.recent(), ...this.stations(), ...this.districts()])];
  }

  /** Remembers a chosen place (this browser only). */
  remember(loc: SelectedLocation): void {
    if (loc.source === 'MAP_CLICK' || loc.source === 'MAP_DRAG') return;
    const entry: Suggestion = { kind: 'recent', label: loc.label, detail: 'Recently used', coordinate: loc.coordinate };
    const list = [entry, ...this.recent().filter((r) => r.label !== loc.label)].slice(0, SETTINGS.maxRecentPlaces);
    this.recent.set(list);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: suggestions just are not remembered */
    }
  }

  private loadRecent(): Suggestion[] {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter((s) => s?.coordinate && s.label) : [];
    } catch {
      return [];
    }
  }
}
