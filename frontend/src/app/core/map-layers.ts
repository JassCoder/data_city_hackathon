import { Injectable, effect, signal } from '@angular/core';

/**
 * Central map-layer visibility (the Layers panel). Visibility is display only:
 * hiding airspace zones never changes routing, which always uses every loaded zone.
 * DRA category sub-filters live in AirspaceService.filters (kept while the parent is hidden).
 */
export type LayerKey =
  | 'airspaceZones'
  | 'buildings'
  | 'hospitals'
  | 'depots'
  | 'partners'
  | 'allRestaurants'
  | 'pads'
  | 'drones'
  | 'deliveries'
  | 'boundary'
  | 'districts'
  | 'river'
  | 'parks'
  | 'tallBuildings'
  | 'legacyStations';

export interface LayerDef {
  key: LayerKey;
  label: string;
  /** Visible on first load (spec defaults). */
  defaultOn: boolean;
  hint?: string;
}

export const BUILDING_MIN_ZOOM = 15;

/** Exact labels and order of the Layers panel. */
export const LAYER_DEFS: LayerDef[] = [
  { key: 'airspaceZones', label: 'Airspace zones', defaultOn: true },
  { key: 'buildings', label: `All buildings (zoom ≥ ${BUILDING_MIN_ZOOM})`, defaultOn: false,
    hint: 'Loaded for the visible area only, from zoom 15.' },
  { key: 'hospitals', label: 'Hospitals (OSM; stations simulated)', defaultOn: false },
  { key: 'depots', label: 'Drone depots (simulated)', defaultOn: false },
  { key: 'partners', label: 'Subscribed restaurants (demo)', defaultOn: false },
  { key: 'allRestaurants', label: 'All restaurants (OSM)', defaultOn: false, hint: 'Loaded when switched on.' },
  { key: 'pads', label: 'Proposed pickup pads', defaultOn: false },
  { key: 'drones', label: 'Drones at facilities', defaultOn: false },
  { key: 'deliveries', label: 'Delivery routes', defaultOn: true },
  { key: 'boundary', label: 'Warsaw boundary (GUGiK PRG)', defaultOn: true },
  { key: 'districts', label: '18 districts', defaultOn: true },
  { key: 'river', label: 'River', defaultOn: true },
  { key: 'parks', label: 'Parks / green', defaultOn: true },
  { key: 'tallBuildings', label: 'Buildings ≥ 50 m', defaultOn: false, hint: 'Mapped heights only; unknown heights are not drawn as tall.' },
  { key: 'legacyStations', label: 'Sample landing stations (legacy)', defaultOn: false },
];

const STORAGE_KEY = 'skyroute.layers.v2'; // v2: new defaults (districts on, hospitals/depots off)

export function defaultVisibility(): Record<LayerKey, boolean> {
  return Object.fromEntries(LAYER_DEFS.map((d) => [d.key, d.defaultOn])) as Record<LayerKey, boolean>;
}

function restore(): Record<LayerKey, boolean> {
  const out = defaultVisibility();
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Record<LayerKey, boolean>> | null;
    for (const d of LAYER_DEFS) if (typeof saved?.[d.key] === 'boolean') out[d.key] = saved[d.key]!;
  } catch {
    // storage unavailable: defaults
  }
  return out;
}

@Injectable({ providedIn: 'root' })
export class MapLayerStore {
  /** Kept for the browser session (sessionStorage), defaults otherwise. */
  readonly visible = signal<Record<LayerKey, boolean>>(restore());
  /** Which floating map panel is open (one at a time, so the map stays visible). */
  readonly openPanel = signal<'layers' | 'route' | 'legend' | null>(null);

  constructor() {
    effect(() => {
      const v = this.visible();
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v));
      } catch {
        // ignore: session persistence is a convenience
      }
    });
  }

  isVisible(key: LayerKey): boolean {
    return this.visible()[key];
  }

  set(key: LayerKey, on: boolean): void {
    this.visible.update((v) => ({ ...v, [key]: on }));
  }

  reset(): void {
    this.visible.set(defaultVisibility());
  }
}
