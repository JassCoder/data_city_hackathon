import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AirspaceService, SOURCE_LABEL } from '../core/airspace';
import { MapDataService } from '../core/map-data';
import { MapLayerStore } from '../core/map-layers';
import { PlannerStore } from '../core/planner.store';
import { FLEET_COLORS } from './fleet-layers';
import { COLORS, INFO_BLUE, ZONE_COLORS } from './map';

/** Bottom "Airspace Legend" button with a compact popover. Display only. */
@Component({
  selector: 'app-airspace-legend',
  imports: [DatePipe, MatButtonModule, MatIconModule],
  template: `
    <section
      id="airspace-legend"
      class="map-panel legend-panel"
      data-testid="airspace-legend"
      role="region"
      aria-label="Airspace legend"
      [hidden]="!open()"
      (keydown.escape)="layers.openPanel.set(null)"
    >
      <h3>Airspace (for the planned flight)</h3>
      <ul class="legend-rows">
        <li><span class="sw" [style.background]="colors.RED"></span><b>RED</b> – Prohibited (DRA-P) or restricted (DRA-R/RH/RM/RL, no authorization): blocked for the planned flight.</li>
        <li><span class="sw" [style.background]="colors.ORANGE"></span><b>ORANGE</b> – U-space services required (blocked here), or restricted with a recorded authorization.</li>
        <li><span class="sw" [style.background]="colors.YELLOW"></span><b>YELLOW</b> – Technical or additional operating conditions.</li>
        <li><span class="sw" [style.background]="info"></span><b>BLUE</b> – Informational only (not an obstacle).</li>
        <li><span class="sw" [style.background]="colors.GRAY"></span><b>GRAY</b> – Unknown or insufficient verification (treated as blocked).</li>
        <li><span class="sw" [style.background]="colors.RED"></span><b>RED</b> also marks <b>planning constraints</b>: OSM-mapped airport grounds, military areas and government buildings that SkyRoute avoids by policy (not official no-fly zones).</li>
        <li><span class="sw outline"></span>Red outline: routing obstacle · <span class="sw dashed"></span>dashed: not active now</li>
      </ul>
      <dl class="facts" data-testid="legend-facts">
        <dt>Flight altitude</dt><dd data-testid="legend-altitude">{{ store.altitudeValid() ? store.altitude() + ' m AGL' : '—' }}</dd>
        <dt>Evaluated for</dt>
        <dd data-testid="legend-time">{{ evaluatedAt() ? (evaluatedAt() | date: 'yyyy-MM-dd HH:mm') : 'now' }}</dd>
        <dt>Data provider</dt><dd data-testid="legend-source">{{ provider() }}</dd>
        <dt>Data freshness</dt><dd data-testid="legend-freshness">{{ freshness() }}</dd>
        <dt>Zone margin</dt>
        <dd data-testid="legend-margin">{{ margin() === null ? '—' : margin() + ' m around blocked zones (modelling assumption, configurable)' }}</dd>
        <dt>Verification</dt><dd data-testid="legend-verification">{{ verification() }}</dd>
      </dl>
      <details>
        <summary>Other map symbols</summary>
        <ul class="legend-rows">
          <li><span class="sw" [style.background]="mapColors.routeNormal"></span>Route (Normal) ·
            <span class="sw" [style.background]="mapColors.routeEmergency"></span>Emergency · <span class="sw dashed"></span>outdated</li>
          <li><span class="sw" [style.background]="fleet.delivery"></span>Delivery route</li>
          <li><span class="sw" [style.background]="mapColors.river"></span>River · <span class="sw" [style.background]="mapColors.park"></span>Parks / green</li>
          <li><span class="sw" [style.background]="mapColors.tallBuilding"></span>Building ≥ 50 m (mapped height)</li>
          <li><span class="sw" [style.background]="'#c62828'"></span>Hospital (OSM; station simulated) ·
            <span class="sw" [style.background]="fleet.depot"></span>Depot (simulated)</li>
        </ul>
      </details>
      <p class="hint">Avoiding the loaded zones does not confirm real-world flight legality.</p>
    </section>
    <button
      mat-flat-button
      class="map-fab"
      data-testid="legend-toggle"
      aria-controls="airspace-legend"
      [attr.aria-expanded]="open()"
      (click)="layers.openPanel.set(open() ? null : 'legend')"
    >
      <mat-icon>policy</mat-icon> Airspace Legend
    </button>
  `,
  styleUrl: './map-overlays.scss',
})
export class AirspaceLegendComponent {
  protected readonly airspace = inject(AirspaceService);
  protected readonly store = inject(PlannerStore);
  protected readonly layers = inject(MapLayerStore);
  /** One floating panel at a time: the legend shares the right edge with Layers and Route Details. */
  protected readonly open = computed(() => this.layers.openPanel() === 'legend');
  private readonly mapData = inject(MapDataService);
  protected readonly margin = computed(() => this.mapData.coverageData()?.routing.airspaceSafetyMarginM ?? null);
  protected readonly colors = ZONE_COLORS;
  protected readonly info = INFO_BLUE;
  protected readonly mapColors = COLORS;
  protected readonly fleet = FLEET_COLORS;

  /** The route's calculation time when one exists, else the zone evaluation time. */
  protected readonly evaluatedAt = computed(() => {
    const r = this.store.route();
    const routeTime = r.phase === 'ready' || r.phase === 'stale' ? r.response.calculatedAt : null;
    return routeTime ?? this.airspace.evaluatedFor()?.at ?? null;
  });
  protected readonly provider = computed(() => {
    const src = this.airspace.source();
    return src ? `${SOURCE_LABEL[src.sourceType]} – ${src.label}` : 'Airspace data not loaded';
  });
  protected readonly freshness = computed(() => {
    const f = this.airspace.freshness();
    if (!f) return 'unknown';
    if (f.ageDays === null) return 'source date unknown';
    return `${f.ageDays} day${f.ageDays === 1 ? '' : 's'} old${f.stale ? ' – may be outdated' : ''}`;
  });
  protected readonly verification = computed(
    () => this.airspace.airspaceStatus()?.message ?? 'Unverified: no official airspace verification available.',
  );
}
