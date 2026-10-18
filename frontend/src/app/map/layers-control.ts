import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AirspaceService, CATEGORY_GROUPS, CategoryGroup } from '../core/airspace';
import { LayersService, TALL_BUILDING_M } from '../core/layers';
import { LAYER_DEFS, LayerKey, MapLayerStore } from '../core/map-layers';

/**
 * Top-right "Layers" button and panel. Checkboxes change the map display only:
 * routing keeps avoiding every applicable zone whatever is hidden here.
 */
@Component({
  selector: 'app-map-layers-control',
  imports: [MatButtonModule, MatIconModule],
  template: `
    <button
      mat-flat-button
      class="map-fab"
      data-testid="layers-toggle"
      aria-controls="layers-panel"
      [attr.aria-expanded]="open()"
      (click)="toggle()"
    >
      <mat-icon>layers</mat-icon> Layers
    </button>
    <section
      id="layers-panel"
      class="map-panel"
      data-testid="layers-panel"
      role="region"
      aria-label="Map layers"
      [hidden]="!open()"
      (keydown.escape)="close()"
    >
      <h3>Map layers</h3>
      <ul class="layer-list">
        @for (d of defs; track d.key) {
          <li>
            <label [attr.data-testid]="'layer-' + d.key">
              <input type="checkbox" [checked]="visible()[d.key]" (change)="setLayer(d.key, $event)" />
              <span>{{ d.label }}</span>
            </label>
            @if (d.hint) { <span class="hint">{{ d.hint }}</span> }
            @if (d.key === 'airspaceZones') {
              <ul class="sub" [class.muted]="!visible().airspaceZones" data-testid="airspace-categories">
                @for (g of groups; track g.key) {
                  <li>
                    <label [attr.data-testid]="'category-' + g.key">
                      <input type="checkbox" [checked]="airspace.filters()[g.key]" (change)="setCategory(g.key, $event)" />
                      <span>{{ g.label }} ({{ airspace.counts()[g.key] }})</span>
                    </label>
                  </li>
                }
                @if (coverageWarning(); as w) {
                  <li class="warn" role="note" data-testid="airspace-coverage-warning">{{ w }}</li>
                }
                <li class="hint">Hiding zones changes the map only; routes always avoid applicable blocked zones.</li>
              </ul>
            }
          </li>
        }
      </ul>
      @if (layers.summary(); as s) {
        <dl class="stats" data-testid="layer-summary">
          <dt>Coverage</dt><dd>Warsaw, 18 districts</dd>
          <dt>Buildings (OSM)</dt><dd>{{ s.buildings }}</dd>
          <dt>≥ {{ tallM }} m</dt><dd>{{ s.tallBuildings }}</dd>
          <dt>Height unknown</dt><dd>{{ s.unknownHeights }}</dd>
          <dt>Parks / green (OSM)</dt><dd>{{ s.parks }}</dd>
          <dt>Sample landing stations</dt><dd>{{ s.stations }}</dd>
        </dl>
      }
      <button mat-button type="button" data-testid="layers-reset" (click)="store.reset()">Reset to defaults</button>
    </section>
  `,
  styleUrl: './map-overlays.scss',
})
export class MapLayersControlComponent {
  protected readonly store = inject(MapLayerStore);
  protected readonly airspace = inject(AirspaceService);
  protected readonly layers = inject(LayersService);
  protected readonly defs = LAYER_DEFS;
  protected readonly groups = CATEGORY_GROUPS;
  protected readonly tallM = TALL_BUILDING_M;
  protected readonly visible = this.store.visible;
  protected readonly open = computed(() => this.store.openPanel() === 'layers');

  /** Zero loaded features is not proof that no restrictions exist. */
  protected readonly coverageWarning = computed(() => {
    const st = this.airspace.airspaceStatus();
    if (this.airspace.resource.error()) return 'Airspace data could not be loaded: counts are unavailable, not zero.';
    if (!st) return null;
    if (!st.officialDataAvailable) {
      return `${st.message} Counts show loaded features only; zero does not mean there are no restrictions.`;
    }
    return st.officialCoveragePct !== null && st.officialCoveragePct < 99.9
      ? `Official data covers ${st.officialCoveragePct}% of Warsaw; elsewhere zones are unknown.` : null;
  });

  protected toggle(): void {
    this.store.openPanel.set(this.open() ? null : 'layers');
  }

  protected close(): void {
    this.store.openPanel.set(null);
  }

  protected setLayer(key: LayerKey, event: Event): void {
    this.store.set(key, (event.target as HTMLInputElement).checked);
  }

  protected setCategory(group: CategoryGroup, event: Event): void {
    this.airspace.toggleFilter(group, (event.target as HTMLInputElement).checked);
  }
}
