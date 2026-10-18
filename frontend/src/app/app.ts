import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { MapComponent } from './map/map';
import { LayersPanelComponent } from './map/layers-panel';
import { MapLegendComponent } from './map/map-legend';
import { MapLayersService } from './core/map-layers';
import { API_BASE_URL, Health, safeValue } from './core/api';
import { LayersService } from './core/layers';
import { PlannerStore } from './core/planner.store';
import { AirspaceService } from './core/airspace';
import { MapDataService } from './core/map-data';
import { AirspacePanelComponent } from './planner/airspace-panel';
import { PlannerPanelComponent } from './planner/planner-panel';
import { RouteResultsComponent } from './planner/route-results';
import { DemoBadgeComponent } from './ui/demo-badge';
import { IconComponent } from './ui/icon';

export type SheetState = 'peek' | 'half' | 'full';
const NEXT_SHEET: Record<SheetState, SheetState> = { peek: 'half', half: 'full', full: 'peek' };

@Component({
  imports: [
    MapComponent,
    LayersPanelComponent,
    MapLegendComponent,
    PlannerPanelComponent,
    RouteResultsComponent,
    AirspacePanelComponent,
    DemoBadgeComponent,
    IconComponent,
  ],
  selector: 'app-root',
  host: { '(document:keydown.escape)': 'cancelPick()' },
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly health = httpResource<Health>(() => `${API_BASE_URL}/health`);
  protected readonly layers = inject(LayersService);
  protected readonly planner = inject(PlannerStore);
  protected readonly airspace = inject(AirspaceService);
  protected readonly mapData = inject(MapDataService);
  protected readonly mapLayers = inject(MapLayersService);

  /** Pick mode banner (never drawn over the map: it is a strip above it). */
  protected readonly pickHint = computed(() => {
    const t = this.planner.pickTarget();
    return t ? `Click the map to set ${t === 'start' ? 'Point A (start)' : 'Point B (destination)'}.` : null;
  });
  protected readonly flightLabel = computed(() => `the planned flight at ${this.planner.altitude()} m AGL`);

  protected readonly healthInfo = computed(() => safeValue(this.health));

  protected readonly backendStatus = computed(() => {
    if (this.health.isLoading()) return 'connecting';
    if (this.health.error()) return 'offline';
    return this.healthInfo()?.status === 'ok' ? 'online' : 'offline';
  });
  protected readonly backendLabel = computed(
    () => ({ connecting: 'Connecting…', online: 'Backend online', offline: 'Backend offline' })[this.backendStatus()],
  );
  protected readonly backendTitle = computed(() => {
    const h = this.healthInfo();
    if (!h) return 'Routing backend';
    const risk = h.riskDataAvailable ? 'risk layers loaded' : 'risk layers not loaded (Safest unavailable)';
    return `Routing backend v${h.version}, ${risk}`;
  });

  /** Mobile bottom sheet position (desktop ignores it). */
  protected readonly sheet = signal<SheetState>('peek');
  protected readonly sheetLabel = computed(() =>
    this.sheet() === 'full' ? 'Collapse the drone list' : 'Expand the drone list',
  );

  /** The drawer opens when a route result arrives; closing it keeps it closed until the next result. */
  private readonly drawerDismissed = signal(false);
  private readonly hasResult = computed(() => {
    const r = this.planner.route();
    return r.phase === 'ready' || r.phase === 'stale' || r.phase === 'error' || (r.phase === 'loading' && !!r.previous);
  });
  protected readonly drawerOpen = computed(() => this.hasResult() && !this.drawerDismissed());

  constructor() {
    effect(() => {
      const r = this.planner.route();
      if (r.phase === 'ready' || r.phase === 'error') untracked(() => this.drawerDismissed.set(false));
    });
  }

  protected cancelPick(): void {
    if (this.planner.pickTarget()) this.planner.pickTarget.set(null);
  }

  protected cycleSheet(): void {
    this.sheet.update((s) => NEXT_SHEET[s]);
  }

  protected closeDrawer(): void {
    this.drawerDismissed.set(true);
  }

  protected retry(): void {
    this.health.reload();
    this.layers.resource.reload();
    this.airspace.resource.reload();
    this.mapData.boundary.reload();
    this.mapData.coverage.reload();
  }
}
