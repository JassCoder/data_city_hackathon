import { Component, computed, effect, inject, untracked } from '@angular/core';
import { MapComponent } from './map/map';
import { LayersPanelComponent, isSmallScreen } from './map/layers-panel';
import { MapLegendComponent } from './map/map-legend';
import { MapLayersService } from './core/map-layers';
import { LayersService } from './core/layers';
import { AirspaceService } from './core/airspace';
import { MapDataService } from './core/map-data';
import { FleetStore } from './core/fleet.store';
import { HealthService } from './core/health';
import { DrawerTab, SheetState, UiState } from './core/ui-state';
import { DroneListComponent } from './fleet/drone-list';
import { RouteDetailsComponent } from './details/route-details';
import { AirspaceTabComponent } from './details/airspace-tab';
import { DemoBadgeComponent } from './ui/demo-badge';
import { IconComponent } from './ui/icon';

const NEXT_SHEET: Record<SheetState, SheetState> = { peek: 'half', half: 'full', full: 'peek' };

@Component({
  imports: [
    MapComponent,
    LayersPanelComponent,
    MapLegendComponent,
    DroneListComponent,
    RouteDetailsComponent,
    AirspaceTabComponent,
    DemoBadgeComponent,
    IconComponent,
  ],
  selector: 'app-root',
  host: { '(document:keydown.escape)': 'cancelPick()' },
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly health = inject(HealthService);
  protected readonly layers = inject(LayersService);
  protected readonly fleet = inject(FleetStore);
  protected readonly airspace = inject(AirspaceService);
  protected readonly mapData = inject(MapDataService);
  protected readonly mapLayers = inject(MapLayersService);
  protected readonly ui = inject(UiState);

  protected readonly backendLabel = computed(
    () => ({ connecting: 'Connecting…', online: 'Backend online', offline: 'Backend offline' })[this.health.status()],
  );
  protected readonly backendTitle = computed(() => {
    const h = this.health.info();
    if (!h) return 'Routing backend';
    const risk = h.riskDataAvailable ? 'risk layers loaded' : 'risk layers not loaded (Safest unavailable)';
    return `Routing backend v${h.version}, ${risk}`;
  });

  /** Pick mode banner (a strip above the map, never over it). */
  protected readonly pickHint = computed(() => {
    const t = this.fleet.pickTarget();
    if (!t) return null;
    const d = this.fleet.drones().find((x) => x.id === t.droneId);
    const point = t.role === 'start' ? 'Point A (start)' : 'Point B (destination)';
    return `Click the map to set ${point} of ${d?.name ?? 'the drone'}.`;
  });
  protected readonly flightLabel = computed(() => {
    const d = this.fleet.focusDrone();
    const alt = this.airspace.altitude();
    return d ? `${d.name} at ${alt} m AGL` : `a flight at ${alt} m AGL`;
  });
  protected readonly sheetLabel = computed(() =>
    this.ui.sheet() === 'full' ? 'Collapse the drone list' : 'Expand the drone list',
  );

  constructor() {
    this.restoreUrlState();
    // Desktop: the drawer opens when the selected drone gets a result.
    let lastPhase: string | undefined;
    effect(() => {
      const d = this.fleet.selected();
      const phase = d ? `${d.id}:${d.route.phase}` : undefined;
      if (phase === lastPhase) return;
      lastPhase = phase;
      if (d && (d.route.phase === 'ready' || d.route.phase === 'error') && !isSmallScreen()) {
        untracked(() => this.ui.drawerOpen.set(true));
      }
    });
    // Picking on mobile: lower the sheet so the map is visible.
    effect(() => {
      if (this.fleet.pickTarget() && isSmallScreen()) untracked(() => this.ui.sheet.set('peek'));
    });
    // Keep the selected drone and tab in the URL (reload/share keeps the view).
    effect(() => this.writeUrlState(this.fleet.selectedId(), this.ui.drawerOpen() ? this.ui.drawerTab() : null));
  }

  protected selectFromMap(id: string): void {
    this.fleet.select(id);
    if (!isSmallScreen()) this.ui.openDetails('route');
  }

  protected cancelPick(): void {
    if (this.fleet.pickTarget()) this.fleet.pickTarget.set(null);
  }

  protected cycleSheet(): void {
    this.ui.sheet.update((s) => NEXT_SHEET[s]);
  }

  protected closeDrawer(): void {
    this.ui.drawerOpen.set(false);
  }

  protected retry(): void {
    this.health.resource.reload();
    this.layers.resource.reload();
    this.airspace.resource.reload();
    this.mapData.boundary.reload();
    this.mapData.coverage.reload();
  }

  private restoreUrlState(): void {
    try {
      const params = new URLSearchParams(location.search);
      const id = params.get('drone');
      if (id && this.fleet.drones().some((d) => d.id === id)) this.fleet.select(id);
      const tab = params.get('tab') as DrawerTab | null;
      if (tab === 'route' || tab === 'airspace') this.ui.openDetails(tab);
    } catch {
      /* no URL state */
    }
  }

  private writeUrlState(droneId: string | null, tab: DrawerTab | null): void {
    try {
      const params = new URLSearchParams(location.search);
      droneId ? params.set('drone', droneId) : params.delete('drone');
      tab ? params.set('tab', tab) : params.delete('tab');
      const query = params.toString();
      history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    } catch {
      /* history unavailable (tests, sandboxed frames) */
    }
  }
}
