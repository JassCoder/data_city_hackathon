import { Injectable, signal } from '@angular/core';

/** Map layers the user can show or hide (display only, never routing). */
export type LayerKey =
  | 'zones'
  | 'extent'
  | 'buildings'
  | 'tallBuildings'
  | 'city'
  | 'districts'
  | 'river'
  | 'parks'
  | 'stations';

export const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  zones: true,
  extent: true,
  buildings: true,
  tallBuildings: true,
  city: true,
  districts: true,
  river: true,
  parks: true,
  stations: true,
};

/** Which overlay panel is open; on small maps only one at a time. */
export type MapPanel = 'layers' | 'legend' | null;

@Injectable({ providedIn: 'root' })
export class MapLayersService {
  readonly visible = signal<Record<LayerKey, boolean>>({ ...DEFAULT_LAYERS });
  readonly layersOpen = signal(false);
  readonly legendOpen = signal(false);

  setVisible(key: LayerKey, on: boolean): void {
    this.visible.update((v) => ({ ...v, [key]: on }));
  }

  /** Opens/closes a panel. `exclusive` (small screens) closes the other one. */
  toggle(panel: Exclude<MapPanel, null>, exclusive: boolean): void {
    const [mine, other] = panel === 'layers' ? [this.layersOpen, this.legendOpen] : [this.legendOpen, this.layersOpen];
    const open = !mine();
    mine.set(open);
    if (open && exclusive) other.set(false);
  }
}
